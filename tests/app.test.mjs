import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';

const dataDir = await mkdtemp(join(tmpdir(), 'finalcog-test-'));
process.env.DATA_DIR = dataDir;
process.env.PORT = '5000';
process.env.HOST = '127.0.0.1';
process.env.APP_BASE_URL = 'http://localhost:5000';
process.env.TIKTOK_REDIRECT_URI = 'https://venloud.github.io/finalcog/tiktok-callback.html';
process.env.TIKTOK_CLIENT_KEY = 'test-public-client-key';
process.env.TIKTOK_CLIENT_SECRET = 'test-server-client-secret';
process.env.SESSION_SECRET = 'local-test-secret-with-more-than-thirty-two-characters';
process.env.FINALCOG_API_TOKEN = 'test-local-api-token-with-at-least-thirty-two-characters';
process.env.GITHUB_TOKEN = 'test-github-token';

const { createApplicationServer } = await import('../lib/application.mjs');
const { createScheduler } = await import('../lib/scheduler.mjs');
const {
  createPost,
  createSession,
  db,
  removePost,
  saveTikTokUser,
  updatePostStatus,
} = await import('../lib/database.mjs');
const {
  encryptToken,
  randomToken,
  sha256,
} = await import('../lib/security.mjs');
const { createAuthorizeUrl, exchangeAuthorizationCode, fetchUserProfile, initializeInboxUpload } =
  await import('../lib/tiktok.mjs');
const { generateSlots, validateSettings } = await import('../lib/schedule-utils.mjs');
const { draftCaptionsWithAnthropic, extractVideoFrames } = await import('../lib/captions.mjs');
const { createFinalCogMcpServer, MCP_TOOL_NAMES } = await import('../lib/mcp.mjs');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

function makeZip(entries) {
  const crc32 = data => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const item of entries) {
    const filename = Buffer.from(item.name);
    const content = Buffer.from(item.content);
    const compressed = deflateRawSync(content);
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralData = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralData, end]);
}

test('Final Cog local app, scheduler, and TikTok inbox flow', async t => {
  const originalFetch = globalThis.fetch;
  const server = createApplicationServer();
  let base;
  let user;
  let sessionCookie;
  let githubMedia;
  let pacingMediaId;

  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (db.open) db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  user = saveTikTokUser({
    open_id: 'test-open-id',
    display_name: 'Test Creator',
    username: 'testcreator',
    avatar_url: '',
  }, {
    accessTokenEncrypted: encryptToken('test-access-token'),
    refreshTokenEncrypted: encryptToken('test-refresh-token'),
    expiresIn: 3600,
    refreshExpiresIn: 86400,
    scopes: 'user.info.basic,video.upload',
  });
  const sessionToken = randomToken();
  createSession(user.id, sha256(sessionToken), Date.now() + 60_000);
  sessionCookie = `finalcog_session=${encodeURIComponent(sessionToken)}`;

  const call = (path, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (options.auth !== false) headers.set('Cookie', sessionCookie);
    if (options.apiToken !== false) headers.set('Authorization', `Bearer ${process.env.FINALCOG_API_TOKEN}`);
    if (options.origin !== false) headers.set('Origin', typeof options.origin === 'string' ? options.origin : base);
    let body = options.body;
    if (options.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.json);
    }
    return fetch(`${base}${path}`, {
      method: options.method || 'GET',
      headers,
      body,
      redirect: options.redirect || 'follow',
    });
  };

  await t.test('serves relative pages and protects private files', async () => {
    const home = await call('/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Keep the Momentum Going/);
    assert.equal((await call('/privacy.html')).status, 200);
    assert.equal((await call('/terms.html')).status, 200);
    assert.equal((await call('/tiktok-callback.html')).status, 200);
    assert.equal((await call('/assets/fonts.css')).status, 200);
    const localFont = await call('/assets/fonts/archivo-expanded-latin.woff2');
    assert.equal(localFont.status, 200);
    assert.equal(localFont.headers.get('content-type'), 'font/woff2');
    assert.equal((await call('/app', { redirect: 'manual' })).status, 302);
    assert.equal((await call('/app/')).status, 200);
    assert.equal((await call('/.env')).status, 404);
    assert.equal((await call('/data/finalcog.sqlite')).status, 404);
  });

  await t.test('uses the registered OAuth redirect and the required scopes', async () => {
    const authorizeUrl = new URL(createAuthorizeUrl('test-state'));
    assert.equal(authorizeUrl.origin, 'https://www.tiktok.com');
    assert.equal(authorizeUrl.searchParams.get('scope'), 'user.info.basic,video.upload');
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), process.env.TIKTOK_REDIRECT_URI);
    assert.equal(authorizeUrl.searchParams.get('client_key'), process.env.TIKTOK_CLIENT_KEY);
    assert.equal(authorizeUrl.searchParams.has('client_secret'), false);

    const tokenResult = await exchangeAuthorizationCode('one-time-code', async (url, options) => {
      assert.equal(url, 'https://open.tiktokapis.com/v2/oauth/token/');
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('client_secret'), process.env.TIKTOK_CLIENT_SECRET);
      assert.equal(form.get('redirect_uri'), process.env.TIKTOK_REDIRECT_URI);
      return jsonResponse({ data: {
        open_id: 'provider-open-id',
        access_token: 'provider-access-token',
        refresh_token: 'provider-refresh-token',
        expires_in: 3600,
        refresh_expires_in: 86400,
        scope: 'user.info.basic,video.upload',
      } });
    });
    assert.equal(tokenResult.openId, 'provider-open-id');

    const profile = await fetchUserProfile('provider-access-token', async (url, options) => {
      assert.match(url, /\/v2\/user\/info\/\?fields=open_id,display_name,avatar_url$/);
      assert.equal(options.headers.Authorization, 'Bearer provider-access-token');
      return jsonResponse({ data: { user: { open_id: 'provider-open-id', display_name: 'Creator' } } });
    });
    assert.equal(profile.display_name, 'Creator');
  });

  await t.test('creates a normal browser session and exposes agent config only on request', async () => {
    const unauthenticated = await fetch(`${base}/api/queue`);
    assert.equal(unauthenticated.status, 401);
    const unauthenticatedWrite = await call('/api/settings', {
      method: 'PUT', auth: false, apiToken: false, json: {},
    });
    assert.equal(unauthenticatedWrite.status, 401);
    const browserSession = await call('/api/session', { auth: false, apiToken: false });
    assert.equal(browserSession.status, 200);
    assert.equal((await browserSession.json()).authenticated, true);
    const localCookie = browserSession.headers.get('set-cookie');
    assert.match(localCookie, /^finalcog_session=/);
    assert.match(localCookie, /HttpOnly/);
    assert.match(localCookie, /SameSite=Strict/);
    const localAccess = await fetch(`${base}/api/accounts`, { headers: { Cookie: localCookie.split(';')[0] } });
    assert.equal(localAccess.status, 200);
    assert.equal((await localAccess.json()).tiktok.displayName, 'Test Creator');
    const setup = await call('/api/setup/tiktok', {
      method: 'POST',
      json: { clientKey: 'private-client-key', clientSecret: 'private-client-secret-value' },
    });
    assert.equal(setup.status, 200);
    const agentConfig = await call('/api/agent/config');
    assert.equal(agentConfig.status, 200);
    const generated = await agentConfig.json();
    assert.equal(generated.json.mcpServers.finalcog.env.FINALCOG_API_TOKEN, process.env.FINALCOG_API_TOKEN);
    assert.match(await readFile(join(dataDir, 'local-secrets.json'), 'utf8'), /"encryptionKey"/);
    const credentialFile = await readFile(join(dataDir, 'credentials.enc'), 'utf8');
    assert.doesNotMatch(credentialFile, /private-client-secret-value/);
    assert.equal((await stat(join(dataDir, 'local-secrets.json'))).mode & 0o077, 0);
  });

  await t.test('drafts per-platform captions from frames without saving or publishing them', async () => {
    let requestBody;
    const draft = await draftCaptionsWithAnthropic({
      apiKey: 'sk-ant-test-secret-not-logged',
      frames: [Buffer.from([0xff, 0xd8, 0xff])],
      transcript: 'A creator describes the final edit.',
      platforms: ['tiktok', 'instagram'],
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.anthropic.com/v1/messages');
        assert.equal(options.headers['x-api-key'], 'sk-ant-test-secret-not-logged');
        requestBody = JSON.parse(options.body);
        return jsonResponse({
          content: [{ type: 'text', text: JSON.stringify({ captions: {
            tiktok: { caption: 'A short TikTok caption', hashtags: '#edit' },
            instagram: { caption: 'A Reels caption', hashtags: '#creator' },
          } }) }],
        });
      },
    });
    assert.equal(draft.requiresReview, true);
    assert.deepEqual(Object.keys(draft.captions), ['tiktok', 'instagram']);
    assert.match(requestBody.messages[0].content.at(-1).text, /User-provided transcript/);
    assert.equal(requestBody.messages[0].content[1].source.media_type, 'image/jpeg');
    await assert.rejects(
      extractVideoFrames(join(dataDir, 'not-a-video.mp4'), { uploadDir: join(dataDir, 'uploads') }),
      /video is not in the local upload folder/i,
    );
  });

  await t.test('requires same-origin changes and stores video plus caption variants locally', async () => {
    const session = await call('/api/session');
    assert.equal(session.status, 200);
    assert.equal((await session.json()).authenticated, true);
    assert.equal((await call('/api/session', { origin: false })).status, 200);
    assert.equal((await call('/api/settings/advanced', { origin: false })).status, 200);
    const crossSiteBootstrap = await call('/api/session', {
      origin: false,
      auth: false,
      apiToken: false,
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSiteBootstrap.status, 403);

    const blocked = await call('/api/auth/logout', { method: 'POST', origin: 'https://attacker.example' });
    assert.equal(blocked.status, 403);

    const form = new FormData();
    form.append('files', new Blob([new Uint8Array([0, 1, 2, 3, 4])], { type: 'video/mp4' }), 'sample.mp4');
    const uploaded = await call('/api/library', { method: 'POST', body: form });
    assert.equal(uploaded.status, 201);
    const [media] = (await uploaded.json()).items;
    assert.equal(media.filename, 'sample.mp4');

    const saved = await call(`/api/library/${media.id}`, {
      method: 'PATCH',
      json: {
        caption: 'TikTok caption',
        hashtags: '#finalcog',
        captionVariants: { tiktok: 'TikTok caption', instagram: 'Reels caption', youtube: 'Shorts caption' },
        platforms: ['tiktok', 'instagram', 'youtube'],
      },
    });
    assert.equal(saved.status, 200);
    const savedVideo = await saved.json();
    assert.equal(savedVideo.captionVariants.instagram, 'Reels caption');
    assert.deepEqual(savedVideo.platforms, ['tiktok', 'instagram', 'youtube']);
    const unavailableChannel = await call(`/api/videos/${media.id}/schedule`, {
      method: 'POST',
      json: { scheduledAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() },
    });
    assert.equal(unavailableChannel.status, 501);
    assert.equal((await call('/api/library')).status, 200);
  });

  await t.test('imports a GitHub release video with source metadata and a mocked API', async () => {
    const calls = [];
    globalThis.fetch = async (input, options = {}) => {
      const url = String(input);
      if (!url.startsWith('https://api.github.com/')) return originalFetch(input, options);
      calls.push({ url, headers: options.headers });
      if (url.endsWith('/releases/tags/v1.4.0')) {
        return jsonResponse({
          tag_name: 'v1.4.0',
          name: 'Final Cog release',
          assets: [{
            id: 42,
            name: 'creator-cut.mp4',
            label: 'Creator cut',
            size: 5,
            url: 'https://api.github.com/repos/venloud/finalcog/releases/assets/42',
          }],
        });
      }
      if (url.endsWith('/releases/assets/42')) {
        assert.equal(options.headers.Authorization, `Bearer ${process.env.GITHUB_TOKEN}`);
        return new Response(new Uint8Array([0, 1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-length': '5', 'content-type': 'application/octet-stream' },
        });
      }
      throw new Error(`Unexpected mocked GitHub request: ${url}`);
    };
    try {
      const imported = await call('/api/github/import', {
        method: 'POST',
        json: { owner: 'venloud', repo: 'finalcog', tag: 'v1.4.0', assetName: 'creator-cut.mp4' },
      });
      assert.equal(imported.status, 201);
      githubMedia = await imported.json();
      assert.equal(githubMedia.filename, 'creator-cut.mp4');
      assert.equal(githubMedia.caption, 'Creator cut');
      assert.equal(githubMedia.source.provider, 'github-release');
      assert.equal(githubMedia.source.owner, 'venloud');
      assert.equal(githubMedia.source.repo, 'finalcog');
      assert.equal(githubMedia.source.tag, 'v1.4.0');
      assert.equal(githubMedia.source.fileName, 'creator-cut.mp4');
      assert.ok(githubMedia.source.downloadedAt);
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('lists recent GitHub release videos and non-expired run artifacts', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, options = {}) => {
      const url = String(input);
      if (!url.startsWith('https://api.github.com/')) return originalFetch(input, options);
      assert.equal(options.headers.Authorization, `Bearer ${process.env.GITHUB_TOKEN}`);
      if (url.endsWith('/releases?per_page=10')) {
        return jsonResponse([{
          tag_name: 'v3.0.0',
          name: 'Release 3',
          published_at: '2026-11-01T12:00:00Z',
          assets: [
            { id: 1, name: 'promo.mp4', label: 'Promo', size: 50 },
            { id: 2, name: 'notes.txt', label: '', size: 1 },
          ],
        }]);
      }
      if (url.endsWith('/actions/runs?per_page=5')) {
        return jsonResponse({ workflow_runs: [{ id: 303, display_title: 'Render final', head_branch: 'main' }] });
      }
      if (url.endsWith('/actions/runs/303/artifacts?per_page=100')) {
        return jsonResponse({ artifacts: [
          { id: 4, name: 'short-video', size_in_bytes: 100, expired: false },
          { id: 5, name: 'expired-video', size_in_bytes: 100, expired: true },
        ] });
      }
      throw new Error(`Unexpected mocked GitHub source request: ${url}`);
    };
    try {
      const response = await call('/api/github/sources?owner=venloud&repo=finalcog');
      assert.equal(response.status, 200);
      const sources = await response.json();
      assert.equal(sources.releases[0].assets.length, 1);
      assert.equal(sources.releases[0].assets[0].name, 'promo.mp4');
      assert.equal(sources.runs[0].artifacts.length, 1);
      assert.equal(sources.runs[0].artifacts[0].name, 'short-video');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('extracts one MP4 from a mocked GitHub Actions artifact ZIP', async () => {
    const zip = makeZip([{ name: 'exports/short-final.mp4', content: new Uint8Array([9, 8, 7, 6]) }]);
    globalThis.fetch = async (input, options = {}) => {
      const url = String(input);
      if (!url.startsWith('https://api.github.com/')) return originalFetch(input, options);
      if (url.endsWith('/actions/runs/707/artifacts?per_page=100')) {
        return jsonResponse({
          artifacts: [{
            id: 808,
            name: 'final-cut',
            size_in_bytes: zip.length,
            expired: false,
            archive_download_url: 'https://api.github.com/repos/venloud/finalcog/actions/artifacts/808/zip',
          }],
        });
      }
      if (url.endsWith('/actions/artifacts/808/zip')) {
        return new Response(zip, {
          status: 200,
          headers: { 'content-length': String(zip.length), 'content-type': 'application/zip' },
        });
      }
      throw new Error(`Unexpected mocked GitHub Actions request: ${url}`);
    };
    try {
      const imported = await call('/api/github/import', {
        method: 'POST',
        json: { owner: 'venloud', repo: 'finalcog', runId: '707', artifactName: 'final-cut' },
      });
      assert.equal(imported.status, 201);
      const media = await imported.json();
      assert.equal(media.filename, 'short-final.mp4');
      assert.equal(media.caption, 'short-final');
      assert.equal(media.source.provider, 'github-actions');
      assert.equal(media.source.runId, '707');
      assert.equal(media.source.artifactName, 'final-cut');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('enforces pacing, schedule settings, and terminal provider retries', async () => {
    const library = await call('/api/library');
    const [media] = await library.json();
    const at = Date.now() + 8 * 60 * 60 * 1000;
    const queued = await call('/api/queue', {
      method: 'POST',
      json: { mediaId: media.id, caption: 'First caption', hashtags: '#one', scheduledAt: new Date(at).toISOString() },
    });
    assert.equal(queued.status, 201);
    const post = await queued.json();

    const tooClose = await call('/api/queue', {
      method: 'POST',
      json: { mediaId: media.id, scheduledAt: new Date(at + 60 * 60 * 1000).toISOString() },
    });
    assert.equal(tooClose.status, 409);

    const badSettings = await call('/api/settings', {
      method: 'PUT',
      json: { timezone: 'UTC', postsPerWeek: 1, activeDays: [1], preferredTimes: ['10:00'], minSpacingHours: 19 },
    });
    assert.equal(badSettings.status, 400);

    const settings = {
      timezone: 'America/New_York',
      postsPerWeek: 3,
      activeDays: [1, 3, 5],
      preferredTimes: ['10:00', '15:00'],
      minSpacingHours: 20,
    };
    const savedSettings = await call('/api/settings', { method: 'PUT', json: settings });
    assert.equal(savedSettings.status, 200);

    assert.throws(() => validateSettings({ ...settings, postsPerWeek: 4 }), /active days/);
    const slots = generateSlots(settings, Date.now(), 3);
    assert.equal(slots.length, 3);
    assert.ok(slots.every(value => value > Date.now()));

    assert.equal(removePost(user.id, post.id), true);
    const filled = await call('/api/schedule/fill', { method: 'POST', json: {} });
    assert.equal(filled.status, 200);
    const [{ id: filledId }] = (await filled.json()).created;

    db.prepare("UPDATE posts SET status = 'failed', retry_allowed = 1, error_reason = 'Local connection lost' WHERE id = ?").run(filledId);
    const retry = await call(`/api/queue/${filledId}/retry`, { method: 'POST', json: {} });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).status, 'Queued');

    db.prepare("UPDATE posts SET status = 'failed', retry_allowed = 0, publish_id = 'provider-flagged-id', error_reason = 'TikTok flagged this upload' WHERE id = ?").run(filledId);
    const flaggedRetry = await call(`/api/queue/${filledId}/retry`, { method: 'POST', json: {} });
    assert.equal(flaggedRetry.status, 409);
    assert.match((await flaggedRetry.json()).error, /never resent/);
  });

  await t.test('uploads only to TikTok inbox drafts and polls the final inbox state', async () => {
    const items = (await (await call('/api/library')).json());
    const media = items[0];
    const duePost = createPost(user.id, media.id, {
      scheduledAt: Date.now() - 1000,
      caption: media.caption,
      hashtags: media.hashtags,
    });
    const initialized = await initializeInboxUpload({
      user,
      post: { size: media.size, disk_path: db.prepare('SELECT disk_path FROM media WHERE id = ?').get(media.id).disk_path },
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/');
        assert.equal(options.method, 'POST');
        const payload = JSON.parse(options.body);
        assert.equal(payload.source_info.source, 'FILE_UPLOAD');
        return jsonResponse({ data: { publish_id: 'mock-publish-id', upload_url: 'https://upload.test/video' } });
      },
    });
    assert.equal(initialized.publishId, 'mock-publish-id');

    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      calls.push({ url: String(url), method, headers: options.headers || {} });
      if (String(url).endsWith('/v2/post/publish/inbox/video/init/')) {
        const payload = JSON.parse(options.body);
        assert.equal(payload.source_info.source, 'FILE_UPLOAD');
        return jsonResponse({ data: { publish_id: 'mock-publish-id-2', upload_url: 'https://upload.test/video-2' } });
      }
      if (String(url) === 'https://upload.test/video-2') {
        const uploaded = await new Response(options.body).arrayBuffer();
        assert.equal(uploaded.byteLength, media.size);
        return new Response(null, { status: 200 });
      }
      if (String(url).endsWith('/v2/post/publish/status/fetch/')) {
        return jsonResponse({ data: { status: 'SEND_TO_USER_INBOX' } });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    };

    const scheduler = createScheduler();
    await scheduler.tick();
    db.prepare('UPDATE posts SET next_check_at = ? WHERE id = ?').run(Date.now() - 1, duePost.id);
    await scheduler.tick();
    globalThis.fetch = originalFetch;
    const finalPost = db.prepare('SELECT status, publish_id, retry_allowed FROM posts WHERE id = ?').get(duePost.id);
    assert.equal(finalPost.status, 'sent_to_drafts');
    assert.equal(finalPost.publish_id, 'mock-publish-id-2');
    assert.equal(finalPost.retry_allowed, 0);
    assert.equal(calls.filter(call => call.url.endsWith('/v2/post/publish/inbox/video/init/')).length, 1);
    assert.equal(calls.some(call => call.url.includes('/v2/post/publish/video/init/')), false);

    const tooSoonAfterUpload = await call('/api/queue', {
      method: 'POST',
      json: { mediaId: media.id, scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    });
    assert.equal(tooSoonAfterUpload.status, 409);
    updatePostStatus(duePost.id, 'failed', { errorReason: 'TikTok flagged this upload', retryAllowed: false });
    const noRetry = await call(`/api/queue/${duePost.id}/retry`, { method: 'POST', json: {} });
    assert.equal(noRetry.status, 409);
  });

  await t.test('adds and schedules videos through the JSON API with server-side pacing', async () => {
    const localPath = join(dataDir, 'agent-source.mp4');
    await writeFile(localPath, new Uint8Array([5, 4, 3, 2, 1]));
    const added = await call('/api/videos', {
      method: 'POST',
      json: { filePath: localPath, caption: 'Agent import', hashtags: '#local' },
    });
    assert.equal(added.status, 201);
    const media = await added.json();
    assert.equal(media.caption, 'Agent import');
    assert.equal(media.source.provider, 'local-file');

    const firstTime = Date.now() + 180 * 24 * 60 * 60 * 1000;
    const scheduled = await call(`/api/videos/${media.id}/schedule`, {
      method: 'POST',
      json: { scheduledAt: new Date(firstTime).toISOString() },
    });
    assert.equal(scheduled.status, 201, JSON.stringify(await scheduled.clone().json()));
    const queueItem = await scheduled.json();
    assert.equal(queueItem.status, 'Queued');

    const spacingPath = join(dataDir, 'spacing-source.mp4');
    await writeFile(spacingPath, new Uint8Array([1, 3, 5, 7]));
    const spacingAdded = await call('/api/videos', {
      method: 'POST',
      json: { filePath: spacingPath },
    });
    pacingMediaId = (await spacingAdded.json()).id;
    const tooClose = await call(`/api/videos/${pacingMediaId}/schedule`, {
      method: 'POST',
      json: { scheduledAt: new Date(firstTime + 60 * 60 * 1000).toISOString() },
    });
    assert.equal(tooClose.status, 409);
    assert.match((await tooClose.json()).error, /at least 20 hours apart/);

    const status = await call(`/api/videos/${queueItem.id}/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).queueItem.id, queueItem.id);
  });

  await t.test('exposes agent tools and enforces pacing and flagged-send refusal through MCP', async () => {
    const apiToken = process.env.FINALCOG_API_TOKEN;
    const mcp = createFinalCogMcpServer({ baseUrl: base, token: apiToken });
    const client = new Client({ name: 'finalcog-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [...MCP_TOOL_NAMES].sort());
      const queue = await client.callTool({ name: 'list_queue', arguments: {} });
      assert.ok(queue.structuredContent.items.length >= 1);

      const localPath = join(dataDir, 'mcp-source.mp4');
      await writeFile(localPath, new Uint8Array([8, 7, 6, 5]));
      const added = await client.callTool({
        name: 'add_video',
        arguments: { filePath: localPath, caption: 'From an MCP agent' },
      });
      assert.equal(added.structuredContent.caption, 'From an MCP agent');
      const videoId = added.structuredContent.id;

      const firstTime = Date.now() + 220 * 24 * 60 * 60 * 1000;
      const scheduled = await client.callTool({
        name: 'schedule_video',
        arguments: { videoId, scheduledAt: new Date(firstTime).toISOString() },
      });
      assert.equal(scheduled.structuredContent.status, 'Queued');
      const queueId = scheduled.structuredContent.id;

      const pacingRefusal = await client.callTool({
        name: 'schedule_video',
        arguments: {
          videoId: pacingMediaId,
          scheduledAt: new Date(firstTime + 60 * 60 * 1000).toISOString(),
        },
      });
      assert.equal(pacingRefusal.isError, true);
      assert.match(pacingRefusal.content[0].text, /at least 20 hours apart/);

      const moved = await client.callTool({
        name: 'reschedule',
        arguments: { queueId, scheduledAt: new Date(firstTime + 8 * 60 * 60 * 1000).toISOString() },
      });
      assert.equal(moved.structuredContent.id, queueId);
      const status = await client.callTool({ name: 'get_status', arguments: { id: videoId } });
      assert.equal(status.structuredContent.queueItems[0].id, queueId);

      db.prepare(`
        UPDATE posts SET status = 'failed', publish_id = 'flagged-publish-id',
          retry_allowed = 0, error_reason = 'TikTok flagged this upload'
        WHERE id = ?
      `).run(queueId);
      const flaggedRefusal = await client.callTool({
        name: 'send_to_tiktok_drafts',
        arguments: { videoId },
      });
      assert.equal(flaggedRefusal.isError, true);
      assert.match(flaggedRefusal.content[0].text, /never resend/i);

      const captionUpdate = await client.callTool({
        name: 'update_caption',
        arguments: {
          videoId,
          caption: 'Revised caption',
          platforms: ['tiktok', 'instagram'],
          captionVariants: { instagram: 'Reels variant' },
        },
      });
      assert.deepEqual(captionUpdate.structuredContent.platforms, ['tiktok', 'instagram']);
      const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
      assert.equal(accounts.structuredContent.tiktok.displayName, 'Test Creator');
      const settings = await client.callTool({ name: 'get_settings', arguments: {} });
      assert.equal(settings.structuredContent.minSpacingHours, 20);
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  await t.test('imports a GitHub release asset through the MCP tool', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, options = {}) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/venloud/finalcog/releases/tags/v2.0.0') {
        return jsonResponse({
          tag_name: 'v2.0.0',
          name: 'Final Cog 2',
          assets: [{
            name: 'launch-cut.mp4',
            label: 'Launch cut',
            size: 4,
            url: 'https://api.github.com/repos/venloud/finalcog/releases/assets/99',
          }],
        });
      }
      if (url === 'https://api.github.com/repos/venloud/finalcog/releases/assets/99') {
        return new Response(new Uint8Array([2, 4, 6, 8]), { status: 200 });
      }
      return originalFetch(input, options);
    };
    const mcp = createFinalCogMcpServer({
      baseUrl: base,
      token: process.env.FINALCOG_API_TOKEN,
      fetchImpl: (input, options) => originalFetch(input, options),
    });
    const client = new Client({ name: 'finalcog-github-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: 'import_github_artifact',
        arguments: { owner: 'venloud', repo: 'finalcog', tag: 'v2.0.0', assetName: 'launch-cut.mp4' },
      });
      assert.equal(result.structuredContent.caption, 'Launch cut');
      assert.equal(result.structuredContent.source.provider, 'github-release');
      assert.equal(result.structuredContent.source.tag, 'v2.0.0');
    } finally {
      await client.close();
      await mcp.close();
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('rejects MCP requests without a local bearer token', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${new URL(base).port}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(response.status, 401);
  });

  await t.test('serves the tools over authenticated localhost Streamable HTTP', async () => {
    const client = new Client({ name: 'finalcog-http-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${process.env.FINALCOG_API_TOKEN}` },
      },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [...MCP_TOOL_NAMES].sort());
      const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
      assert.equal(accounts.structuredContent.tiktok.displayName, 'Test Creator');
    } finally {
      await client.close();
    }
  });
});

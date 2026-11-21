import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('Final Cog local app, scheduler, and TikTok inbox flow', async t => {
  const originalFetch = globalThis.fetch;
  const server = createApplicationServer();
  let base;
  let user;
  let sessionCookie;

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
    if (options.origin !== false) headers.set('Origin', base);
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

  await t.test('requires same-origin changes and stores video plus caption variants locally', async () => {
    const session = await call('/api/session');
    assert.equal(session.status, 200);
    assert.equal((await session.json()).authenticated, true);

    const blocked = await call('/api/auth/logout', { method: 'POST', origin: false });
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
      },
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).captionVariants.instagram, 'Reels caption');
    assert.equal((await call('/api/library')).status, 200);
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
      json: { timezone: 'UTC', postsPerWeek: 1, activeDays: [1], preferredTimes: ['10:00'], minSpacingHours: 2 },
    });
    assert.equal(badSettings.status, 400);

    const settings = {
      timezone: 'America/New_York',
      postsPerWeek: 3,
      activeDays: [1, 3, 5],
      preferredTimes: ['10:00', '15:00'],
      minSpacingHours: 3,
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
});

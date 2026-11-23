import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import Busboy from 'busboy';
import { config, getConfigProblems } from './config.mjs';
import { getLocalCredential, saveLocalCredential } from './local-secrets.mjs';
import {
  addOAuthState,
  consumeOAuthState,
  createPost,
  connectedUsers,
  db,
  deleteMedia,
  disconnectUser,
  ensureLocalWorkspaceUser,
  findSpacingConflicts,
  getMediaById,
  getPostById,
  getSettings,
  insertMedia,
  listMedia,
  listPosts,
  listPostsForMedia,
  markPostPosted,
  removePost,
  retryPost,
  saveSettings,
  saveTikTokUser,
  sendPostNow,
  updateMedia,
  updatePost,
  queuedMediaIds,
} from './database.mjs';
import { hasApiAccess, hasValidBearerToken } from './api-auth.mjs';
import {
  clearOAuthCookie,
  clearSessionCookie,
  encryptToken,
  endSession,
  getOAuthCookie,
  getRequestSession,
  isSameSecret,
  randomToken,
  setOAuthCookie,
  sha256,
  startSession,
} from './security.mjs';
import {
  createAuthorizeUrl,
  exchangeAuthorizationCode,
  fetchUserProfile,
  revokeTikTokToken,
} from './tiktok.mjs';
import { generateSlots, localDateTimeToUtc, validateSettings } from './schedule-utils.mjs';
import { HttpError, readJson, redirect, requireSameOrigin, sendHtmlMessage, sendJson } from './http.mjs';
import { downloadGithubVideo, listGithubSources } from './github.mjs';
import { createFinalCogMcpServer, createStreamableHttpTransport } from './mcp.mjs';
import { draftCaptionsWithAnthropic, extractVideoFrames } from './captions.mjs';

const root = process.cwd();
const execFile = promisify(execFileCallback);
const uploadDir = resolve(config.dataDir, 'uploads');
const ROOT_FILES = new Set(['index.html', 'privacy.html', 'terms.html', 'tiktok-callback.html', 'mascot.jpg']);
const PUBLIC_DIRECTORIES = new Set(['app', 'assets', 'kindlediron', 'legacy', 'snapchat']);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};
const VIDEO_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.3gp', 'video/3gpp'],
]);
const STATUS_LABELS = {
  queued: 'Queued',
  sending: 'Sending',
  sent_to_drafts: 'Sent to drafts',
  posted: 'Posted',
  failed: 'Failed',
  needs_review: 'Needs review',
};

const json = (response, status, body) => sendJson(response, status, body);
const configOrigin = new URL(config.appBaseUrl).origin;
const uploadFolderReady = mkdir(uploadDir, { recursive: true });

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' https://images.pexels.com data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://open.tiktokapis.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  );
}

function requireAuthenticated(request) {
  const session = getRequestSession(request);
  if (session?.user) return session.user;
  if (hasValidBearerToken(request)) {
    const accounts = connectedUsers();
    if (accounts.length === 1) return accounts[0];
    if (accounts.length > 1) {
      throw new HttpError(409, 'More than one TikTok account is connected. Sign in through the app to select an account.');
    }
    return ensureLocalWorkspaceUser();
  }
  throw new HttpError(401, 'Open Final Cog in this browser to use the local workspace.');
}

function accountView(user) {
  if (!user?.access_token_enc) return null;
  return {
    displayName: user.display_name || 'TikTok creator',
    username: user.username || '',
    avatarUrl: '',
    connectedAt: user.connected_at ? new Date(user.connected_at).toISOString() : null,
  };
}

function safeCaptionVariants(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const platform of ['tiktok', 'instagram', 'youtube']) {
    const caption = value[platform];
    if (typeof caption === 'string') output[platform] = caption.slice(0, 2200);
  }
  return output;
}

function safePlatforms(value) {
  if (!Array.isArray(value)) return ['tiktok'];
  const platforms = [...new Set(value.map(String).filter(item => ['tiktok', 'instagram', 'youtube'].includes(item)))];
  return platforms.length ? platforms : ['tiktok'];
}

function mediaView(row) {
  let captionVariants = {};
  try { captionVariants = JSON.parse(row.caption_variants || '{}'); } catch { captionVariants = {}; }
  let source = null;
  try { source = row.source_json ? JSON.parse(row.source_json) : null; } catch { source = null; }
  return {
    id: row.id,
    filename: row.original_filename || row.filename,
    size: row.size,
    mimeType: row.mime_type,
    caption: row.caption,
    hashtags: row.hashtags,
    captionVariants,
    platforms: (() => {
      try { return safePlatforms(JSON.parse(row.platforms || '["tiktok"]')); }
      catch { return ['tiktok']; }
    })(),
    source,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function postView(row) {
  return {
    id: row.id,
    mediaId: row.media_id,
    filename: row.filename,
    caption: row.caption,
    hashtags: row.hashtags,
    scheduledAt: new Date(row.scheduled_at).toISOString(),
    status: STATUS_LABELS[row.status] || 'Needs review',
    errorReason: row.error_reason || '',
    retryAllowed: Boolean(row.retry_allowed) && !row.publish_id,
  };
}

function textValue(value, label, maxLength) {
  const text = value == null ? '' : String(value).trim();
  if (text.length > maxLength) throw new HttpError(400, `${label} is too long.`);
  return text;
}

function scheduledTimestamp(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new HttpError(400, 'Choose a valid scheduled time.');
  const now = Date.now();
  if (timestamp < now - 60_000) throw new HttpError(400, 'Choose a time in the future.');
  if (timestamp > now + 370 * 24 * 60 * 60 * 1000) {
    throw new HttpError(400, 'Schedule videos no more than one year ahead.');
  }
  return timestamp;
}

function checkSpacing(userId, timestamp, excludePostId = null) {
  const settings = getSettings(userId);
  const hours = Math.max(config.minSpacingHours, settings.minSpacingHours);
  const conflict = findSpacingConflicts(userId, timestamp, hours * 60 * 60 * 1000, excludePostId);
  if (conflict) {
    throw new HttpError(409, `TikTok inbox uploads must be at least ${hours} hours apart.`);
  }
}

function formatApiError(error) {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  return { status: 500, message: 'The local server could not complete this request.' };
}

function sanitizeFilename(input) {
  const name = basename(String(input || 'video').replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 180);
  return name || 'video';
}

function privateAddress(address) {
  const normalized = String(address).toLowerCase();
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
      a === 100 && b >= 64 && b <= 127;
  }
  if (isIP(normalized) === 6) {
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
        normalized.startsWith('fd') || normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') || normalized.startsWith('fea') ||
        normalized.startsWith('feb')) return true;
    if (normalized.startsWith('::ffff:')) return privateAddress(normalized.slice(7));
  }
  return false;
}

async function validatePublicVideoUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new HttpError(400, 'Enter a valid public HTTPS video URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
      url.hostname.endsWith('.local')) {
    throw new HttpError(400, 'Video URLs must use public HTTPS addresses without embedded credentials.');
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) {
    throw new HttpError(400, 'Video URLs must resolve to a public internet address.');
  }
  return url;
}

async function fetchPublicVideo(value, tempDir) {
  let url = await validatePublicVideoUrl(value);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
    }).catch(() => {
      throw new HttpError(502, 'The video URL could not be reached.');
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || redirects === 5) throw new HttpError(502, 'The video URL redirected too many times.');
      url = await validatePublicVideoUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new HttpError(502, `The video URL returned HTTP ${response.status}.`);
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > config.maxUploadBytes) {
      throw new HttpError(413, 'The video exceeds the configured MAX_UPLOAD_MB limit.');
    }
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const typeExtension = [...VIDEO_TYPES].find(([, type]) => type === contentType)?.[0];
    const pathExtension = extname(decodeURIComponent(url.pathname)).toLowerCase();
    const extension = VIDEO_TYPES.has(pathExtension) ? pathExtension : typeExtension;
    if (!extension || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(415, 'The URL must return an MP4, MOV, WebM, M4V, or 3GP video.');
    }
    const filename = sanitizeFilename(basename(decodeURIComponent(url.pathname)) || `video${extension}`);
    const filePath = resolve(tempDir, `${randomUUID()}${extension}`);
    let received = 0;
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > config.maxUploadBytes) {
          callback(new HttpError(413, 'The video exceeds the configured MAX_UPLOAD_MB limit.'));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(filePath, { flags: 'wx' }));
    const metadata = await stat(filePath);
    if (!metadata.size) throw new HttpError(400, 'The video URL returned an empty file.');
    if (metadata.size > config.maxUploadBytes) {
      throw new HttpError(413, 'The video exceeds the configured MAX_UPLOAD_MB limit.');
    }
    return { filePath, filename, size: metadata.size, contentType: VIDEO_TYPES.get(extension), finalUrl: url };
  }
  throw new HttpError(502, 'The video URL redirected too many times.');
}

async function persistVideoFile({
  userId,
  filePath,
  filename,
  caption,
  hashtags = '',
  source = null,
}) {
  await uploadFolderReady;
  let sourcePath;
  try { sourcePath = await realpath(filePath); }
  catch { throw new HttpError(404, 'The selected video file could not be found.'); }
  const extension = extname(filename || sourcePath).toLowerCase();
  const mimeType = VIDEO_TYPES.get(extension);
  if (!mimeType) {
    throw new HttpError(415, 'Use an MP4, MOV, WebM, M4V, or 3GP video file.');
  }
  const metadata = await stat(sourcePath);
  if (!metadata.isFile()) throw new HttpError(400, 'Choose a video file, not a folder.');
  if (!metadata.size) throw new HttpError(400, 'The selected video file is empty.');
  if (metadata.size > config.maxUploadBytes) {
    throw new HttpError(413, 'The selected video exceeds the configured MAX_UPLOAD_MB limit.');
  }

  const id = randomUUID();
  const safeFilename = sanitizeFilename(filename || basename(sourcePath));
  const finalPath = resolve(uploadDir, `${id}${extension}`);
  const temporaryPath = `${finalPath}.part`;
  try {
    await pipeline(
      createReadStream(sourcePath),
      createWriteStream(temporaryPath, { flags: 'wx' }),
    );
    const copied = await stat(temporaryPath);
    if (copied.size !== metadata.size) throw new HttpError(400, 'The video changed while it was being imported.');
    await rename(temporaryPath, finalPath);
    const defaultCaption = String(caption || basename(safeFilename, extension)).trim().slice(0, 2200);
    const safeHashtags = String(hashtags || '').trim().slice(0, 500);
    insertMedia([{
      id,
      userId,
      filename: safeFilename,
      originalFilename: safeFilename,
      mimeType,
      size: copied.size,
      diskPath: finalPath,
      caption: defaultCaption,
      hashtags: safeHashtags,
      captionVariants: JSON.stringify(defaultCaption ? { tiktok: defaultCaption } : {}),
      platforms: JSON.stringify(['tiktok']),
      sourceJson: source ? JSON.stringify(source) : '',
      createdAt: Date.now(),
    }]);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    await unlink(finalPath).catch(() => {});
    throw error;
  }
  return mediaView(getMediaById(userId, id));
}

function assertVideoCanBeScheduled(userId, mediaId) {
  const posts = listPostsForMedia(userId, mediaId);
  if (posts.some(post => ['queued', 'sending'].includes(post.status))) {
    throw new HttpError(409, 'This video is already queued. Reschedule its existing queue item instead.');
  }
  if (posts.some(post => post.publish_id || ['sent_to_drafts', 'posted', 'needs_review', 'failed'].includes(post.status))) {
    throw new HttpError(409, 'This video has already been processed or needs review. Final Cog will not resend it.');
  }
}

function loopbackRequest(request) {
  const address = String(request.socket?.remoteAddress || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
}

function localMcpRequest(request) {
  if (!loopbackRequest(request)) return false;
  try {
    const host = new URL(`http://${request.headers.host || ''}`).hostname.toLowerCase();
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return false;
    if (!request.headers.origin) return true;
    const origin = new URL(request.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) &&
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(origin.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function handleMcp(request, response) {
  if (!hasValidBearerToken(request)) {
    throw new HttpError(401, 'Use the local agent configuration from Settings > Advanced.');
  }
  if (!localMcpRequest(request)) {
    throw new HttpError(403, 'MCP is available only to local clients on localhost.');
  }

  const localPort = request.socket?.localPort || config.port;
  const server = createFinalCogMcpServer({
    baseUrl: `http://127.0.0.1:${localPort}`,
    token: config.apiToken,
  });
  const transport = createStreamableHttpTransport();
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function parseVideoFiles(request, userId) {
  await uploadFolderReady;
  const maxFiles = 20;
  const contentLength = Number(request.headers['content-length'] || 0);
  if (contentLength && contentLength > config.maxUploadBytes * maxFiles + 1024 * 1024) {
    throw new HttpError(413, 'The selected batch is larger than the local upload limit.');
  }

  const busboy = Busboy({
    headers: request.headers,
    limits: { files: maxFiles, fileSize: config.maxUploadBytes, fields: 10 },
  });
  const pending = [];
  const saved = [];
  let failure = null;

  const parseComplete = new Promise((resolveParse, rejectParse) => {
    busboy.on('file', (fieldName, stream, info) => {
      if (fieldName !== 'files') {
        stream.resume();
        return;
      }
      const originalFilename = sanitizeFilename(info.filename);
      const extension = extname(originalFilename).toLowerCase();
      const mimeType = VIDEO_TYPES.get(extension);
      if (!mimeType || (info.mimeType && !info.mimeType.startsWith('video/') && info.mimeType !== 'application/octet-stream')) {
        failure ||= new HttpError(415, `${originalFilename} is not a supported video file. Use MP4, MOV, WebM, or 3GP.`);
        stream.resume();
        return;
      }

      const id = randomUUID();
      const temporaryPath = resolve(uploadDir, `${id}.part`);
      const finalPath = resolve(uploadDir, `${id}${extension}`);
      let tooLarge = false;
      stream.on('limit', () => { tooLarge = true; });
      const write = pipeline(stream, createWriteStream(temporaryPath, { flags: 'wx' }))
        .then(async () => {
          if (tooLarge || stream.truncated) throw new HttpError(413, `${originalFilename} is larger than the configured upload limit.`);
          const metadata = await stat(temporaryPath);
          if (!metadata.size) throw new HttpError(400, `${originalFilename} is empty.`);
          await rename(temporaryPath, finalPath);
          saved.push({
            id,
            userId,
            filename: originalFilename,
            originalFilename,
            mimeType,
            size: metadata.size,
            diskPath: finalPath,
            createdAt: Date.now(),
          });
        })
        .catch(async error => {
          failure ||= error;
          await unlink(temporaryPath).catch(() => {});
          await unlink(finalPath).catch(() => {});
        });
      pending.push(write);
    });
    busboy.on('filesLimit', () => { failure ||= new HttpError(413, `Upload no more than ${maxFiles} videos at once.`); });
    busboy.on('fieldsLimit', () => { failure ||= new HttpError(400, 'Too many form fields were submitted.'); });
    busboy.on('error', rejectParse);
    busboy.on('finish', resolveParse);
    request.on('error', rejectParse);
    request.pipe(busboy);
  });

  try {
    await parseComplete;
    await Promise.all(pending);
    if (failure) throw failure;
    if (!saved.length) throw new HttpError(400, 'Choose at least one supported video file.');
    insertMedia(saved);
    return saved.map(item => mediaView({
      id: item.id,
      original_filename: item.originalFilename,
      filename: item.filename,
      size: item.size,
      mime_type: item.mimeType,
      caption: '',
      hashtags: '',
      caption_variants: '{}',
      created_at: item.createdAt,
    }));
  } catch (error) {
    await Promise.all(saved.map(item => unlink(item.diskPath).catch(() => {})));
    throw error;
  }
}

function monthBounds(monthValue, timeZone) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthValue || '')) {
    throw new HttpError(400, 'Choose a valid calendar month.');
  }
  const [year, month] = monthValue.split('-').map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const from = localDateTimeToUtc(`${year}-${String(month).padStart(2, '0')}-01`, '00:00', timeZone);
  const to = localDateTimeToUtc(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01`, '00:00', timeZone);
  return { from, to };
}

async function serveStatic(pathname, request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    throw new HttpError(405, 'This page only supports GET requests.');
  }
  const normalizedPath = pathname === '/' ? '/index.html' : pathname;
  const segments = normalizedPath.split('/').filter(Boolean);
  if (!segments.length || segments.some(segment => segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new HttpError(404, 'Not found.');
  }
  const first = segments[0];
  if (segments.length === 1) {
    const allowedRootFile = ROOT_FILES.has(first) ||
      (first.startsWith('tiktok') && extname(first).toLowerCase() === '.txt');
    if (!allowedRootFile && !PUBLIC_DIRECTORIES.has(first)) throw new HttpError(404, 'Not found.');
  } else if (!PUBLIC_DIRECTORIES.has(first)) {
    throw new HttpError(404, 'Not found.');
  }

  const realRoot = await realpath(root);
  let file;
  try {
    file = await realpath(resolve(root, ...segments));
    if (!file.startsWith(realRoot + sep)) throw new HttpError(404, 'Not found.');
    if ((await stat(file)).isDirectory()) {
      file = await realpath(resolve(file, 'index.html'));
      if (!file.startsWith(realRoot + sep)) throw new HttpError(404, 'Not found.');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code)) throw new HttpError(404, 'Not found.');
    throw error;
  }
  const contentType = MIME_TYPES[extname(file).toLowerCase()];
  if (!contentType) throw new HttpError(404, 'Not found.');
  const body = await readFile(file);
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function oauthStateForPort(port) {
  return `fc1_${port}_${randomToken(32)}`;
}

async function handleOAuthStart(response) {
  const missing = getConfigProblems();
  if (missing.length) {
    redirect(response, '/app/?auth=setup');
    return;
  }
  const state = oauthStateForPort(config.port);
  addOAuthState(sha256(state), Date.now() + 10 * 60 * 1000);
  setOAuthCookie(response, state);
  redirect(response, createAuthorizeUrl(state));
}

async function handleOAuthCallback(request, response, url) {
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const providerErrorCode = url.searchParams.get('error') || '';
  const cookieState = getOAuthCookie(request);
  if (!state || !cookieState || !isSameSecret(state, cookieState) ||
      !consumeOAuthState(sha256(state))) {
    clearOAuthCookie(response);
    sendHtmlMessage(response, 'TikTok sign-in could not be verified', 'Return to Final Cog and start sign-in again.', 400);
    return;
  }
  clearOAuthCookie(response);
  if (providerErrorCode) {
    redirect(response, '/app/?auth=cancelled');
    return;
  }
  if (!code || code.length > 4096) {
    sendHtmlMessage(response, 'TikTok sign-in did not finish', 'No authorization code was received. Start sign-in again from Final Cog.', 400);
    return;
  }
  try {
    const tokenData = await exchangeAuthorizationCode(code);
    const profile = await fetchUserProfile(tokenData.accessToken);
    if (profile.open_id !== tokenData.openId) {
      throw new Error('TikTok account identifiers did not match.');
    }
    const user = saveTikTokUser(profile, {
      accessTokenEncrypted: encryptToken(tokenData.accessToken),
      refreshTokenEncrypted: tokenData.refreshToken
        ? encryptToken(tokenData.refreshToken)
        : '',
      expiresIn: tokenData.expiresIn,
      refreshExpiresIn: tokenData.refreshExpiresIn,
      scopes: tokenData.scopes,
    });
    startSession(response, user.id);
    redirect(response, '/app/?connected=1');
  } catch {
    sendHtmlMessage(response, 'TikTok sign-in failed', 'Check the TikTok app scopes and saved app credentials, then try again.', 502);
  }
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  const method = request.method || 'GET';
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  let newWorkspaceUser = null;
  if (pathname === '/api/session' && method === 'GET' && !getRequestSession(request)) {
    const workspaceUser = ensureLocalWorkspaceUser();
    newWorkspaceUser = workspaceUser;
    startSession(response, workspaceUser.id);
  }

  if (pathname === '/api/session' && method === 'GET') {
    requireSameOrigin(request, configOrigin);
    const session = getRequestSession(request) || (newWorkspaceUser ? { user: newWorkspaceUser } : null);
    const authenticated = Boolean(session?.user);
    json(response, 200, {
      authenticated,
      configured: getConfigProblems().length === 0,
      tiktokConfigured: getConfigProblems().length === 0,
      anthropicConfigured: Boolean(getLocalCredential('anthropic_api_key')),
      account: accountView(session?.user),
      apiAuthenticated: true,
    });
    return;
  }

  if (!hasApiAccess(request)) {
    throw new HttpError(401, 'Open Final Cog in this browser to use the local workspace.');
  }

  if (mutating) {
    if (hasValidBearerToken(request)) {
      if (!loopbackRequest(request)) throw new HttpError(403, 'Local API tokens are accepted only from loopback clients.');
    } else {
      requireSameOrigin(request, configOrigin);
    }
  }

  if (pathname === '/api/agent/config' && method === 'GET') {
    requireSameOrigin(request, configOrigin);
    const configPath = resolve(root, 'mcp-server.mjs');
    const body = {
      json: {
        mcpServers: {
          finalcog: {
            command: process.execPath,
            args: [configPath],
            env: { FINALCOG_API_URL: config.appBaseUrl },
          },
        },
      },
      apiToken: config.apiToken,
    };
    json(response, 200, body);
    return;
  }

  if (pathname === '/api/settings/advanced' && method === 'GET') {
    requireSameOrigin(request, configOrigin);
    json(response, 200, {
      anthropicConfigured: Boolean(getLocalCredential('anthropic_api_key')),
      aiCaptionsEnabled: getLocalCredential('ai_captions_enabled') === '1',
      tiktokConfigured: getConfigProblems().length === 0,
    });
    return;
  }

  if (pathname === '/api/settings/ai-enabled' && method === 'PUT') {
    const body = await readJson(request, 2048);
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'Choose whether AI captions are enabled.');
    if (body.enabled && !getLocalCredential('anthropic_api_key')) {
      throw new HttpError(409, 'Save your Anthropic API key before enabling AI captions.');
    }
    saveLocalCredential('ai_captions_enabled', body.enabled ? '1' : '');
    json(response, 200, { enabled: body.enabled });
    return;
  }

  if (pathname === '/api/setup/tiktok' && method === 'POST') {
    const body = await readJson(request, 8192);
    const clientKey = textValue(body.clientKey, 'TikTok client key', 256);
    const clientSecret = textValue(body.clientSecret, 'TikTok client secret', 1024);
    if (clientKey.length < 6 || clientSecret.length < 12) {
      throw new HttpError(400, 'Enter the client key and secret from your TikTok developer app.');
    }
    saveLocalCredential('tiktok_client_key', clientKey);
    saveLocalCredential('tiktok_client_secret', clientSecret);
    json(response, 200, { configured: true });
    return;
  }

  if (pathname === '/api/settings/anthropic-key' && method === 'PUT') {
    const body = await readJson(request, 8192);
    const key = textValue(body.apiKey, 'Anthropic API key', 512);
    if (!key.startsWith('sk-ant-') || key.length < 30) {
      throw new HttpError(400, 'Enter a valid Anthropic API key.');
    }
    saveLocalCredential('anthropic_api_key', key);
    json(response, 200, { configured: true });
    return;
  }

  if (pathname === '/api/settings/anthropic-key' && method === 'DELETE') {
    saveLocalCredential('anthropic_api_key', '');
    saveLocalCredential('ai_captions_enabled', '');
    json(response, 200, { configured: false });
    return;
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    endSession(request, response);
    json(response, 200, { ok: true });
    return;
  }

  if (pathname === '/api/accounts/disconnect' && method === 'POST') {
    const user = requireAuthenticated(request);
    await revokeTikTokToken(user);
    disconnectUser(user.id);
    clearSessionCookie(response);
    json(response, 200, { ok: true });
    return;
  }

  if (pathname === '/api/accounts' && method === 'GET') {
    const session = getRequestSession(request);
    const accounts = hasValidBearerToken(request) ? connectedUsers() : [];
    const accountUser = session?.user?.access_token_enc
      ? session.user
      : accounts.length === 1 ? accounts[0] : null;
    json(response, 200, {
      tiktok: accountView(accountUser),
      youtube: { available: false },
      instagram: { available: false },
      twitch: { available: false },
    });
    return;
  }

  const user = requireAuthenticated(request);

  if (pathname === '/api/queue' && method === 'GET') {
    const requestedLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : null;
    json(response, 200, listPosts(user.id, { limit }).map(postView));
    return;
  }

  if (pathname === '/api/calendar' && method === 'GET') {
    const { from, to } = monthBounds(url.searchParams.get('month') || '', getSettings(user.id).timezone);
    json(response, 200, listPosts(user.id, { from, to }).map(postView));
    return;
  }

  if (pathname === '/api/library' && method === 'GET') {
    json(response, 200, listMedia(user.id).map(mediaView));
    return;
  }

  if (pathname === '/api/videos' && method === 'GET') {
    json(response, 200, listMedia(user.id).map(mediaView));
    return;
  }

  if (pathname === '/api/videos' && method === 'POST') {
    const body = await readJson(request);
    const hasPath = typeof body.filePath === 'string' && body.filePath.trim();
    const hasUrl = typeof body.url === 'string' && body.url.trim();
    if (Boolean(hasPath) === Boolean(hasUrl)) {
      throw new HttpError(400, 'Provide exactly one video source: filePath or url.');
    }
    if (hasPath) {
      const filePath = String(body.filePath).trim();
      if (filePath.length > 2048) throw new HttpError(400, 'The local file path is too long.');
      const filename = sanitizeFilename(basename(filePath.replaceAll('\\', '/')));
      const item = await persistVideoFile({
        userId: user.id,
        filePath,
        filename,
        caption: textValue(body.caption || '', 'Caption', 2200),
        hashtags: textValue(body.hashtags || '', 'Hashtags', 500),
        source: { provider: 'local-file', fileName: filename, importedAt: new Date().toISOString() },
      });
      json(response, 201, item);
      return;
    }
    const urlValue = String(body.url).trim();
    if (urlValue.length > 4096) throw new HttpError(400, 'The video URL is too long.');
    const tempDir = await mkdtemp(resolve(config.dataDir, 'video-import-'));
    try {
      const downloaded = await fetchPublicVideo(urlValue, tempDir);
      const safeUrl = new URL(downloaded.finalUrl);
      const item = await persistVideoFile({
        userId: user.id,
        filePath: downloaded.filePath,
        filename: downloaded.filename,
        caption: textValue(body.caption || '', 'Caption', 2200),
        hashtags: textValue(body.hashtags || '', 'Hashtags', 500),
        source: {
          provider: 'https-url',
          url: `${safeUrl.origin}${safeUrl.pathname}`,
          fileName: downloaded.filename,
          downloadedAt: new Date().toISOString(),
        },
      });
      json(response, 201, item);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    return;
  }

  const videoMatch = pathname.match(/^\/api\/videos\/([a-f0-9-]+)$/i);
  if (videoMatch && method === 'PATCH') {
    const body = await readJson(request);
    const mediaId = videoMatch[1];
    if (!getMediaById(user.id, mediaId)) throw new HttpError(404, 'Video not found in this library.');
    const updated = updateMedia(user.id, mediaId, {
      caption: textValue(body.caption, 'Caption', 2200),
      hashtags: textValue(body.hashtags, 'Hashtags', 500),
      captionVariants: safeCaptionVariants(body.captionVariants),
      platforms: safePlatforms(body.platforms),
    });
    json(response, 200, mediaView(updated));
    return;
  }

  const draftCaptionsMatch = pathname.match(/^\/api\/videos\/([a-f0-9-]+)\/draft-captions$/i);
  if (draftCaptionsMatch && method === 'POST') {
    if (getLocalCredential('ai_captions_enabled') !== '1') {
      throw new HttpError(409, 'AI captions are off. Turn them on in Settings > Advanced.');
    }
    const apiKey = getLocalCredential('anthropic_api_key');
    if (!apiKey) throw new HttpError(409, 'Add your Anthropic API key in Settings > Advanced.');
    const media = getMediaById(user.id, draftCaptionsMatch[1]);
    if (!media) throw new HttpError(404, 'Video not found in this library.');
    const body = await readJson(request, 8192);
    const transcript = textValue(body.transcript || '', 'Transcript', 4000);
    const platforms = safePlatforms(body.platforms);
    const frames = await extractVideoFrames(media.disk_path, { uploadDir });
    const draft = await draftCaptionsWithAnthropic({
      apiKey,
      frames,
      transcript,
      platforms,
    });
    json(response, 200, draft);
    return;
  }

  if (pathname === '/api/github/sources' && method === 'GET') {
    json(response, 200, await listGithubSources(
      url.searchParams.get('owner'),
      url.searchParams.get('repo'),
    ));
    return;
  }

  if (pathname === '/api/github/import' && method === 'POST') {
    const body = await readJson(request);
    const tempDir = await mkdtemp(resolve(config.dataDir, 'github-import-'));
    try {
      const downloaded = await downloadGithubVideo(body, {
        tempDir,
        maxBytes: config.maxUploadBytes,
      });
      const item = await persistVideoFile({
        userId: user.id,
        filePath: downloaded.filePath,
        filename: downloaded.filename,
        caption: downloaded.title,
        source: downloaded.source,
      });
      json(response, 201, item);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    return;
  }

  const videoScheduleMatch = pathname.match(/^\/api\/videos\/([a-f0-9-]+)\/schedule$/i);
  if (videoScheduleMatch && method === 'POST') {
    const mediaId = videoScheduleMatch[1];
    const body = await readJson(request);
    const media = getMediaById(user.id, mediaId);
    if (!media) throw new HttpError(404, 'Video not found in this library.');
    const requestedPlatforms = safePlatforms(body.platforms || media.platforms);
    if (requestedPlatforms.some(platform => platform !== 'tiktok')) {
      throw new HttpError(501, 'Scheduling for Instagram and YouTube is not available yet. TikTok inbox drafts are supported now.');
    }
    assertVideoCanBeScheduled(user.id, mediaId);
    const timestamp = scheduledTimestamp(body.scheduledAt);
    checkSpacing(user.id, timestamp);
    const post = createPost(user.id, mediaId, {
      scheduledAt: timestamp,
      caption: textValue(body.caption ?? media.caption, 'Caption', 2200),
      hashtags: textValue(body.hashtags ?? media.hashtags, 'Hashtags', 500),
    });
    json(response, 201, postView(post));
    return;
  }

  const sendDraftMatch = pathname.match(/^\/api\/videos\/([a-f0-9-]+)\/send-to-drafts$/i);
  if (sendDraftMatch && method === 'POST') {
    const mediaId = sendDraftMatch[1];
    const media = getMediaById(user.id, mediaId);
    if (!media) throw new HttpError(404, 'Video not found in this library.');
    const posts = listPostsForMedia(user.id, mediaId);
    const processed = posts.find(post =>
      post.publish_id || ['sent_to_drafts', 'posted', 'needs_review'].includes(post.status) ||
      post.status === 'failed' && !post.retry_allowed
    );
    if (processed) {
      throw new HttpError(409, 'This video was processed, flagged, or needs review. Final Cog will never resend it.');
    }
    const queued = posts.find(post => post.status === 'queued');
    if (queued) {
      checkSpacing(user.id, Date.now(), queued.id);
      const updated = sendPostNow(user.id, queued.id, Date.now());
      if (!updated) throw new HttpError(409, 'This queue item can no longer be sent immediately.');
      json(response, 200, postView(updated));
      return;
    }
    const failed = posts.find(post => post.status === 'failed');
    if (failed) {
      if (failed.publish_id || !failed.retry_allowed) {
        throw new HttpError(409, 'This video was processed or flagged. Final Cog will never resend it.');
      }
      checkSpacing(user.id, Date.now(), failed.id);
      const retried = retryPost(user.id, failed.id);
      if (!retried) throw new HttpError(409, 'This video is not eligible for a safe retry.');
      json(response, 200, postView(retried));
      return;
    }
    assertVideoCanBeScheduled(user.id, mediaId);
    checkSpacing(user.id, Date.now());
    const post = createPost(user.id, mediaId, {
      scheduledAt: Date.now(),
      caption: media.caption,
      hashtags: media.hashtags,
    });
    json(response, 201, postView(post));
    return;
  }

  const videoStatusMatch = pathname.match(/^\/api\/videos\/([a-f0-9-]+)\/status$/i);
  if (videoStatusMatch && method === 'GET') {
    const id = videoStatusMatch[1];
    const post = getPostById(user.id, id);
    if (post) {
      json(response, 200, { videoId: post.media_id, queueItem: postView(post) });
      return;
    }
    const media = getMediaById(user.id, id);
    if (!media) throw new HttpError(404, 'Video or queue item not found.');
    json(response, 200, {
      videoId: media.id,
      filename: media.original_filename || media.filename,
      status: 'In library',
      queueItems: listPostsForMedia(user.id, media.id).map(postView),
    });
    return;
  }

  if (pathname === '/api/library' && method === 'POST') {
    if (!String(request.headers['content-type'] || '').startsWith('multipart/form-data')) {
      throw new HttpError(415, 'Upload videos using a multipart form.');
    }
    const items = await parseVideoFiles(request, user.id);
    json(response, 201, { items });
    return;
  }

  const libraryMatch = pathname.match(/^\/api\/library\/([a-f0-9-]+)$/i);
  if (libraryMatch && method === 'PATCH') {
    const mediaId = libraryMatch[1];
    const body = await readJson(request);
    const media = getMediaById(user.id, mediaId);
    if (!media) throw new HttpError(404, 'Video not found in this library.');
    const updated = updateMedia(user.id, mediaId, {
      caption: textValue(body.caption, 'Caption', 2200),
      hashtags: textValue(body.hashtags, 'Hashtags', 500),
      captionVariants: safeCaptionVariants(body.captionVariants),
      platforms: safePlatforms(body.platforms),
    });
    json(response, 200, mediaView(updated));
    return;
  }
  if (libraryMatch && method === 'DELETE') {
    const result = deleteMedia(user.id, libraryMatch[1]);
    if (!result) throw new HttpError(404, 'Video not found in this library.');
    if (result.conflict) throw new HttpError(409, 'Remove or finish this video’s active queue item before deleting it.');
    await unlink(result.media.disk_path).catch(() => {});
    json(response, 200, { ok: true });
    return;
  }

  if (pathname === '/api/queue' && method === 'POST') {
    const body = await readJson(request);
    const media = getMediaById(user.id, String(body.mediaId || ''));
    if (!media) throw new HttpError(404, 'Choose a video from your library.');
    const timestamp = scheduledTimestamp(body.scheduledAt);
    checkSpacing(user.id, timestamp);
    const post = createPost(user.id, media.id, {
      scheduledAt: timestamp,
      caption: textValue(body.caption ?? media.caption, 'Caption', 2200),
      hashtags: textValue(body.hashtags ?? media.hashtags, 'Hashtags', 500),
    });
    json(response, 201, postView(post));
    return;
  }

  const queueMatch = pathname.match(/^\/api\/queue\/([a-f0-9-]+)(?:\/(send-now|retry|mark-posted))?$/i);
  if (queueMatch) {
    const postId = queueMatch[1];
    const action = queueMatch[2] || '';
    if (!action && method === 'PATCH') {
      const existing = getPostById(user.id, postId);
      if (!existing) throw new HttpError(404, 'Queue item not found.');
      const body = await readJson(request);
      const timestamp = scheduledTimestamp(body.scheduledAt);
      checkSpacing(user.id, timestamp, postId);
      const updated = updatePost(user.id, postId, {
        scheduledAt: timestamp,
        caption: textValue(body.caption, 'Caption', 2200),
        hashtags: textValue(body.hashtags, 'Hashtags', 500),
      });
      if (!updated) throw new HttpError(409, 'Only queued items can be edited.');
      json(response, 200, postView(updated));
      return;
    }
    if (!action && method === 'DELETE') {
      if (!removePost(user.id, postId)) throw new HttpError(409, 'This queue item cannot be removed in its current state.');
      json(response, 200, { ok: true });
      return;
    }
    if (action === 'send-now' && method === 'POST') {
      const existing = getPostById(user.id, postId);
      if (!existing) throw new HttpError(404, 'Queue item not found.');
      checkSpacing(user.id, Date.now(), postId);
      const updated = sendPostNow(user.id, postId, Date.now());
      if (!updated) throw new HttpError(409, 'Only queued items can be sent now.');
      json(response, 200, postView(updated));
      return;
    }
    if (action === 'retry' && method === 'POST') {
      const existing = getPostById(user.id, postId);
      if (!existing) throw new HttpError(404, 'Queue item not found.');
      if (!existing.retry_allowed || existing.publish_id) {
        throw new HttpError(409, 'This item cannot be retried. TikTok-processed items are never resent.');
      }
      checkSpacing(user.id, Date.now(), postId);
      const updated = retryPost(user.id, postId);
      if (!updated) throw new HttpError(409, 'This item is not eligible to retry.');
      json(response, 200, postView(updated));
      return;
    }
    if (action === 'mark-posted' && method === 'POST') {
      const updated = markPostPosted(user.id, postId);
      if (!updated) throw new HttpError(409, 'Only a draft sent to TikTok can be marked posted.');
      json(response, 200, postView(updated));
      return;
    }
  }

  if (pathname === '/api/settings' && method === 'GET') {
    json(response, 200, getSettings(user.id));
    return;
  }
  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readJson(request);
    let settings;
    try { settings = validateSettings(body, config.minSpacingHours); }
    catch (error) { throw new HttpError(400, error.message); }
    json(response, 200, saveSettings(user.id, settings));
    return;
  }

  if (pathname === '/api/schedule/suggest' && method === 'GET') {
    const settings = getSettings(user.id);
    const existingTimes = listPosts(user.id)
      .filter(item => ['queued', 'sending', 'sent_to_drafts', 'posted'].includes(item.status))
      .map(item => ['sent_to_drafts', 'posted'].includes(item.status)
        ? item.sent_to_drafts_at
        : item.scheduled_at)
      .filter(Number.isFinite);
    const scheduledAt = generateSlots(settings, Date.now(), 1, existingTimes)[0];
    if (!scheduledAt) throw new HttpError(409, 'No available time was found in the next year.');
    const performanceHours = settings.bestHours?.tiktok || [];
    const reason = performanceHours.length
      ? `Based on your saved TikTok performance hours (${performanceHours.map(hour => `${String(hour).padStart(2, '0')}:00`).join(', ')}), with a small minute shift and 20-hour spacing.`
      : 'Based on a sensible TikTok posting window, with a small minute shift and 20-hour spacing.';
    json(response, 200, { scheduledAt: new Date(scheduledAt).toISOString(), reason });
    return;
  }

  if (pathname === '/api/schedule/fill' && method === 'POST') {
    const settings = getSettings(user.id);
    const queuedIds = new Set(queuedMediaIds(user.id));
    const available = listMedia(user.id).filter(item => !queuedIds.has(item.id));
    if (!available.length) {
      json(response, 200, { created: [] });
      return;
    }
    const existingTimes = listPosts(user.id)
      .filter(item => ['queued', 'sending', 'sent_to_drafts', 'posted'].includes(item.status))
      .map(item => ['sent_to_drafts', 'posted'].includes(item.status) ? item.sent_to_drafts_at : item.scheduled_at)
      .filter(Number.isFinite);
    const slots = generateSlots(settings, Date.now() + 30_000, available.length, existingTimes);
    const created = [];
    for (let index = 0; index < slots.length; index += 1) {
      const media = available[index];
      checkSpacing(user.id, slots[index]);
      const post = createPost(user.id, media.id, {
        scheduledAt: slots[index],
        caption: media.caption,
        hashtags: media.hashtags,
      });
      created.push(postView(post));
    }
    json(response, 200, { created });
    return;
  }

  throw new HttpError(404, 'API route not found.');
}

async function handleRequest(request, response) {
  setSecurityHeaders(response);
  const rawUrl = request.url || '/';
  let url;
  try { url = new URL(rawUrl, config.appBaseUrl); }
  catch { throw new HttpError(400, 'Invalid request URL.'); }
  const pathname = url.pathname;

  if (pathname === '/healthz' && request.method === 'GET') {
    json(response, 200, { ok: true });
    return;
  }
  if (pathname === '/app') {
    redirect(response, '/app/');
    return;
  }
  if (pathname === '/auth/tiktok/start' && request.method === 'GET') {
    await handleOAuthStart(response);
    return;
  }
  if (pathname === '/auth/tiktok/callback' && request.method === 'GET') {
    await handleOAuthCallback(request, response, url);
    return;
  }
  if (pathname === '/mcp') {
    await handleMcp(request, response);
    return;
  }
  if (pathname.startsWith('/api/')) {
    await handleApi(request, response, url);
    return;
  }
  await serveStatic(pathname, request, response);
}

export function createApplicationServer() {
  return createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const result = formatApiError(error);
      if (error?.status === 500) {
        console.error('Final Cog request failed.', error?.name || 'Error');
      }
      if ((request.url || '').startsWith('/api/') || (request.url || '').startsWith('/mcp')) {
        json(response, result.status, { error: result.message });
      } else if (error instanceof HttpError && error.status === 404) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      } else {
        sendHtmlMessage(response, result.status === 404 ? 'Not found' : 'Final Cog could not open this page', result.message, result.status);
      }
    });
  });
}

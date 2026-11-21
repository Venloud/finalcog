import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { config, getConfigProblems } from './config.mjs';
import {
  addOAuthState,
  consumeOAuthState,
  createPost,
  db,
  deleteMedia,
  disconnectUser,
  findSpacingConflicts,
  getMediaById,
  getPostById,
  getSettings,
  insertMedia,
  listMedia,
  listPosts,
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

const root = process.cwd();
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
    "default-src 'self'; img-src 'self' https://images.pexels.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self' https://open.tiktokapis.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  );
}

function requireAuthenticated(request) {
  const session = getRequestSession(request);
  if (!session?.user?.access_token_enc || !session.user.refresh_token_enc) {
    throw new HttpError(401, 'Sign in with TikTok to use this workspace.');
  }
  return session.user;
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

function mediaView(row) {
  let captionVariants = {};
  try { captionVariants = JSON.parse(row.caption_variants || '{}'); } catch { captionVariants = {}; }
  return {
    id: row.id,
    filename: row.original_filename || row.filename,
    size: row.size,
    mimeType: row.mime_type,
    caption: row.caption,
    hashtags: row.hashtags,
    captionVariants,
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
    sendHtmlMessage(response, 'TikTok sign-in failed', 'Check the TikTok app scopes and local .env values, then try again.', 502);
  }
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  const method = request.method || 'GET';
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  if (mutating) requireSameOrigin(request, configOrigin);

  if (pathname === '/api/config' && method === 'GET') {
    const missing = getConfigProblems();
    json(response, 200, { configured: missing.length === 0, missing });
    return;
  }

  if (pathname === '/api/session' && method === 'GET') {
    const session = getRequestSession(request);
    const missing = getConfigProblems();
    const authenticated = Boolean(session?.user?.access_token_enc && session.user.refresh_token_enc);
    json(response, 200, {
      authenticated,
      configured: missing.length === 0,
      missing,
      account: authenticated ? accountView(session.user) : null,
    });
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

  const user = requireAuthenticated(request);

  if (pathname === '/api/queue' && method === 'GET') {
    json(response, 200, listPosts(user.id).map(postView));
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

  if (pathname === '/api/accounts' && method === 'GET') {
    json(response, 200, {
      tiktok: accountView(user),
      youtube: { available: false },
      instagram: { available: false },
      twitch: { available: false },
    });
    return;
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
      if ((request.url || '').startsWith('/api/')) {
        json(response, result.status, { error: result.message });
      } else if (error instanceof HttpError && error.status === 404) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      } else {
        sendHtmlMessage(response, result.status === 404 ? 'Not found' : 'Final Cog could not open this page', result.message, result.status);
      }
    });
  });
}

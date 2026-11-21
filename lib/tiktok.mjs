import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { config, getConfigProblems } from './config.mjs';
import { db, saveRefreshedTokens, updateDisconnectedAfterRefreshFailure } from './database.mjs';
import { decryptToken, encryptToken } from './security.mjs';

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url';
const INBOX_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';
const CHUNK_BYTES = 64 * 1024 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000;

export class TikTokError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'TikTokError';
    this.safeToRetry = Boolean(options.safeToRetry);
  }
}

function providerError(body, status) {
  const error = body?.error;
  const code = String(error?.code || '');
  const message = String(error?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 240);
  return new TikTokError(message || `TikTok returned an error (${status}).`, {
    safeToRetry: false,
    code,
  });
}

async function parseResponse(response) {
  let body;
  try { body = await response.json(); }
  catch { throw new TikTokError(`TikTok returned an unreadable response (${response.status}).`); }
  if (!response.ok || (body?.error?.code && body.error.code !== 'ok')) {
    throw providerError(body, response.status);
  }
  return body;
}

function ensureConfigured() {
  const missing = getConfigProblems();
  if (missing.length) {
    throw new TikTokError(`Local TikTok setup is incomplete. Configure ${missing.join(', ')} in .env.`);
  }
}

export function createAuthorizeUrl(state) {
  ensureConfigured();
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_key', config.clientKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'user.info.basic,video.upload');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

async function postForm(fetchImpl, url, values) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(30000),
  });
  return parseResponse(response);
}

export async function exchangeAuthorizationCode(code, fetchImpl = fetch) {
  ensureConfigured();
  const body = await postForm(fetchImpl, TOKEN_URL, {
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
  });
  const data = body.data || body;
  if (!data.access_token || !data.open_id) {
    throw new TikTokError('TikTok did not return an account token. Check the Login Kit setup and approved scopes.');
  }
  return {
    openId: data.open_id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresIn: data.expires_in,
    refreshExpiresIn: data.refresh_expires_in,
    scopes: data.scope || '',
  };
}

export async function fetchUserProfile(accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(USER_INFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  const body = await parseResponse(response);
  const profile = body?.data?.user || body?.data;
  if (!profile?.open_id) throw new TikTokError('TikTok did not return a profile identifier.');
  return {
    open_id: profile.open_id,
    display_name: profile.display_name || 'TikTok creator',
    username: profile.username || '',
    avatar_url: /^https:\/\//i.test(profile.avatar_url || '') ? profile.avatar_url : '',
  };
}

export function getEncryptedTokenPair(user) {
  return {
    accessToken: decryptToken(user.access_token_enc),
    refreshToken: decryptToken(user.refresh_token_enc),
  };
}

export async function getValidAccessToken(user, fetchImpl = fetch) {
  ensureConfigured();
  if (user.access_token_enc && Number(user.access_expires_at) > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    return decryptToken(user.access_token_enc);
  }

  const refreshToken = decryptToken(user.refresh_token_enc);
  if (!refreshToken) {
    throw new TikTokError('Reconnect your TikTok account before sending more videos.');
  }

  try {
    const body = await postForm(fetchImpl, TOKEN_URL, {
      client_key: config.clientKey,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const data = body.data || body;
    if (!data.access_token) throw new TikTokError('TikTok did not return a refreshed access token.');
    saveRefreshedTokens(user.id, {
      accessTokenEncrypted: encryptToken(data.access_token),
      refreshTokenEncrypted: encryptToken(data.refresh_token || refreshToken),
      expiresIn: data.expires_in,
      refreshExpiresIn: data.refresh_expires_in || Math.max(0, (Number(user.refresh_expires_at) - Date.now()) / 1000),
      scopes: data.scope || user.scopes,
    });
    return data.access_token;
  } catch {
    updateDisconnectedAfterRefreshFailure(user.id);
    throw new TikTokError('TikTok authorization expired. Sign in with TikTok again.');
  }
}

async function apiPostJson(fetchImpl, url, token, body) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return parseResponse(response);
}

export async function initializeInboxUpload({ user, size, fetchImpl = fetch }) {
  const token = await getValidAccessToken(user, fetchImpl);
  const chunkSize = Math.min(CHUNK_BYTES, Math.max(1, size));
  const totalChunkCount = Math.ceil(size / chunkSize);
  const body = await apiPostJson(fetchImpl, INBOX_INIT_URL, token, {
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: size,
      chunk_size: chunkSize,
      total_chunk_count: totalChunkCount,
    },
  });
  const data = body.data || {};
  if (!data.publish_id || !data.upload_url) {
    throw new TikTokError('TikTok did not return an upload ticket. The item needs review and will not be resent automatically.');
  }
  return {
    publishId: data.publish_id,
    uploadUrl: data.upload_url,
    accessToken: token,
    chunkSize,
    totalChunkCount,
  };
}

export async function uploadVideoFile({ uploadUrl, filePath, size, mimeType, chunkSize, fetchImpl = fetch }) {
  for (let part = 0; part < Math.ceil(size / chunkSize); part += 1) {
    const start = part * chunkSize;
    const endExclusive = Math.min(start + chunkSize, size);
    const length = endExclusive - start;
    const stream = createReadStream(filePath, { start, end: endExclusive - 1 });
    const response = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType || 'video/mp4',
        'Content-Length': String(length),
        'Content-Range': `bytes ${start}-${endExclusive - 1}/${size}`,
      },
      body: Readable.toWeb(stream),
      duplex: 'half',
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    if (!response.ok) {
      throw new TikTokError(`TikTok media transfer failed (${response.status}). The item needs review; it will not be resent automatically.`);
    }
  }
}

export async function uploadInboxDraft({ user, post, onInitialized, fetchImpl = fetch }) {
  const initialized = await initializeInboxUpload({ user, size: post.size, fetchImpl });
  // Persist the provider id before transferring bytes. A restart must poll the
  // existing operation instead of initializing a duplicate upload.
  onInitialized(initialized.publishId);
  await uploadVideoFile({
    uploadUrl: initialized.uploadUrl,
    filePath: post.disk_path,
    size: post.size,
    mimeType: post.mime_type,
    chunkSize: initialized.chunkSize,
    fetchImpl,
  });
}

export async function fetchPublishStatus(user, publishId, fetchImpl = fetch) {
  const token = await getValidAccessToken(user, fetchImpl);
  const body = await apiPostJson(fetchImpl, STATUS_URL, token, { publish_id: publishId });
  return body.data || {};
}

export async function revokeTikTokToken(user, fetchImpl = fetch) {
  const tokens = getEncryptedTokenPair(user);
  if (!tokens.accessToken) return;
  try {
    await postForm(fetchImpl, REVOKE_URL, {
      client_key: config.clientKey,
      client_secret: config.clientSecret,
      token: tokens.accessToken,
    });
  } catch {
    // Local tokens are still removed by the caller. The user can also revoke
    // the app from TikTok's connected-app settings if the provider is offline.
  }
}

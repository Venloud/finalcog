import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.mjs';
import { createSession, findSession, deleteSession } from './database.mjs';

const SESSION_COOKIE = 'finalcog_session';
const OAUTH_COOKIE = 'finalcog_oauth_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_TTL_MS = 10 * 60 * 1000;
const encryptionKey = () => Buffer.from(config.encryptionKey, 'base64url');

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function encryptToken(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptToken(value) {
  if (!value) return '';
  const [version, ivEncoded, tagEncoded, encryptedEncoded] = value.split('.');
  if (version !== 'v1' || !ivEncoded || !tagEncoded || !encryptedEncoded) {
    throw new Error('Stored TikTok credentials cannot be decrypted. Reconnect the account.');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivEncoded, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function parseCookies(request) {
  const raw = request.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map(part => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    const key = part.slice(0, index).trim();
    try { return [key, decodeURIComponent(part.slice(index + 1).trim())]; }
    catch { return [key, '']; }
  }).filter(([key]) => key));
}

function cookieAttributes(path, maxAge, sameSite = 'Strict', secure = config.appBaseUrl.startsWith('https:')) {
  return `Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function appendCookie(response, value) {
  const current = response.getHeader('Set-Cookie');
  const values = current ? (Array.isArray(current) ? current : [current]) : [];
  response.setHeader('Set-Cookie', [...values, value]);
}

export function setOAuthCookie(response, state) {
  appendCookie(response, `${OAUTH_COOKIE}=${encodeURIComponent(state)}; ${cookieAttributes('/auth/tiktok', OAUTH_TTL_MS / 1000, 'Lax')}`);
}

export function clearOAuthCookie(response) {
  appendCookie(response, `${OAUTH_COOKIE}=; ${cookieAttributes('/auth/tiktok', 0, 'Lax')}`);
}

export function setSessionCookie(response, token, secure = config.appBaseUrl.startsWith('https:')) {
  appendCookie(response, `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes('/', SESSION_TTL_MS / 1000, 'Strict', secure)}`);
}

export function clearSessionCookie(response, secure = config.appBaseUrl.startsWith('https:')) {
  appendCookie(response, `${SESSION_COOKIE}=; ${cookieAttributes('/', 0, 'Strict', secure)}`);
}

export function startSession(response, userId, secure = config.appBaseUrl.startsWith('https:')) {
  const token = randomToken();
  createSession(userId, sha256(token), Date.now() + SESSION_TTL_MS);
  setSessionCookie(response, token, secure);
}

export function getRequestSession(request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  const user = findSession(token);
  return user ? { token, user } : null;
}

export function endSession(request, response) {
  const token = parseCookies(request)[SESSION_COOKIE];
  deleteSession(token);
  clearSessionCookie(response);
}

export function getOAuthCookie(request) {
  return parseCookies(request)[OAUTH_COOKIE] || '';
}

export function isSameSecret(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const oauthTtlMs = OAUTH_TTL_MS;

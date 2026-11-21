import {
  isSameSecret,
  parseCookies,
  randomToken,
  sha256,
} from './security.mjs';
import { config, isApiTokenConfigured } from './config.mjs';
import { HttpError } from './http.mjs';

const COOKIE_NAME = 'finalcog_api_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

function expireSessions(now = Date.now()) {
  for (const [hash, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(hash);
  }
}

function cookieOptions(maxAge) {
  const secure = config.appBaseUrl.startsWith('https:') ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function authenticateApiToken(token) {
  if (!isApiTokenConfigured()) {
    throw new HttpError(503, 'Set FINALCOG_API_TOKEN in .env to enable the local API.');
  }
  if (!isSameSecret(String(token || ''), config.apiToken)) {
    throw new HttpError(401, 'The local API token is not valid.');
  }
}

export function startApiBrowserSession(token, response) {
  authenticateApiToken(token);
  const sessionToken = randomToken(32);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  expireSessions();
  sessions.set(sha256(sessionToken), expiresAt);
  const secure = config.appBaseUrl.startsWith('https:') ? '; Secure' : '';
  response.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
  );
  return { expiresAt: new Date(expiresAt).toISOString() };
}

export function clearApiBrowserSession(request, response) {
  const sessionToken = parseCookies(request)[COOKIE_NAME];
  if (sessionToken) sessions.delete(sha256(sessionToken));
  response.setHeader('Set-Cookie', cookieOptions(0));
}

export function hasValidBearerToken(request) {
  if (!isApiTokenConfigured()) return false;
  const match = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return Boolean(match && isSameSecret(match[1], config.apiToken));
}

export function hasApiAccess(request) {
  if (hasValidBearerToken(request)) return true;
  if (!isApiTokenConfigured()) return false;
  const sessionToken = parseCookies(request)[COOKIE_NAME];
  if (!sessionToken) return false;
  const hash = sha256(sessionToken);
  const expiresAt = sessions.get(hash);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(hash);
    return false;
  }
  return true;
}

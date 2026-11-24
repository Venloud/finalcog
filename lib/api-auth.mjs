import { isSameSecret, getRequestSession } from './security.mjs';
import { config } from './config.mjs';
import { HttpError } from './http.mjs';

const COOKIE_NAME = 'finalcog_api_session';

function cookieOptions(maxAge) {
  const secure = config.appBaseUrl.startsWith('https:') ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function authenticateApiToken(token) {
  if (!isSameSecret(String(token || ''), config.apiToken)) {
    throw new HttpError(401, 'The local API token is not valid.');
  }
}

export function clearApiBrowserSession(request, response) {
  response.setHeader('Set-Cookie', cookieOptions(0));
}

export function hasValidBearerToken(request) {
  const match = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return Boolean(match && isSameSecret(match[1], config.apiToken));
}

export function hasApiAccess(request) {
  if (hasValidBearerToken(request)) return true;
  return Boolean(getRequestSession(request));
}

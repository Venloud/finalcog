import dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config();

function parsePort(value) {
  const port = Number(value || 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port.');
  }
  return port;
}

function parseBaseUrl(value, port) {
  const url = new URL(value || `http://localhost:${port}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('APP_BASE_URL must be an origin such as http://localhost:5000.');
  }
  return url.origin;
}

const port = parsePort(process.env.PORT);
const appBaseUrl = parseBaseUrl(process.env.APP_BASE_URL, port);
const redirectUri = process.env.TIKTOK_REDIRECT_URI || 'https://venloud.github.io/finalcog/tiktok-callback.html';
const redirectUrl = new URL(redirectUri);
if (redirectUrl.protocol !== 'https:' || redirectUrl.search || redirectUrl.hash) {
  throw new Error('TIKTOK_REDIRECT_URI must be a registered HTTPS URL without query or fragment.');
}

const uploadLimitMb = Number(process.env.MAX_UPLOAD_MB || 1024);
if (!Number.isInteger(uploadLimitMb) || uploadLimitMb < 1 || uploadLimitMb > 4096) {
  throw new Error('MAX_UPLOAD_MB must be a whole number between 1 and 4096.');
}

const spacingHours = Number(process.env.MIN_SPACING_HOURS || 3);
if (!Number.isFinite(spacingHours) || spacingHours < 3 || spacingHours > 168) {
  throw new Error('MIN_SPACING_HOURS must be between 3 and 168.');
}

export const config = Object.freeze({
  port,
  host: process.env.HOST || '127.0.0.1',
  appBaseUrl,
  redirectUri: redirectUrl.toString(),
  dataDir: resolve(process.cwd(), process.env.DATA_DIR || './data'),
  maxUploadBytes: uploadLimitMb * 1024 * 1024,
  minSpacingHours: spacingHours,
  clientKey: process.env.TIKTOK_CLIENT_KEY || '',
  clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
  sessionSecret: process.env.SESSION_SECRET || '',
});

export function getConfigProblems() {
  const missing = [];
  if (!config.clientKey) missing.push('TIKTOK_CLIENT_KEY');
  if (!config.clientSecret) missing.push('TIKTOK_CLIENT_SECRET');
  if (config.sessionSecret.length < 32) missing.push('SESSION_SECRET (use at least 32 characters)');
  return missing;
}

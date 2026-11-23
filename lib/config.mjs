import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLocalSecrets, initializeCredentialStore, getLocalCredential } from './local-secrets.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(projectRoot, '.env') });
const dataDir = resolve(process.cwd(), process.env.DATA_DIR || './data');
const localSecrets = ensureLocalSecrets(dataDir);
initializeCredentialStore(dataDir, localSecrets);

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

const spacingHours = Number(process.env.MIN_SPACING_HOURS || 20);
if (!Number.isFinite(spacingHours) || spacingHours < 20 || spacingHours > 168) {
  throw new Error('MIN_SPACING_HOURS must be between 20 and 168.');
}

export const config = Object.freeze({
  port,
  host: '127.0.0.1',
  appBaseUrl,
  redirectUri: redirectUrl.toString(),
  dataDir,
  maxUploadBytes: uploadLimitMb * 1024 * 1024,
  minSpacingHours: spacingHours,
  apiToken: process.env.FINALCOG_API_TOKEN || localSecrets.apiToken,
  githubToken: process.env.GITHUB_TOKEN || '',
  sessionSecret: process.env.SESSION_SECRET || localSecrets.sessionSecret,
  encryptionKey: localSecrets.encryptionKey,
});

export function getTikTokCredentials() {
  return {
    clientKey: process.env.TIKTOK_CLIENT_KEY || getLocalCredential('tiktok_client_key'),
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || getLocalCredential('tiktok_client_secret'),
  };
}

export function getConfigProblems() {
  const missing = [];
  const credentials = getTikTokCredentials();
  if (!credentials.clientKey) missing.push('TIKTOK_CLIENT_KEY');
  if (!credentials.clientSecret) missing.push('TIKTOK_CLIENT_SECRET');
  return missing;
}

export function isApiTokenConfigured() {
  return true;
}

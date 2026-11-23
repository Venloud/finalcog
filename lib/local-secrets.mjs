import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const SECRET_FILE = 'local-secrets.json';
const CREDENTIAL_FILE = 'credentials.enc';

function writePrivateFile(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function ensureLocalSecrets(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { chmodSync(dataDir, 0o700); } catch {}
  const path = resolve(dataDir, SECRET_FILE);
  let values;
  try {
    values = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    values = {};
  }
  for (const name of ['encryptionKey', 'apiToken', 'sessionSecret']) {
    if (typeof values[name] !== 'string' || values[name].length < 32) {
      values[name] = randomBytes(32).toString('base64url');
    }
  }
  writePrivateFile(path, `${JSON.stringify(values)}\n`);
  return Object.freeze(values);
}

let activeDataDir;
let activeSecrets;

export function initializeCredentialStore(dataDir, secrets) {
  activeDataDir = dataDir;
  activeSecrets = secrets;
}

function keyBuffer() {
  if (!activeSecrets?.encryptionKey) throw new Error('The local credential store is not initialized.');
  return Buffer.from(activeSecrets.encryptionKey, 'base64url');
}

function readCredentials() {
  if (!activeDataDir) throw new Error('The local credential store is not initialized.');
  try {
    const [version, ivPart, tagPart, encryptedPart] =
      readFileSync(resolve(activeDataDir, CREDENTIAL_FILE), 'utf8').trim().split('.');
    if (version !== 'v1' || !ivPart || !tagPart || !encryptedPart) throw new Error('Invalid credential store.');
    const decipher = createDecipheriv('aes-256-gcm', keyBuffer(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encryptedPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plain);
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error('Saved local credentials could not be unlocked. Keep the local key file with your data folder.');
  }
}

function writeCredentials(values) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(values), 'utf8'),
    cipher.final(),
  ]);
  const contents = [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
  writePrivateFile(resolve(activeDataDir, CREDENTIAL_FILE), `${contents}\n`);
}

export function getLocalCredential(name) {
  return readCredentials()[name] || '';
}

export function saveLocalCredential(name, value) {
  const values = readCredentials();
  if (value) values[name] = value;
  else delete values[name];
  writeCredentials(values);
}

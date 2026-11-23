import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.mjs';

mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(resolve(config.dataDir, 'finalcog.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    open_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    access_token_enc TEXT,
    refresh_token_enc TEXT,
    access_expires_at INTEGER,
    refresh_expires_at INTEGER,
    scopes TEXT NOT NULL DEFAULT '',
    connected_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    disk_path TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    hashtags TEXT NOT NULL DEFAULT '',
    caption_variants TEXT NOT NULL DEFAULT '{}',
    platforms TEXT NOT NULL DEFAULT '["tiktok"]',
    source_json TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS media_user_created_idx ON media(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    scheduled_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'sending', 'sent_to_drafts', 'posted', 'failed', 'needs_review')),
    caption TEXT NOT NULL DEFAULT '',
    hashtags TEXT NOT NULL DEFAULT '',
    publish_id TEXT,
    error_reason TEXT,
    retry_allowed INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    upload_started_at INTEGER,
    next_check_at INTEGER,
    sent_to_drafts_at INTEGER,
    posted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS posts_queue_idx ON posts(status, scheduled_at);
  CREATE INDEX IF NOT EXISTS posts_user_schedule_idx ON posts(user_id, scheduled_at);
  CREATE UNIQUE INDEX IF NOT EXISTS posts_publish_id_idx ON posts(publish_id) WHERE publish_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    posts_per_week INTEGER NOT NULL DEFAULT 7,
    active_days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
    preferred_times TEXT NOT NULL DEFAULT '["10:00","15:00"]',
    min_spacing_hours INTEGER NOT NULL DEFAULT 20,
    best_hours TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
`);

const mediaColumns = new Set(db.prepare('PRAGMA table_info(media)').all().map(column => column.name));
if (!mediaColumns.has('source_json')) {
  db.exec("ALTER TABLE media ADD COLUMN source_json TEXT NOT NULL DEFAULT ''");
}
if (!mediaColumns.has('platforms')) {
  db.exec("ALTER TABLE media ADD COLUMN platforms TEXT NOT NULL DEFAULT '[\"tiktok\"]'");
}
const settingsColumns = new Set(db.prepare('PRAGMA table_info(settings)').all().map(column => column.name));
if (!settingsColumns.has('best_hours')) {
  db.exec("ALTER TABLE settings ADD COLUMN best_hours TEXT NOT NULL DEFAULT '{}'");
}
db.exec("UPDATE settings SET min_spacing_hours = 20 WHERE min_spacing_hours < 20");

const now = () => Date.now();
const hash = value => createHash('sha256').update(value).digest('hex');

export function ensureLocalWorkspaceUser() {
  const existing = db.prepare('SELECT * FROM users ORDER BY created_at ASC LIMIT 1').get();
  if (existing) return existing;
  const timestamp = now();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO users (id, open_id, created_at, updated_at)
    VALUES (?, 'local-workspace', ?, ?)
  `).run(id, timestamp, timestamp);
  db.prepare('INSERT INTO settings (user_id, updated_at) VALUES (?, ?)').run(id, timestamp);
  return userById(id);
}

export function userByOpenId(openId) {
  return db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);
}

export function userById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function connectedUsers() {
  return db.prepare(`
    SELECT * FROM users
    WHERE access_token_enc IS NOT NULL AND refresh_token_enc IS NOT NULL
    ORDER BY connected_at DESC
  `).all();
}

export function saveTikTokUser(profile, tokens) {
  const timestamp = now();
  const existing = userByOpenId(profile.open_id);
  if (existing) {
    db.prepare(`
      UPDATE users SET display_name = ?, username = ?, avatar_url = ?,
        access_token_enc = ?, refresh_token_enc = ?, access_expires_at = ?,
        refresh_expires_at = ?, scopes = ?, connected_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      profile.display_name || '',
      profile.username || '',
      profile.avatar_url || '',
      tokens.accessTokenEncrypted,
      tokens.refreshTokenEncrypted,
      timestamp + Number(tokens.expiresIn || 0) * 1000,
      timestamp + Number(tokens.refreshExpiresIn || 0) * 1000,
      tokens.scopes || '',
      timestamp,
      timestamp,
      existing.id,
    );
    return userById(existing.id);
  }

  const localWorkspace = db.prepare(`
    SELECT * FROM users WHERE open_id = 'local-workspace'
      AND access_token_enc IS NULL ORDER BY created_at ASC LIMIT 1
  `).get();
  if (localWorkspace) {
    db.prepare(`
      UPDATE users SET open_id = ?, display_name = ?, username = ?, avatar_url = ?,
        access_token_enc = ?, refresh_token_enc = ?, access_expires_at = ?,
        refresh_expires_at = ?, scopes = ?, connected_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      profile.open_id,
      profile.display_name || '',
      profile.username || '',
      profile.avatar_url || '',
      tokens.accessTokenEncrypted,
      tokens.refreshTokenEncrypted,
      timestamp + Number(tokens.expiresIn || 0) * 1000,
      timestamp + Number(tokens.refreshExpiresIn || 0) * 1000,
      tokens.scopes || '',
      timestamp,
      timestamp,
      localWorkspace.id,
    );
    return userById(localWorkspace.id);
  }

  const id = randomUUID();
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO users
        (id, open_id, display_name, username, avatar_url, access_token_enc,
         refresh_token_enc, access_expires_at, refresh_expires_at, scopes,
         connected_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      profile.open_id,
      profile.display_name || '',
      profile.username || '',
      profile.avatar_url || '',
      tokens.accessTokenEncrypted,
      tokens.refreshTokenEncrypted,
      timestamp + Number(tokens.expiresIn || 0) * 1000,
      timestamp + Number(tokens.refreshExpiresIn || 0) * 1000,
      tokens.scopes || '',
      timestamp,
      timestamp,
      timestamp,
    );
    db.prepare('INSERT INTO settings (user_id, updated_at) VALUES (?, ?)').run(id, timestamp);
  });
  transaction();
  return userById(id);
}

export function saveRefreshedTokens(userId, tokens) {
  const timestamp = now();
  db.prepare(`
    UPDATE users SET access_token_enc = ?, refresh_token_enc = ?,
      access_expires_at = ?, refresh_expires_at = ?, scopes = ?, updated_at = ?
    WHERE id = ?
  `).run(
    tokens.accessTokenEncrypted,
    tokens.refreshTokenEncrypted,
    timestamp + Number(tokens.expiresIn || 0) * 1000,
    timestamp + Number(tokens.refreshExpiresIn || 0) * 1000,
    tokens.scopes || '',
    timestamp,
    userId,
  );
}

export function disconnectUser(userId) {
  const timestamp = now();
  db.prepare(`
    UPDATE users SET access_token_enc = NULL, refresh_token_enc = NULL,
      access_expires_at = NULL, refresh_expires_at = NULL, scopes = '',
      updated_at = ? WHERE id = ?
  `).run(timestamp, userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function addOAuthState(stateHash, expiresAt) {
  db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now());
  db.prepare('INSERT INTO oauth_states (state_hash, expires_at, created_at) VALUES (?, ?, ?)').run(stateHash, expiresAt, now());
}

export function consumeOAuthState(stateHash) {
  const row = db.prepare('SELECT state_hash, expires_at FROM oauth_states WHERE state_hash = ?').get(stateHash);
  if (!row || row.expires_at <= now()) {
    if (row) db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(stateHash);
    return false;
  }
  db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(stateHash);
  return true;
}

export function createSession(userId, tokenHash, expiresAt) {
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(tokenHash, userId, expiresAt, now());
}

export function findSession(token) {
  if (!token) return null;
  const tokenHash = hash(token);
  const row = db.prepare(`
    SELECT sessions.user_id, sessions.expires_at, users.*
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(tokenHash);
  if (!row) return null;
  if (row.expires_at <= now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return row;
}

export function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
}

export function getSettings(userId) {
  const row = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId);
  if (!row) return defaultSettings();
  let bestHours = {};
  try { bestHours = JSON.parse(row.best_hours || '{}'); } catch {}
  return {
    timezone: row.timezone,
    postsPerWeek: row.posts_per_week,
    activeDays: JSON.parse(row.active_days),
    preferredTimes: JSON.parse(row.preferred_times),
    minSpacingHours: Math.max(20, row.min_spacing_hours),
    bestHours,
  };
}

export function saveSettings(userId, settings) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO settings (user_id, timezone, posts_per_week, active_days,
      preferred_times, min_spacing_hours, best_hours, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone,
      posts_per_week = excluded.posts_per_week, active_days = excluded.active_days,
      preferred_times = excluded.preferred_times,
      min_spacing_hours = excluded.min_spacing_hours, best_hours = excluded.best_hours,
      updated_at = excluded.updated_at
  `).run(
    userId,
    settings.timezone,
    settings.postsPerWeek,
    JSON.stringify(settings.activeDays),
    JSON.stringify(settings.preferredTimes),
    Math.max(20, settings.minSpacingHours),
    JSON.stringify(settings.bestHours || {}),
    timestamp,
  );
  return getSettings(userId);
}

export function defaultSettings() {
  return {
    timezone: 'UTC',
    postsPerWeek: 7,
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    preferredTimes: ['10:00', '15:00'],
    minSpacingHours: config.minSpacingHours,
    bestHours: {},
  };
}

export function getMediaById(userId, mediaId) {
  return db.prepare('SELECT * FROM media WHERE user_id = ? AND id = ?').get(userId, mediaId);
}

export function listMedia(userId) {
  return db.prepare('SELECT * FROM media WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

export function insertMedia(items) {
  const insert = db.prepare(`
    INSERT INTO media (id, user_id, filename, original_filename, mime_type,
      size, disk_path, caption, hashtags, caption_variants, source_json, created_at)
    VALUES (@id, @userId, @filename, @originalFilename, @mimeType, @size,
      @diskPath, @caption, @hashtags, @captionVariants, @sourceJson, @createdAt)
  `);
  const transaction = db.transaction(rows => rows.forEach(item => insert.run({
    caption: '',
    hashtags: '',
    captionVariants: '{}',
    sourceJson: '',
    ...item,
  })));
  transaction(items);
}

export function updateMedia(userId, mediaId, values) {
  const result = db.prepare(`
    UPDATE media SET caption = ?, hashtags = ?, caption_variants = ?, platforms = ?
    WHERE user_id = ? AND id = ?
  `).run(
    values.caption,
    values.hashtags,
    JSON.stringify(values.captionVariants),
    JSON.stringify(values.platforms || ['tiktok']),
    userId,
    mediaId,
  );
  return result.changes ? getMediaById(userId, mediaId) : null;
}

export function deleteMedia(userId, mediaId) {
  const transaction = db.transaction(() => {
    const media = getMediaById(userId, mediaId);
    if (!media) return null;
    const activePost = db.prepare(`
      SELECT 1 FROM posts WHERE user_id = ? AND media_id = ?
        AND status IN ('queued', 'sending', 'needs_review')
      LIMIT 1
    `).get(userId, mediaId);
    if (activePost) return { conflict: true, media };
    db.prepare('DELETE FROM media WHERE user_id = ? AND id = ?').run(userId, mediaId);
    return { media };
  });
  return transaction();
}

export function listPosts(userId, { from = null, to = null, limit = null } = {}) {
  let sql = `
    SELECT posts.*, media.filename AS filename
    FROM posts JOIN media ON media.id = posts.media_id
    WHERE posts.user_id = ?
  `;
  const params = [userId];
  if (from !== null) { sql += ' AND posts.scheduled_at >= ?'; params.push(from); }
  if (to !== null) { sql += ' AND posts.scheduled_at < ?'; params.push(to); }
  sql += ' ORDER BY posts.scheduled_at ASC, posts.created_at ASC';
  if (Number.isInteger(limit) && limit > 0) { sql += ' LIMIT ?'; params.push(limit); }
  return db.prepare(sql).all(...params);
}

export function listPostsForMedia(userId, mediaId) {
  return db.prepare(`
    SELECT posts.*, media.filename AS filename
    FROM posts JOIN media ON media.id = posts.media_id
    WHERE posts.user_id = ? AND posts.media_id = ?
    ORDER BY posts.created_at DESC
  `).all(userId, mediaId);
}

export function getPostById(userId, postId) {
  return db.prepare(`
    SELECT posts.*, media.filename AS filename
    FROM posts JOIN media ON media.id = posts.media_id
    WHERE posts.user_id = ? AND posts.id = ?
  `).get(userId, postId);
}

export function createPost(userId, mediaId, values) {
  const timestamp = now();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO posts (id, user_id, media_id, scheduled_at, status, caption,
      hashtags, retry_allowed, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?)
  `).run(id, userId, mediaId, values.scheduledAt, values.caption, values.hashtags, timestamp, timestamp);
  return getPostById(userId, id);
}

export function updatePost(userId, postId, values) {
  const timestamp = now();
  const result = db.prepare(`
    UPDATE posts SET scheduled_at = ?, caption = ?, hashtags = ?, updated_at = ?
    WHERE user_id = ? AND id = ? AND status = 'queued'
  `).run(values.scheduledAt, values.caption, values.hashtags, timestamp, userId, postId);
  return result.changes ? getPostById(userId, postId) : null;
}

export function removePost(userId, postId) {
  const result = db.prepare(`
    DELETE FROM posts WHERE user_id = ? AND id = ?
      AND status IN ('queued', 'failed', 'needs_review')
  `).run(userId, postId);
  return result.changes > 0;
}

export function markPostPosted(userId, postId) {
  const timestamp = now();
  const result = db.prepare(`
    UPDATE posts SET status = 'posted', posted_at = ?, updated_at = ?
    WHERE user_id = ? AND id = ? AND status = 'sent_to_drafts'
  `).run(timestamp, timestamp, userId, postId);
  return result.changes ? getPostById(userId, postId) : null;
}

export function retryPost(userId, postId) {
  const timestamp = now();
  const result = db.prepare(`
    UPDATE posts SET status = 'queued', scheduled_at = ?, error_reason = NULL,
      retry_allowed = 0, attempt_count = attempt_count + 1,
      upload_started_at = NULL, next_check_at = NULL, updated_at = ?
    WHERE user_id = ? AND id = ? AND status = 'failed' AND retry_allowed = 1
      AND publish_id IS NULL
  `).run(timestamp, timestamp, userId, postId);
  return result.changes ? getPostById(userId, postId) : null;
}

export function sendPostNow(userId, postId, scheduledAt) {
  const timestamp = now();
  const result = db.prepare(`
    UPDATE posts SET scheduled_at = ?, updated_at = ?
    WHERE user_id = ? AND id = ? AND status = 'queued'
  `).run(scheduledAt, timestamp, userId, postId);
  return result.changes ? getPostById(userId, postId) : null;
}

export function rescheduleClaimedPost(postId, scheduledAt, reason) {
  const timestamp = now();
  return db.prepare(`
    UPDATE posts SET status = 'queued', scheduled_at = ?, error_reason = ?,
      upload_started_at = NULL, next_check_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'sending' AND publish_id IS NULL
  `).run(scheduledAt, reason || null, timestamp, postId).changes > 0;
}

export function countSendingPosts() {
  return db.prepare("SELECT COUNT(*) AS count FROM posts WHERE status = 'sending'").get().count;
}

export function failPostBeforeUpload(postId, reason) {
  updatePostStatus(postId, 'failed', { errorReason: reason, retryAllowed: true });
}

export function findSpacingConflicts(userId, scheduledAt, spacingMs, excludePostId = null) {
  const rows = db.prepare(`
    SELECT id, scheduled_at AS time FROM posts
      WHERE user_id = ? AND status IN ('queued', 'sending')
        AND (? IS NULL OR id != ?)
    UNION ALL
    SELECT id, sent_to_drafts_at AS time FROM posts
      WHERE user_id = ? AND sent_to_drafts_at IS NOT NULL
        AND status IN ('sent_to_drafts', 'posted')
        AND (? IS NULL OR id != ?)
  `).all(userId, excludePostId, excludePostId, userId, excludePostId, excludePostId);
  return rows.find(row => Math.abs(row.time - scheduledAt) < spacingMs) || null;
}

export function queuedMediaIds(userId) {
  return db.prepare(`
    SELECT DISTINCT media_id FROM posts
      WHERE user_id = ? AND status IN ('queued', 'sending', 'sent_to_drafts', 'posted', 'needs_review')
  `).all(userId).map(row => row.media_id);
}

export function claimDuePost(timestamp = now()) {
  const select = db.prepare(`
    SELECT posts.*, media.disk_path, media.mime_type, media.size, media.filename
    FROM posts JOIN media ON media.id = posts.media_id
    WHERE posts.status = 'queued' AND posts.scheduled_at <= ?
    ORDER BY posts.scheduled_at ASC LIMIT 1
  `);
  const update = db.prepare(`
    UPDATE posts SET status = 'sending', upload_started_at = ?, updated_at = ?
    WHERE id = ? AND status = 'queued'
  `);
  const transaction = db.transaction(() => {
    const post = select.get(timestamp);
    if (!post) return null;
    const changed = update.run(timestamp, timestamp, post.id).changes;
    return changed ? { ...post, status: 'sending', upload_started_at: timestamp } : null;
  });
  return transaction();
}

export function setPostPublishId(postId, publishId) {
  const timestamp = now();
  db.prepare(`
    UPDATE posts SET publish_id = ?, next_check_at = ?, updated_at = ?
    WHERE id = ? AND status = 'sending'
  `).run(publishId, timestamp + 5000, timestamp, postId);
}

export function updatePostStatus(postId, status, details = {}) {
  const timestamp = now();
  db.prepare(`
    UPDATE posts SET status = ?, error_reason = ?, retry_allowed = ?,
      next_check_at = ?, sent_to_drafts_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    status,
    details.errorReason || null,
    details.retryAllowed ? 1 : 0,
    details.nextCheckAt ?? null,
    status === 'sent_to_drafts' ? timestamp : null,
    timestamp,
    postId,
  );
}

export function markUploadUncertain(postId, errorReason) {
  updatePostStatus(postId, 'needs_review', { errorReason, retryAllowed: false });
}

export function findPostsToPoll(timestamp = now()) {
  return db.prepare(`
    SELECT posts.*, users.id AS account_user_id
    FROM posts JOIN users ON users.id = posts.user_id
    WHERE posts.status = 'sending' AND posts.publish_id IS NOT NULL
      AND (posts.next_check_at IS NULL OR posts.next_check_at <= ?)
    ORDER BY posts.next_check_at ASC LIMIT 20
  `).all(timestamp);
}

export function deferNextCheck(postId, delayMs = 10000) {
  const timestamp = now();
  db.prepare('UPDATE posts SET next_check_at = ?, updated_at = ? WHERE id = ?').run(timestamp + delayMs, timestamp, postId);
}

export function lastDraftUploadAt(userId) {
  const row = db.prepare(`
    SELECT MAX(sent_to_drafts_at) AS latest FROM posts
      WHERE user_id = ? AND sent_to_drafts_at IS NOT NULL
  `).get(userId);
  return row?.latest || 0;
}

export function updateDisconnectedAfterRefreshFailure(userId) {
  db.prepare('UPDATE users SET access_token_enc = NULL, refresh_token_enc = NULL, updated_at = ? WHERE id = ?').run(now(), userId);
}

export function hashSecret(value) {
  return hash(value);
}

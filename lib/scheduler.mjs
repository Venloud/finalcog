import { existsSync } from 'node:fs';
import { config } from './config.mjs';
import {
  countSendingPosts,
  connectedUsers,
  claimDuePost,
  deferNextCheck,
  failPostBeforeUpload,
  findPostsToPoll,
  getSettings,
  lastDraftUploadAt,
  markUploadUncertain,
  findSpacingConflicts,
  rescheduleClaimedPost,
  setPostPublishId,
  updatePostStatus,
  userById,
  db,
} from './database.mjs';
import { fetchPublishStatus, TikTokError, uploadInboxDraft } from './tiktok.mjs';

const spacingMsFor = userId =>
  Math.max(config.minSpacingHours, getSettings(userId).minSpacingHours) * 60 * 60 * 1000;

export function createScheduler() {
  let timer = null;
  let active = false;
  let stopped = false;
  let currentCycle = Promise.resolve();

  async function pollStatuses() {
    for (const post of findPostsToPoll()) {
      const user = userById(post.user_id);
      if (!user?.access_token_enc) {
        deferNextCheck(post.id, 30000);
        continue;
      }
      try {
        const status = await fetchPublishStatus(user, post.publish_id);
        const value = String(status.status || '').toUpperCase();
        if (value === 'SEND_TO_USER_INBOX') {
          updatePostStatus(post.id, 'sent_to_drafts');
        } else if (value === 'FAILED') {
          const reason = String(status.fail_reason || 'TikTok could not process this inbox upload.').slice(0, 240);
          updatePostStatus(post.id, 'failed', { errorReason: reason, retryAllowed: false });
        } else {
          deferNextCheck(post.id, 10000);
        }
      } catch {
        // Status checks are safe to retry; the video upload itself is not.
        deferNextCheck(post.id, 30000);
      }
    }
  }

  async function processDuePost() {
    if (countSendingPosts() > 0) return;
    // Keep a user's local queue intact until TikTok is connected.
    if (connectedUsers().length === 0) return;
    const post = claimDuePost();
    if (!post) return;

    const user = userById(post.user_id);
    if (!user?.access_token_enc) {
      failPostBeforeUpload(post.id, 'Reconnect TikTok, then retry this item.');
      return;
    }

    const spacingMs = spacingMsFor(user.id);
    const lastSentAt = lastDraftUploadAt(user.id);
    if (lastSentAt && Date.now() - lastSentAt < spacingMs) {
      let nextTime = lastSentAt + spacingMs;
      let conflict;
      while ((conflict = findSpacingConflicts(user.id, nextTime, spacingMs, post.id))) {
        nextTime = conflict.time + spacingMs;
      }
      rescheduleClaimedPost(post.id, nextTime, 'Moved to maintain your minimum spacing.');
      return;
    }

    if (!existsSync(post.disk_path)) {
      failPostBeforeUpload(post.id, 'The local video file is missing. Restore it before retrying.');
      return;
    }

    try {
      await uploadInboxDraft({
        user,
        post,
        onInitialized: publishId => setPostPublishId(post.id, publishId),
      });
      deferNextCheck(post.id, 5000);
    } catch (error) {
      // Once an upload request has been sent, the result may be ambiguous.
      // Never send it again automatically; require review instead.
      const safeReason = error instanceof TikTokError
        ? error.message
        : 'The TikTok request did not complete. Check TikTok before retrying.';
      markUploadUncertain(post.id, safeReason);
    }
  }

  function tick() {
    if (active || stopped) return;
    active = true;
    currentCycle = (async () => {
      try {
        await pollStatuses();
        await processDuePost();
      } catch {
        console.error('Final Cog scheduler cycle failed.');
      } finally {
        active = false;
      }
    })();
    return currentCycle;
  }

  function start() {
    stopped = false;
    // Any item left between claiming and receiving a provider id cannot be
    // retried safely because TikTok may have accepted the init request.
    db.prepare(`
      UPDATE posts SET status = 'needs_review',
        error_reason = 'The server stopped during upload. Check TikTok before retrying.',
        retry_allowed = 0, updated_at = ?
      WHERE status = 'sending' AND publish_id IS NULL
    `).run(Date.now());
    timer = setInterval(tick, 10000);
    timer.unref?.();
    void tick();
  }

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    await currentCycle;
  }

  return { start, stop, tick };
}

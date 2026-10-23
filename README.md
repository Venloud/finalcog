# Final Cog

**Keep the momentum going.**

This repository contains the Final Cog landing page, a TikTok-first batch video publishing product in development. The public site is a static, accessible HTML/CSS/JS design with a technical blueprint conveyor background.

## Current deliverable

- Original landing page, responsive layout
- Every decorative cog follows one absolute scroll angle, including the wordmark O, menu, footer and dialog; scroll backward to reverse rotation
- TikTok-only publishing destination preview with branded cyan accent
- Workflow overview and roadmap FAQ
- Local batch studio, schedule/history, platform preferences, and an honest analytics placeholder
- TikTok destination preview
- Functional early-access email draft link (no email account, mailing list, or fake login)
- Site-specific prelaunch Terms and Privacy pages

The demo studio supports multiple local video previews, captions, batch drafts, and spaced demo schedules. It stores metadata in this browser only; video previews last for the current session. It does not upload video bytes, connect social accounts, automatically publish, or store email addresses. No login backend exists.

## Preview

Open `index.html` locally, or use GitHub Pages (Settings → Pages, deploy `main` from repository root). No build step is needed.

## Important legacy OAuth files

The repository was renamed from `nightfiles` to `finalcog`. The original Night Files landing page is archived verbatim as `legacy-nightfiles.html` and the existing `tiktok-callback.html`, `terms.html`, `privacy.html`, and verification file remain untouched. The old TikTok OAuth redirect URL still references `/nightfiles/tiktok-callback.html`. GitHub Pages does **not** automatically redirect that URL after a repository rename. Register and verify the new callback in TikTok Developer Portal before reconnecting accounts; there is intentionally **no live Connect TikTok button** in the new landing page.

The horror video generator remains a separate repository, `Venloud/horror-shorts`.

## Development follow-ups

1. Secure account system, sessions and domain verification
2. TikTok OAuth with unique state/PKCE, safe server-side code exchange and encrypted secrets
3. Media storage with safe upload validation, draft editing, captions and batching
4. Buffer-inspired weekly auto scheduling, queue state, timezone handling, pause/reorder
5. Durable publisher worker, consent checks, reliable delivery statuses and dedupe
6. TikTok audit and a confirmed real end-to-end publish


## October 23 implementation update

Preserved the existing blueprint landing design and added the earlier homepage workspace controls. `index.html`, `assets/site.css` and `assets/site.js` provide the entry points, platform selection, settings and demo analytics panel. `studio.html`, `assets/studio.css` and `assets/batch.js` reuse the batch demo workspace. `assets/motion.js` maps vertical scroll to positive and opposite cog angles at 0.12 degrees per pixel, updating at most once per animation frame and stopping when scrolling stops. All decorative cogs follow page scrolling. Preview privacy now describes local metadata storage.

Validation: JavaScript syntax and motion behavior checks passed, including backward scrolling, restored positions, negative overscroll, frame batching and reduced motion. The existing batch logic checks cover file selection, captions, scheduling intervals, storage errors and legacy history. This revision has not received a browser visual check. No new workflow, external service or secret is required. Real authentication and publishing remain future work.

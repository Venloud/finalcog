# Final Cog

**Keep the momentum going.**

This repository contains the Final Cog landing page, a TikTok-first batch video publishing product in development. The public site is a static, accessible HTML/CSS/JS design with a technical blueprint conveyor background.

## Current deliverable

- Original landing page, responsive layout
- Scroll-responsive left mechanical cog and working gear navigation
- TikTok-branded cyan accent, optional YouTube/Instagram previews clearly marked *coming soon*
- Workflow overview and roadmap FAQ
- Functional early-access email draft link (no email account, mailing list, or fake login)
- Site-specific prelaunch Terms and Privacy pages

The page **does not** upload, connect TikTok accounts, schedule, automatically post, or store emails yet. No login or early-access subscription backend exists. Do not claim otherwise.

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
6. TikTok audit and a confirmed real end-to-end publish, then YouTube and Instagram

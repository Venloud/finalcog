# Final Cog

**Keep the Momentum Going.**

Final Cog is a prelaunch video publishing and scheduling product. The approved
website is a responsive, static HTML page with a blueprint-inspired mechanical
design. It has no build step or external runtime dependency.

## Website

- The homepage is the self-contained `index.html`.
- The large left gear gradually slides, fades, and is clipped away like a
  curtain as the browser narrows. All visible gears rotate from vertical scroll
  at 0.12 degrees per pixel; selected secondary gears counter-rotate. Scroll
  updates are frame-batched and reduced-motion preferences are respected.
- Platform previews cover TikTok, Instagram, YouTube, and Twitch. They are
  interface previews, not connected publishing integrations.
- Sign-in and email actions open an honest preview dialog. No account is
  created, no email is submitted or stored, and no video is uploaded.
- The current Privacy Policy and Terms of Service are at `privacy.html` and
  `terms.html`. Historical Night Files legal pages are preserved in `legacy/`.

## Run on Replit

Use the **Start application** workflow or run:

```sh
node server.mjs
```

The static preview server listens on port 5000. It serves the homepage, legal
pages, assets, and archived legal pages. No package installation is needed.

## GitHub Pages

The site remains compatible with GitHub Pages deployed from the repository
root. Relative links keep legal pages working under both Replit and
`https://venloud.github.io/finalcog/`.

## Existing legacy integration files

The repository retains prior TikTok callback and verification files for
historical compatibility. They are not connected to the new landing page and
do not mean that account connection or publishing is currently available.
The old TikTok OAuth redirect URL refers to `/nightfiles/tiktok-callback.html`;
GitHub Pages does not automatically redirect that URL after a repository
rename. Verify the callback configuration before relying on any legacy
integration.

The horror video generator remains a separate repository,
`Venloud/horror-shorts`.

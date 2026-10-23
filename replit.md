# Final Cog

## Run on Replit

Click **Run** to start the **Start application** workflow, or run:

```sh
node server.mjs
```

The preview server uses the existing Node.js 20 runtime and listens on
`0.0.0.0:5000`. No package installation, build step, secrets, or external
services are needed. Open `/` for the landing page and `/studio.html` for
the demo workspace.

The original static HTML/CSS/JavaScript structure is unchanged. The server
disables browser caching for development and excludes hidden project files
and internal directories from public access. This is the project's sole
preview workflow; no separate prototype or test server is needed.

## Product boundaries

The studio is a local browser demo, not a live publisher. Draft and schedule
metadata are stored in the browser; selected video previews last only for
the current session. There is no authentication backend, social-account
connection, media upload service, or automatic publishing.

Preserve the legacy OAuth callback and verification files. See README.md
for the existing TikTok redirect warning.

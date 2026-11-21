# Final Cog

**Keep the Momentum Going.**

Final Cog is a local-first video library and scheduling tool for creators. It helps prepare finished videos in batches, keep captions with each file, and send videos to TikTok inbox drafts on a steady schedule. It never auto-posts videos publicly.

## Run locally

Final Cog is a plain Node.js server. The scheduler runs inside that process, so leave it running on the Windows PC that should handle scheduled uploads.

### Requirements

- Node.js 20 or newer
- npm
- A TikTok developer app with Login Kit and Content Posting API enabled for the required scopes

From the project folder:

```powershell
npm install
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env` instead. Edit `.env` with your TikTok app values before starting the server:

```dotenv
PORT=5000
HOST=127.0.0.1
APP_BASE_URL=http://localhost:5000
DATA_DIR=./data
MAX_UPLOAD_MB=1024
MIN_SPACING_HOURS=3
TIKTOK_CLIENT_KEY=your_tiktok_client_key
TIKTOK_CLIENT_SECRET=your_tiktok_client_secret
SESSION_SECRET=replace_with_a_random_secret_at_least_32_characters
TIKTOK_REDIRECT_URI=https://venloud.github.io/finalcog/tiktok-callback.html
```

Generate a session secret in PowerShell with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep `.env` private and out of version control. It is ignored by Git. The `.env.example` file contains names and safe defaults only. The app encrypts TikTok tokens using `SESSION_SECRET`; keep that value stable and private or the saved tokens cannot be decrypted.

Start the server with:

```powershell
npm start
```

Open **http://localhost:5000/** for the marketing site and **http://localhost:5000/app/** for the workspace. The server uses port 5000 by default. It stores SQLite data in `data/finalcog.sqlite` and uploaded video files in `data/uploads/`. Back up the SQLite file and uploads folder together.

To start it when Windows boots, create a Task Scheduler task that runs `npm.cmd` with the argument `start`, with the project folder set as **Start in**. Keep the PC awake and the Node process running for scheduled inbox uploads to happen.

### TikTok setup and callback

In the TikTok developer portal, enable Login Kit and Content Posting API, then request the scopes `user.info.basic` and `video.upload`. Register this HTTPS redirect URI:

**https://venloud.github.io/finalcog/tiktok-callback.html**

TikTok requires an HTTPS web redirect URI, while this first version runs on local HTTP. The existing static callback page is kept in the repository; for Final Cog OAuth state it displays a continue button that sends the one-time response to the local route:

**http://localhost:5000/auth/tiktok/callback**

The callback bridge works in the same browser that started sign-in, with Final Cog running on that computer. The TikTok `client_key` is required in the standard provider authorization redirect; it is read from `.env` and is not embedded in the app's JavaScript. The `client_secret` stays on the server and is never sent to the browser.

TikTok must approve the app, scopes, and Content Posting API permissions before live OAuth or uploads can succeed. This project does not change your TikTok developer app settings.

### What the current app does

- Upload multiple MP4, MOV, WebM, or 3GP files to a local creator library.
- Save a TikTok caption and hashtags per video, plus optional Instagram and YouTube caption variants for later.
- Use queue and calendar views, adjust scheduled times, and fill future slots from the saved rhythm.
- Enforce a minimum three-hour gap between TikTok inbox uploads.
- Send videos only through TikTok's inbox upload flow (`FILE_UPLOAD`) and poll until TikTok reports `SEND_TO_USER_INBOX`.
- Record queued, sending, sent-to-drafts, posted, failed, or needs-review states.
- Never retry a TikTok-processed upload. An uncertain upload is marked **Needs review** instead of being sent again.
- Keep captions in the local app. TikTok's inbox upload endpoint does not attach them to the draft; use **Copy caption** and paste the text into TikTok while reviewing.

YouTube Shorts and Instagram Reels are marked **Coming soon**. Twitch is marked **Coming later**. These integrations do not yet connect or publish.

## Checks

```sh
npm run check
npm test
```

The tests use a temporary SQLite database and mocked provider responses. A real TikTok sign-in and inbox upload require the developer app credentials and permissions in your local `.env`.

## GitHub Pages

The repository root remains a static GitHub Pages site at `https://venloud.github.io/finalcog/`. Its marketing pages and existing TikTok callback file work there. The app's interactive workspace requires the local Node server; GitHub Pages cannot run its SQLite database, filesystem uploads, or scheduler.

## Moving to AWS later

The app uses standard Node.js, environment variables, SQLite, and local files. For a future AWS host, use a durable volume for both `DATA_DIR` and uploaded media, keep `SESSION_SECRET` stable, set `APP_BASE_URL` to the HTTPS app origin, and register the HTTPS server callback in TikTok. Run only one scheduler process until scheduling is coordinated across multiple instances.

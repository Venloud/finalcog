import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);
const SUPPORTED_PLATFORMS = new Map([
  ['tiktok', 'TikTok'],
  ['instagram', 'Instagram Reels'],
  ['youtube', 'YouTube Shorts'],
]);

export async function extractVideoFrames(videoPath, {
  uploadDir,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
} = {}) {
  const realVideo = await import('node:fs/promises').then(({ realpath }) => realpath(videoPath));
  const realUploads = await import('node:fs/promises').then(({ realpath }) => realpath(uploadDir));
  if (!realVideo.startsWith(`${realUploads}${sep}`) || extname(basename(realVideo)).toLowerCase() === '') {
    throw new Error('The video is not in the local upload folder.');
  }
  const metadata = await stat(realVideo);
  if (!metadata.isFile()) throw new Error('The selected video file is not available.');

  const tempDir = await mkdtemp(resolve(tmpdir(), 'finalcog-frames-'));
  try {
    const frames = [];
    for (const [index, second] of [1, 3, 6].entries()) {
      const output = resolve(tempDir, `${randomUUID()}-${index}.jpg`);
      await execFile(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(second),
        '-i', realVideo, '-frames:v', '1', '-vf', 'scale=640:-2',
        '-q:v', '5', '-f', 'image2', output,
      ], { timeout: 35_000, maxBuffer: 1024 * 1024 });
      const image = await readFile(output);
      if (image.length > 2_000_000) throw new Error('A video frame is too large to send for caption drafting.');
      frames.push(image);
    }
    return frames;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Video frame extraction needs FFmpeg installed. The video remains on this computer.');
    }
    if (error?.killed) throw new Error('Video frame extraction timed out. Try a shorter clip.');
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function draftCaptionsWithAnthropic({
  apiKey,
  frames,
  transcript = '',
  platforms = ['tiktok'],
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings > Advanced to enable AI captions.');
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 3) {
    throw new Error('Caption drafting needs one to three video frames.');
  }
  const selected = [...new Set(platforms)].filter(platform => SUPPORTED_PLATFORMS.has(platform));
  if (!selected.length) throw new Error('Choose at least one available platform.');

  const content = frames.flatMap((frame, index) => [
    { type: 'text', text: `Frame ${index + 1} from the video:` },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: Buffer.from(frame).toString('base64'),
      },
    },
  ]);
  content.push({
    type: 'text',
    text: [
      'Draft concise social captions and relevant hashtags based only on the visible video and any transcript supplied.',
      `Platforms: ${selected.map(platform => SUPPORTED_PLATFORMS.get(platform)).join(', ')}.`,
      transcript.trim() ? `User-provided transcript: ${transcript.trim().slice(0, 4000)}` : 'No transcript was provided; do not invent spoken words.',
      'Return only valid JSON with a "captions" object whose keys are platform ids and whose values are { "caption": string, "hashtags": string }.',
      'These are drafts only. The creator must review and edit before use.',
    ].join('\n'),
  });

  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 900,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => {
    throw new Error('Anthropic could not be reached. Your video and key remain local.');
  });
  let body;
  try { body = await response.json(); }
  catch { throw new Error('Anthropic returned an unreadable caption response.'); }
  if (!response.ok) {
    const message = String(body?.error?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 180);
    throw new Error(message || `Anthropic returned HTTP ${response.status}.`);
  }

  const text = (body.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('Anthropic did not return captions in the expected format.');
  }
  const captions = {};
  for (const platform of selected) {
    const value = parsed?.captions?.[platform];
    if (value && typeof value.caption === 'string') {
      captions[platform] = {
        caption: value.caption.slice(0, 2200),
        hashtags: String(value.hashtags || '').slice(0, 500),
      };
    }
  }
  if (!Object.keys(captions).length) throw new Error('No platform captions were returned.');
  return { captions, requiresReview: true, transcriptUsed: Boolean(transcript.trim()) };
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';

export const MCP_TOOL_NAMES = Object.freeze([
  'list_queue',
  'add_video',
  'import_github_artifact',
  'update_caption',
  'schedule_video',
  'reschedule',
  'send_to_tiktok_drafts',
  'get_status',
  'list_accounts',
  'get_settings',
  'set_posting_rhythm',
]);

export function createAgentApi({ baseUrl, token, fetchImpl = fetch }) {
  if (!token || token.length < 32) {
    throw new Error('Set FINALCOG_API_TOKEN in .env before starting the Final Cog MCP server.');
  }
  const root = new URL(baseUrl);
  if (!['http:', 'https:'].includes(root.protocol)) {
    throw new Error('FINALCOG_API_URL must use HTTP or HTTPS.');
  }

  return async function callApi(path, { method = 'GET', body } = {}) {
    const url = new URL(path, root);
    if (url.origin !== root.origin || !url.pathname.startsWith('/api/')) {
      throw new Error('The MCP server only calls Final Cog local API routes.');
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new Error(`Could not reach Final Cog at ${root.origin}. Start the local server with npm start and check FINALCOG_API_URL.`);
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      throw new Error(data?.error || data?.message || `Final Cog API returned HTTP ${response.status}.`);
    }
    return data;
  };
}

function toolResult(value) {
  const text = JSON.stringify(value, null, 2);
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { items: value };
  return { content: [{ type: 'text', text }], structuredContent };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : 'The Final Cog API request failed.';
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function addTool(server, name, title, description, inputSchema, handler, annotations) {
  server.registerTool(name, {
    title,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
      ...annotations,
    },
  }, async input => {
    try {
      return toolResult(await handler(input));
    } catch (error) {
      return toolError(error);
    }
  });
}

export function createFinalCogMcpServer({ baseUrl, token, fetchImpl = fetch } = {}) {
  const callApi = createAgentApi({ baseUrl, token, fetchImpl });
  const server = new McpServer({ name: 'final-cog-mcp-server', version: '1.0.0' });
  const scheduledAt = z.string().datetime({ offset: true }).describe('ISO 8601 date and time with timezone offset; must be in the future.');

  addTool(
    server,
    'list_queue',
    'List scheduled videos',
    'List up to 100 Final Cog queue items with scheduled time, status, caption, and any failure reason. This tool only reads local queue data; publishing is always a TikTok inbox draft, never a public post.',
    z.object({}).strict(),
    async () => callApi('/api/queue?limit=100'),
    { readOnlyHint: true, idempotentHint: true },
  );

  addTool(
    server,
    'add_video',
    'Add a local video',
    'Copy one supported video file into the local Final Cog library from a local file path or a public HTTPS URL. Provide exactly one of filePath or url. This only imports a file; it does not publish or schedule it.',
    z.object({
      filePath: z.string().min(1).max(2048).optional().describe('Path to a local MP4, MOV, WebM, M4V, or 3GP file.'),
      url: z.string().url().optional().describe('Public HTTPS URL to a supported video file.'),
      caption: z.string().max(2200).optional().describe('Optional default TikTok caption.'),
      hashtags: z.string().max(500).optional().describe('Optional hashtags to save with the video.'),
    }).strict(),
    async input => {
      if (Boolean(input.filePath) === Boolean(input.url)) {
        throw new Error('Provide exactly one source: filePath or url.');
      }
      return callApi('/api/videos', {
        method: 'POST',
        body: {
          ...(input.filePath ? { filePath: input.filePath } : { url: input.url }),
          caption: input.caption,
          hashtags: input.hashtags,
        },
      });
    },
    { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  );

  addTool(
    server,
    'import_github_artifact',
    'Import a GitHub video',
    'Download one supported video from a GitHub release asset or a GitHub Actions run artifact ZIP and add it to the Final Cog library. Use releaseUrl, or owner/repo plus tag and optional assetName, or owner/repo plus runId and artifactName. The asset and source metadata are saved locally; this never publishes a video.',
    z.object({
      owner: z.string().max(100).optional().describe('GitHub repository owner.'),
      repo: z.string().max(100).optional().describe('GitHub repository name.'),
      tag: z.string().max(200).optional().describe('Release tag, for example v1.2.0.'),
      assetName: z.string().max(255).optional().describe('Exact video asset file name in the release.'),
      releaseUrl: z.string().url().optional().describe('Direct https://github.com/OWNER/REPO/releases/download/... asset URL.'),
      runId: z.string().max(20).optional().describe('GitHub Actions workflow run ID.'),
      artifactName: z.string().max(255).optional().describe('Exact workflow artifact name; its ZIP must contain one video.'),
    }).strict(),
    async input => callApi('/api/github/import', { method: 'POST', body: input }),
    { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  );

  addTool(
    server,
    'update_caption',
    'Update a video caption',
    'Update the saved caption, hashtags, and optional platform caption variants for a video in the local library. This does not publish or reschedule the video.',
    z.object({
      videoId: z.string().min(1).max(80).describe('Final Cog library video ID.'),
      caption: z.string().max(2200).describe('New default TikTok caption.'),
      hashtags: z.string().max(500).optional().describe('New hashtags.'),
      captionVariants: z.object({
        tiktok: z.string().max(2200).optional(),
        instagram: z.string().max(2200).optional(),
        youtube: z.string().max(2200).optional(),
      }).strict().optional().describe('Optional caption variants for TikTok, Instagram Reels, and YouTube Shorts.'),
    }).strict(),
    async input => callApi(`/api/videos/${encodeURIComponent(input.videoId)}`, {
      method: 'PATCH',
      body: { caption: input.caption, hashtags: input.hashtags || '', captionVariants: input.captionVariants || {} },
    }),
    { idempotentHint: true },
  );

  addTool(
    server,
    'schedule_video',
    'Schedule a video',
    'Create a queue item for a library video at a future time. The server enforces minimum spacing and prevents sending the same processed or flagged video again. When due, Final Cog sends it only to TikTok inbox drafts; it never publishes publicly.',
    z.object({
      videoId: z.string().min(1).max(80).describe('Final Cog library video ID.'),
      scheduledAt,
      caption: z.string().max(2200).optional().describe('Optional caption override for this queue item.'),
      hashtags: z.string().max(500).optional().describe('Optional hashtag override.'),
    }).strict(),
    async input => callApi(`/api/videos/${encodeURIComponent(input.videoId)}/schedule`, {
      method: 'POST',
      body: { scheduledAt: input.scheduledAt, caption: input.caption, hashtags: input.hashtags },
    }),
    { idempotentHint: false },
  );

  addTool(
    server,
    'reschedule',
    'Reschedule a queued video',
    'Move an existing queued item to a future time. The server checks TikTok pacing and refuses edits to items that have already started sending or were processed by TikTok. It never posts publicly.',
    z.object({
      queueId: z.string().min(1).max(80).describe('Final Cog queue item ID.'),
      scheduledAt,
      caption: z.string().max(2200).optional(),
      hashtags: z.string().max(500).optional(),
    }).strict(),
    async input => callApi(`/api/queue/${encodeURIComponent(input.queueId)}`, {
      method: 'PATCH',
      body: { scheduledAt: input.scheduledAt, caption: input.caption, hashtags: input.hashtags },
    }),
    { idempotentHint: true },
  );

  addTool(
    server,
    'send_to_tiktok_drafts',
    'Queue a TikTok inbox draft',
    'Queue a library video for the next eligible TikTok inbox draft upload. This never posts publicly. Server-side checks enforce minimum pacing and refuse duplicates, previously processed uploads, and flagged or uncertain items; the agent cannot bypass these rules.',
    z.object({
      videoId: z.string().min(1).max(80).describe('Final Cog library video ID.'),
    }).strict(),
    async input => callApi(`/api/videos/${encodeURIComponent(input.videoId)}/send-to-drafts`, {
      method: 'POST',
      body: {},
    }),
    { idempotentHint: false, openWorldHint: true },
  );

  addTool(
    server,
    'get_status',
    'Get video status',
    'Get the latest queue status for a Final Cog library video ID or queue item ID, including scheduled time and the reason for a failure. This tool does not change or publish anything.',
    z.object({
      id: z.string().min(1).max(80).describe('Final Cog library video ID or queue item ID.'),
    }).strict(),
    async input => callApi(`/api/videos/${encodeURIComponent(input.id)}/status`),
    { readOnlyHint: true, idempotentHint: true },
  );

  addTool(
    server,
    'list_accounts',
    'List connected accounts',
    'List connected and planned platform accounts. This only reads account connection status and never changes accounts or publishes content.',
    z.object({}).strict(),
    async () => callApi('/api/accounts'),
    { readOnlyHint: true, idempotentHint: true },
  );

  addTool(
    server,
    'get_settings',
    'Get posting rhythm',
    'Read the saved posting rhythm, timezone, active days, preferred times, and minimum spacing for this creator.',
    z.object({}).strict(),
    async () => callApi('/api/settings'),
    { readOnlyHint: true, idempotentHint: true },
  );

  addTool(
    server,
    'set_posting_rhythm',
    'Set posting rhythm',
    'Save the creator posting rhythm. The API validates schedule values and enforces the configured minimum gap between TikTok inbox uploads. Scheduled videos are drafts only, never public posts.',
    z.object({
      timezone: z.string().min(1).max(80),
      postsPerWeek: z.number().int().min(1).max(21),
      activeDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      preferredTimes: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1).max(8),
      minSpacingHours: z.number().min(3).max(168),
    }).strict(),
    async input => callApi('/api/settings', { method: 'PUT', body: input }),
    { idempotentHint: true },
  );

  return server;
}

export async function connectStdioMcp({ baseUrl, token } = {}) {
  const server = createFinalCogMcpServer({ baseUrl, token });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}

export function createStreamableHttpTransport() {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
}

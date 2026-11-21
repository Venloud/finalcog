import { config } from './lib/config.mjs';
import { connectStdioMcp } from './lib/mcp.mjs';

const baseUrl = process.env.FINALCOG_API_URL || `http://127.0.0.1:${config.port}`;

try {
  await connectStdioMcp({ baseUrl, token: config.apiToken });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Final Cog MCP could not start.');
  process.exitCode = 1;
}

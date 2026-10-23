import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const root = process.cwd();
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};
const publicDirectories = new Set(['assets', 'kindlediron', 'snapchat']);

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://preview').pathname);
    const segments = pathname.split('/').filter(Boolean);
    if (segments.some(segment => segment.startsWith('.')) ||
        (segments.length > 1 && !publicDirectories.has(segments[0]))) {
      response.writeHead(404).end('Not found');
      return;
    }
    let file = resolve(root, ...segments);
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(404).end('Not found');
      return;
    }
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const contentType = types[extname(file)];
    if (!contentType) {
      response.writeHead(404).end('Not found');
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const missing = ['ENOENT', 'ENOTDIR', 'URIError'].includes(error.code || error.name);
    if (!missing) console.error(error);
    response.writeHead(missing ? 404 : 500).end(missing ? 'Not found' : 'Server error');
  }
}).listen(5000, '0.0.0.0', () => {
  console.log('Final Cog preview listening on port 5000');
});

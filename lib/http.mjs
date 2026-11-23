export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

export function redirect(response, location, status = 302) {
  response.writeHead(status, {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  response.end();
}

export async function readJson(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected an object.');
    }
    return value;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

export function requireSameOrigin(request, configuredOrigin) {
  const origin = request.headers.origin;
  if (!origin) throw new HttpError(403, 'This request must come from the local app.');
  let requestOrigin;
  try { requestOrigin = new URL(origin).origin; }
  catch { throw new HttpError(403, 'This request must come from the local app.'); }
  const host = String(request.headers.host || '').trim();
  const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]')
    ? 'http'
    : 'https';
  const sameRequestOrigin = host ? `${protocol}://${host}` : '';
  if (requestOrigin !== configuredOrigin && requestOrigin !== sameRequestOrigin) {
    throw new HttpError(403, 'This request must come from the local app.');
  }
}

export function sendHtmlMessage(response, title, message, status = 400) {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)} | Final Cog</title><body style="margin:0;background:#101417;color:#f1f3f4;font:16px/1.6 system-ui,sans-serif"><main style="max-width:620px;margin:12vh auto;padding:24px"><h1>${escape(title)}</h1><p>${escape(message)}</p><p><a style="color:#f1f3f4" href="/app/">Return to Final Cog</a></p></main></body></html>`;
  const payload = Buffer.from(body);
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(payload);
}

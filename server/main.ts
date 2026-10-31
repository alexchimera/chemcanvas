// Production server: the built app from dist/, plus shared rooms over
// WebSockets. `npm run build && npm start`; PORT and DATA_DIR are optional.
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { attachRooms } from './rooms';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT) || 3000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Files are read and compressed once; the build doesn't change under a running server. */
const cache = new Map<string, { body: Buffer; gzip: Buffer | null; type: string }>();

async function load(file: string) {
  let entry = cache.get(file);
  if (!entry) {
    const body = await readFile(file);
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const gzip = /text|javascript|json|svg/.test(type) && body.length > 1024 ? gzipSync(body) : null;
    entry = { body, gzip, type };
    cache.set(file, entry);
  }
  return entry;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = resolve(ROOT, `.${path}`);
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    // Unknown paths get the app, so links like /?room=… always open it.
    file = join(ROOT, 'index.html');
  }
  try {
    const { body, gzip, type } = await load(file);
    const zipped = gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    res.writeHead(200, {
      'content-type': type,
      // Hashed bundles never change; the page itself is checked every time.
      'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      vary: 'accept-encoding',
      ...(zipped ? { 'content-encoding': 'gzip' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : zipped ? gzip : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

attachRooms(server, { dataDir: process.env.DATA_DIR, log: (msg) => console.log(msg) });
server.listen(PORT, () => console.log(`ChemCanvas listening on port ${PORT}`));

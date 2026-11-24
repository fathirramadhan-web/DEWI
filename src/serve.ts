#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.build');
const PORT = Number(process.env.DEMO_PORT ?? process.argv[3] ?? 5499);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function existingFile(filePath: string): Promise<string | null> {
  const info = await stat(filePath).catch(() => null);
  return info?.isFile() ? filePath : null;
}

function safePath(pathname: string): string {
  const cleaned = normalize(decodeURIComponent(pathname)).replace(
    /^(\.\.[/\\])+/,
    ''
  );
  const candidate = join(ROOT, cleaned);
  return candidate.startsWith(ROOT) ? candidate : ROOT;
}

async function resolveTarget(pathname: string): Promise<string | null> {
  const target = safePath(pathname);
  return (
    (await existingFile(target)) ??
    (await existingFile(join(target, 'index.html'))) ??
    (await existingFile(join(ROOT, 'index.html')))
  );
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  void resolveTarget(url.pathname).then((file) => {
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.endsWith('index.html')
        ? 'no-store'
        : 'public, max-age=31536000, immutable',
    });
    createReadStream(file).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`dewi serving ${ROOT} on 127.0.0.1:${PORT}\n`);
});

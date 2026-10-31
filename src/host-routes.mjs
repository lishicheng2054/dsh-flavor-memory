import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createControlApi } from './character-store.mjs';

const ASSET = resolve(fileURLToPath(new URL('../ui/', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function studioAsset(name) { return readFileSync(resolve(ASSET, name)); }

export function createHostRoutes({ store, profiles, characterId = '' } = {}) {
  const api = createControlApi({ store, profiles });
  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://dsh.internal');
    if (url.pathname.startsWith('/flavor-memory/api/')) return api(req, res, url, { characterId });
    if (['/', '/flavor-memory', '/flavor-memory/'].includes(url.pathname)) {
      res.writeHead(302, { location: '/flavor-memory/studio' }); return res.end();
    }
    if (url.pathname === '/flavor-memory/studio' || url.pathname === '/flavor-memory/studio/') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return res.end(studioAsset('index.html'));
    }
    if (url.pathname === '/flavor-memory/studio.css') {
      res.writeHead(200, { 'content-type': MIME['.css'], 'cache-control': 'no-store', ...SECURITY_HEADERS }); return res.end(studioAsset('styles.css'));
    }
    if (url.pathname === '/flavor-memory/studio.js') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store', ...SECURITY_HEADERS }); return res.end(studioAsset('app.js'));
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found');
  };
}


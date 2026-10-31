import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createProfileStore, createControlApi, resolveProfilesFile } from './character-store.mjs';
import { createStore } from './gateway.mjs';
import { createHostRoutes } from './host-routes.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export function createStudioServer({
  profilesFile = resolveProfilesFile(), dataFile = ':memory:', token = '', host = '127.0.0.1', port = 8790,
  profileStore = null, characterId = '',
} = {}) {
  const store = createStore({ root: dataFile });
  const profiles = profileStore || createProfileStore({ file: profilesFile });
  const handled = createHostRoutes({ store, profiles, characterId });
  const server = createServer(async (req, res) => {
    try {
      await handled(req, res);
    } catch (error) {
      const status = Number(error.statusCode) || 400;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  return {
    server, store, profiles,
    start() {
      return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolvePromise(server.address()));
      });
    },
    async close() {
      await new Promise(resolvePromise => server.close(() => resolvePromise()));
      store.close();
    },
  };
}

async function main() {
  const port = Number(process.env.STUDIO_PORT || 8790);
  const studio = createStudioServer({
    profilesFile: process.env.PROFILES_FILE || resolveProfilesFile(),
    dataFile: process.env.DATA_FILE || ':memory:',
    token: process.env.STUDIO_TOKEN || '', port,
    characterId: process.env.CHARACTER_ID || '',
  });
  const address = await studio.start();
  console.log(`flavor-memory studio: http://127.0.0.1:${address.port}/flavor-memory/studio`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

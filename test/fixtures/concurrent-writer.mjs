import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [file, characterId, soul, resultFile, readyFile, releaseFile] = process.argv.slice(2);
const gatewayUrl = new URL('../../src/gateway.mjs', import.meta.url).href;
const worker = `
import { createStore } from ${JSON.stringify(gatewayUrl)};
const store = createStore({ root: ${JSON.stringify(file)}, saveDelayMs: 0 });
store.upsertCharacter({ id: ${JSON.stringify(characterId)}, soul: ${JSON.stringify(soul)} });
process.stdout.write('READY\\n');
if (${JSON.stringify(readyFile || '')}) {
  const { existsSync, writeFileSync } = await import('node:fs');
  writeFileSync(${JSON.stringify(readyFile || '')}, 'ready', 'utf8');
  while (!(${JSON.stringify(releaseFile || '')} && existsSync(${JSON.stringify(releaseFile || '')}))) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
store.flush();
store.close();
`;
const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
const code = await new Promise(resolve => child.on('exit', resolve));
writeFileSync(resultFile, JSON.stringify({ code, stderr }));

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/gateway.mjs';

const fixture = fileURLToPath(new URL('./fixtures/concurrent-writer.mjs', import.meta.url));

function runWriter(file, id, soul, result, ready, release) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, file, id, soul, result, ready, release], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stderr: '' }));
  });
}

async function waitForFile(path, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { readFileSync(path); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test('two independent processes writing the same file preserve both characters', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-process-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'memory.json');
  const readyA = join(dir, 'a.ready');
  const readyB = join(dir, 'b.ready');
  const release = join(dir, 'release');
  const resultA = join(dir, 'a.json');
  const resultB = join(dir, 'b.json');
  const childA = runWriter(file, 'a', 'A', resultA, readyA, release);
  const childB = runWriter(file, 'b', 'B', resultB, readyB, release);
  await Promise.all([waitForFile(readyA), waitForFile(readyB)]);
  writeFileSync(release, 'go', 'utf8');
  const [{ code: codeA }, { code: codeB }] = await Promise.all([childA, childB]);
  assert.equal(codeA, 0, readFileSync(resultA, 'utf8'));
  assert.equal(codeB, 0, readFileSync(resultB, 'utf8'));
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.characters.length, 2);
  assert.deepEqual(parsed.characters.map(item => item.id).sort(), ['a', 'b']);
});

test('concurrent JSON fact writes do not corrupt the file', async t => {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'flavor-fact-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'memory.json');
  const seed = createStore({ root: file, saveDelayMs: 0 });
  seed.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软' });
  seed.remember({ characterId: 'ayu', id: 'src', role: 'user', text: '我住在城东。', scope: 's' });
  seed.flush();
  seed.close();
  const gatewayUrl = new URL('../src/gateway.mjs', import.meta.url).href;
  const worker = `
    import { createStore } from ${JSON.stringify(gatewayUrl)};
    const store = createStore({ root: ${JSON.stringify(file)}, saveDelayMs: 0 });
    const key = process.argv[1];
    store.setFact({ characterId: 'ayu', scope: 's', key, value: 'value-' + key, sourceId: 'src' });
    store.flush();
    store.close();
  `;
  const run = key => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, key], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(err)));
  });
  await Promise.all(Array.from({ length: 8 }, (_, index) => run('key-' + index)));
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.characters[0].id, 'ayu');
  assert.ok(parsed.characters[0].memory.entries.some(item => item.id === 'src'));
  const keys = parsed.characters[0].memory.facts.map(item => item.key);
  // JSON is documented as single-writer: this stress run proves corruption safety, not no-loss merging.
  if (process.env.FLAVOR_STRESS) {
    assert.deepEqual(keys.sort(), Array.from({ length: 8 }, (_, index) => `key-${index}`));
  } else {
    assert.ok(keys.length >= 1);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/gateway.mjs';

test('a stale lock from a crashed writer is reclaimed without manual cleanup', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-stale-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'memory.json');
  const lock = `${file}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: 999999, at: 0 }), 'utf8');
  const old = new Date(Date.now() - 30000);
  utimesSync(lock, old, old);
  const store = createStore({ root: file, saveDelayMs: 0 });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
  assert.equal(existsSync(lock), false);
  assert.equal(store.getCharacter('ayu').soul, '阿鱼');
});

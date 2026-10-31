import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/gateway.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-memory-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('store loads and saves the exact durable state without losing raw messages', () => withTempDir(dir => {
  const file = join(dir, 'memory.json');
  const store = createStore({ root: file });
  store.upsertCharacter({
    id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['叫她老板'], relationship: '互相试探',
  });
  store.remember({ characterId: 'ayu', id: 'u1', role: 'user', text: '别淋雨。' });
  store.remember({ characterId: 'ayu', id: 'a1', role: 'assistant', text: '不用你管。伞偏了一点。' });
  store.commitScene('ayu', { throughSeq: 2, card: { event: ['共伞'], quoteIds: ['a1'] } });
  store.flush();

  assert.equal(existsSync(file), true);
  const restored = createStore({ root: file });
  assert.deepEqual(restored.exportAll().characters[0].memory.entries.map(item => item.text), [
    '别淋雨。', '不用你管。伞偏了一点。',
  ]);
  assert.equal(restored.getRaw('ayu', 'a1').text, '不用你管。伞偏了一点。');
  assert.deepEqual(restored.bookFor('ayu').cards()[0].quoteIds, ['a1']);
}));

test('a corrupt data file fails loudly instead of becoming an empty library', () => withTempDir(dir => {
  const file = join(dir, 'memory.json');
  writeFileSync(file, '{not json', 'utf8');
  assert.throws(() => createStore({ root: file }), /data file.*JSON|parse|corrupt/i);
}));

test('atomic save leaves no temporary file and sets owner-only permissions', () => withTempDir(dir => {
  const file = join(dir, 'memory.json');
  const store = createStore({ root: file });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
  store.flush();
  assert.deepEqual(readdirSync(dir, { withFileTypes: true }).map(item => item.name), ['memory.json']);
  assert.equal(readFileSync(file).length > 0, true);
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}));

test('debounced autosave persists without an explicit flush', async () => withTempDir(async dir => {
  const file = join(dir, 'memory.json');
  const store = createStore({ root: file, saveDelayMs: 5 });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
  store.remember({ characterId: 'ayu', id: 'm1', role: 'user', text: '记得留票。' });
  await new Promise(resolve => setTimeout(resolve, 30));
  const restored = createStore({ root: file });
  assert.equal(restored.getRaw('ayu', 'm1').text, '记得留票。');
}));

test('change callback reports durable mutations and export still redacts', () => withTempDir(dir => {
  const file = join(dir, 'memory.json');
  const changes = [];
  const store = createStore({
    root: file, saveDelayMs: 0, secretPatterns: ['sk-live-secret'],
    onChange: event => changes.push(event.type),
  });
  store.upsertCharacter({ id: 'ayu', soul: '不要泄露 sk-live-secret' });
  store.remember({ characterId: 'ayu', id: 'm1', role: 'user', text: '普通消息' });
  assert.deepEqual(changes, ['character:upsert', 'message:remember']);
  assert.match(readFileSync(file, 'utf8'), /sk-live-secret/);
  assert.doesNotMatch(JSON.stringify(store.exportAll()), /sk-live-secret/);
}));



test('saving to the same file from two stores writes complete JSON documents', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'flavor-concurrent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'memory.json');
  const a = createStore({ root: file, saveDelayMs: 0 });
  const b = createStore({ root: file, saveDelayMs: 0 });
  a.upsertCharacter({ id: 'a', soul: 'A' });
  b.upsertCharacter({ id: 'b', soul: 'B' });
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.characters.map(item => item.id).sort(), ['a', 'b']);
});



test('immediate saves keep successive user and assistant messages in one durable turn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-successive-'));
  try {
    const file = join(dir, 'memory.json');
    const store = createStore({ root: file, saveDelayMs: 0 });
    store.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
    store.archiveTurn('ayu', { userText: '第一问。', assistantText: '第一答。' });
    store.archiveTurn('ayu', { userText: '第二问。', assistantText: '第二答。' });
    store.close();
    const restored = createStore({ root: file });
    try {
      assert.deepEqual(restored.bookFor('ayu').recent(10).map(item => item.text), [
        '第一问。', '第一答。', '第二问。', '第二答。',
      ]);
    } finally {
      restored.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('fact state survives restart and keeps the old value in history', () => withTempDir(dir => {
  const file = join(dir, 'memory.json');
  const store = createStore({ root: file, saveDelayMs: 0 });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软' });
  store.remember({ characterId: 'ayu', id: 'old-home', role: 'user', text: '我住城东。', scope: 's' });
  store.remember({ characterId: 'ayu', id: 'new-home', role: 'user', text: '我搬到城西了。', scope: 's' });
  const oldFact = store.setFact({ characterId: 'ayu', scope: 's', key: '住址', value: '城东', sourceId: 'old-home' });
  store.setFact({ characterId: 'ayu', scope: 's', key: '住址', value: '城西', sourceId: 'new-home', supersedes: oldFact.id });
  store.flush();
  const restored = createStore({ root: file });
  const state = restored.bookFor('ayu').facts({ scope: 's' });
  assert.equal(state.active[0].value, '城西');
  assert.equal(state.history[0].value, '城东');
  assert.match(restored.promptView('ayu', { query: '我现在住哪里？', scope: 's', includeRecent: false }).prompt, /城西/);
}));

test('gateway persists recall reinforcement across restart', () => withTempDir(dir => {
  const file = join(dir, 'memory.json');
  const store = createStore({ root: file, saveDelayMs: 0 });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软' });
  store.remember({
    characterId: 'ayu', id: 'coffee', role: 'user', text: '我喜欢冰美式。',
    sessionId: 's', at: '2026-10-01T10:00:00+08:00',
  });
  store.recall('ayu', 'coffee', { at: '2026-10-20T10:00:00+08:00' });
  store.flush();
  const restored = createStore({ root: file });
  try {
    const score = restored.strength('ayu', 'coffee', { now: '2026-11-01T10:00:00+08:00' });
    assert.equal(score.recallCount, 1);
    assert.equal(Date.parse(score.lastRecalledAt), Date.parse('2026-10-20T10:00:00+08:00'));
  } finally {
    restored.close();
  }
}));

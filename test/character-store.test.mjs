import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileStore, createControlApi } from '../src/character-store.mjs';

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-profile-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'characters.json');
}

test('profile store seeds, persists, updates and removes characters', t => {
  const file = temp(t);
  const store = createProfileStore({ file, seed: { id: 'ayu', name: '阿鱼', soul: '嘴硬心软' } });
  assert.equal(store.find('ayu').name, '阿鱼');
  store.put({ id: 'fish', name: '小鱼', soul: '慢热' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).characters.length, 2);
  store.put({ id: 'fish', name: '小鱼', soul: '慢热', relationship: '熟悉' });
  assert.equal(store.find('fish').relationship, '熟悉');
  assert.equal(store.remove('ayu'), true);
  assert.equal(store.find('ayu'), null);
});

test('profile store builds a bounded query-aware prompt and tracks lore usage', t => {
  const file = temp(t);
  const store = createProfileStore({
    file, now: () => 1000,
    seed: {
      id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探',
      worldbook: [{ id: 'sea', name: '海边', content: '灯塔在城东。', keywords: ['海边'] }],
      examples: [{ user: '冷吗', assistant: '谁管你。' }],
    },
  });
  const view = store.buildPrompt('ayu', '去海边吧', { maxChars: 400 });
  assert.match(view.prompt, /灯塔在城东/);
  assert.equal(view.lore[0].id, 'sea');
  assert.ok(view.prompt.length <= 400);
  assert.equal(store.buildPrompt('ayu', '随便聊聊', { maxChars: 400 }).lore.length, 0);
});

test('control API handles state, save, preview and evolution routes', async t => {
  const file = temp(t);
  const profiles = createProfileStore({ file, seed: { id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'] } });
  const synced = [];
  const store = { dataFile: 'memory.json', getCharacter: () => null, upsertCharacter: value => synced.push(value) };
  const api = createControlApi({ store, profiles });
  const requests = [];
  async function call(method, path, payload) {
    const req = { method, headers: {}, async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(JSON.stringify(payload)); } };
    const res = { status: 0, body: '', writeHead(status) { this.status = status; }, end(value) { this.body = value; } };
    await api(req, res, new URL(`http://local${path}`));
    return { status: res.status, body: JSON.parse(res.body) };
  }
  const state = await call('GET', '/flavor-memory/api/state');
  assert.equal(state.body.characters[0].id, 'ayu');
  const saved = await call('POST', '/flavor-memory/api/characters', { id: 'fish', name: '小鱼', soul: '慢热' });
  assert.equal(saved.body.name, '小鱼');
  const preview = await call('POST', '/flavor-memory/api/preview', { characterId: 'ayu', query: '你好' });
  assert.match(preview.body.prompt, /嘴硬心软/);
  const evolution = await call('POST', '/flavor-memory/api/evolution', {
    characterId: 'yu', target: 'voice', value: ['短句'], evidence: ['m1'],
  });
  assert.equal(evolution.status, 404);
  const autoProfile = {
    id: 'auto', name: '自动鱼', soul: '嘴硬心软', voice: ['短句'],
    evolution: { voiceMode: 'bounded', requireEvidence: true, requireApproval: false, maxVoiceDrift: 0.5 },
  };
  profiles.put(autoProfile);
  const auto = await call('POST', '/flavor-memory/api/evolution', {
    characterId: 'auto', target: 'voice', value: ['短句', '偶尔停顿'], evidence: ['m2'],
  });
  assert.equal(auto.status, 200);
  assert.equal(auto.body.applied, true);
  assert.equal(auto.body.candidate.status, 'bounded-auto');
  assert.deepEqual(synced.at(-1).voice, ['短句', '偶尔停顿']);
});


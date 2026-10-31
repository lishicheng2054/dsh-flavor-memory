import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio-server.mjs';

test('studio serves the UI and supports character creation, import, worldbook preview and evolution', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-studio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const studio = createStudioServer({ profilesFile: join(dir, 'characters.json'), dataFile: ':memory:', port: 0 });
  const address = await studio.start(); const base = `http://127.0.0.1:${address.port}`;
  t.after(() => studio.close());
  const html = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(html.status, 302); assert.equal(html.headers.get('location'), '/flavor-memory/studio');
  const page = await fetch(`${base}/flavor-memory/studio`);
  assert.equal(page.status, 200); const pageText = await page.text(); assert.match(pageText, /角色记忆控制台/); assert.match(pageText, /运行状态/);
  const css = await fetch(`${base}/flavor-memory/studio.css`);
  assert.equal(css.status, 200); assert.match(css.headers.get('content-type'), /text\/css/);
  const js = await fetch(`${base}/flavor-memory/studio.js`);
  assert.equal(js.status, 200); const jsText = await js.text(); assert.match(jsText, /flavor-memory\/api/); assert.match(jsText, /rejectEvolution/); assert.match(jsText, /loadMemory/);

  const profile = {
    id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探',
    worldbook: [{ id: 'sea', name: '海边', content: '灯塔在城东。', keywords: ['海边'] }],
    examples: [{ id: 'ex', user: '冷吗', assistant: '谁管你。', tags: ['关心'] }],
    evolution: { soulMode: 'suggest', requireApproval: true, requireEvidence: true },
  };
  const save = await fetch(`${base}/flavor-memory/api/characters`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) });
  assert.equal(save.status, 200);
  const state = await fetch(`${base}/flavor-memory/api/state`).then(response => response.json());
  assert.equal(state.characters[0].id, 'ayu');
  const preview = await fetch(`${base}/flavor-memory/api/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterId: 'ayu', query: '下雨去海边', maxChars: 1000 }) }).then(response => response.json());
  assert.match(preview.prompt, /灯塔在城东/); assert.ok(preview.lore.some(item => item.id === 'sea'));
  const evolution = await fetch(`${base}/flavor-memory/api/evolution`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterId: 'ayu', target: 'soul', value: '嘴硬但会主动关心', evidence: ['m1'], reason: '长期对话' }) }).then(response => response.json());
  assert.equal(evolution.candidate.status, 'pending');
  const pending = await fetch(`${base}/flavor-memory/api/characters/ayu`).then(response => response.json());
  assert.equal(pending.pendingEvolutions.length, 1);
  const applied = await fetch(`${base}/flavor-memory/api/evolution/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterId: 'ayu', candidate: evolution.candidate }) }).then(response => response.json());
  assert.equal(applied.evolutionHistory[0].status, 'applied');
  const revision = applied.revisions.find(item => item.kind === 'evolution');
  assert.ok(revision);
  const restored = await fetch(`${base}/flavor-memory/api/revisions/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterId: 'ayu', revisionId: revision.id }) }).then(response => response.json());
  assert.equal(restored.soul, '嘴硬心软');
  const secondEvolution = await fetch(`${base}/flavor-memory/api/evolution`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterId: 'ayu', target: 'soul', value: '嘴硬但会主动关心', evidence: ['m2'], reason: '再次提案' }) }).then(response => response.json());
  const rejected = await fetch(`${base}/flavor-memory/api/evolution/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterId: 'ayu', candidateId: secondEvolution.candidate.id }) }).then(response => response.json());
  assert.equal(rejected.pendingEvolutions.length, 0); assert.equal(rejected.evolutionHistory.at(-1).status, 'rejected');
  const imported = await fetch(`${base}/flavor-memory/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: 'chara_card_v2', data: { name: '雨音', description: '旧书店店主', first_mes: '门没锁。', character_book: { entries: [{ keys: ['旧书'], content: '地下书库不开放。' }] } } }) }).then(response => response.json());
  assert.equal(imported.name, '雨音'); assert.equal(imported.worldbook[0].name, '旧书');
  const exported = await fetch(`${base}/flavor-memory/api/export`).then(response => response.json());
  assert.equal(exported.characters.length, 2);
});






test('studio UI exposes search, unsaved indicator and character deletion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-studio-ui-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const studio = createStudioServer({ profilesFile: join(dir, 'characters.json'), dataFile: ':memory:', port: 0 });
  const address = await studio.start(); const base = `http://127.0.0.1:${address.port}`;
  t.after(() => studio.close());

  const pageText = await fetch(`${base}/flavor-memory/studio`).then(response => response.text());
  assert.match(pageText, /aria-label="搜索角色"/);
  assert.match(pageText, /id="characterCount"/);
  assert.match(pageText, /id="dirtyPill"/);
  assert.match(pageText, /id="characterSubtitle"/);
  assert.match(pageText, /id="duplicateCharacter"/);
  assert.match(pageText, /id="deleteCharacter"/);
  assert.match(pageText, /id="memoryQuery"/);
  assert.match(pageText, /id="searchMemory"/);
  assert.match(pageText, /id="memoryHits"/);
  assert.match(pageText, /id="memoryReadCard"/);
  assert.match(pageText, /id="pinMemoryRead"/);
  assert.match(pageText, /id="backupButton"/);
  assert.match(pageText, /id="backupImportButton"/);
  assert.match(pageText, /id="backupInput"/);
  assert.match(pageText, /id="memoryScopeList"/);
  assert.match(pageText, /id="scopeSummary"/);
  assert.match(pageText, /role="tablist"/);
  assert.equal((pageText.match(/role="tab"/g) || []).length, 7);

  assert.match(pageText, /name="theme-color" content="#f5f7f6"/);
  assert.match(pageText, /rel="icon"/);
  assert.match(pageText, /%230f7a68/);
  const jsText = await fetch(`${base}/flavor-memory/studio.js`).then(response => response.text());
  assert.match(jsText, /function syncDirtyUi/);
  assert.match(jsText, /async function deleteCharacter/);
  assert.match(jsText, /function duplicateCharacter/);
  assert.match(jsText, /function matchesFilter/);
  assert.match(jsText, /ctrlKey/);
  assert.match(jsText, /async function searchMemory/);
  assert.match(jsText, /async function loadScopes/);
  assert.match(jsText, /async function openMemoryHit/);
  assert.match(jsText, /async function togglePinMemory/);
  assert.match(jsText, /data-memory-id/);
  assert.match(jsText, /async function exportBackup/);
  assert.match(jsText, /async function importBackupFile/);
  assert.match(jsText, /backup/);
  assert.match(jsText, /importBackupFile/);

  const cssText = await fetch(`${base}/flavor-memory/studio.css`).then(response => response.text());
  assert.match(cssText, /\.topbar \{ position: sticky/);
  assert.match(cssText, /\.rail-search/);
  assert.match(cssText, /color-scheme: light/);
  assert.match(cssText, /--bg: #f5f7f6/);
  assert.match(cssText, /--panel: #ffffff/);
  assert.match(cssText, /--accent: #0f7a68/);
  assert.match(cssText, /\.toast\[data-kind="error"\]/);
  assert.match(cssText, /\.memory-hit/);
  assert.match(cssText, /\.memory-read-card/);
  assert.match(cssText, /\.scope-chip/);
  assert.match(cssText, /\.scope-chip/);
  assert.match(cssText, /scrollbar-color: #c9d4d0/);
  assert.doesNotMatch(cssText, /color-scheme: dark/);

  for (const id of ['keep', 'drop']) {
    const saved = await fetch(`${base}/flavor-memory/api/characters`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: id, soul: '测试灵魂', voice: ['短句'], relationship: '陌生', tags: ['测试'] }),
    });
    assert.equal(saved.status, 200);
  }
  const removed = await fetch(`${base}/flavor-memory/api/characters/drop`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true });
  const gone = await fetch(`${base}/flavor-memory/api/characters/drop`);
  assert.equal(gone.status, 404);
  const state = await fetch(`${base}/flavor-memory/api/state`).then(response => response.json());
  assert.deepEqual(state.characters.map(item => item.id), ['keep']);
  const again = await fetch(`${base}/flavor-memory/api/characters/drop`, { method: 'DELETE' });
  assert.equal(again.status, 404);
});


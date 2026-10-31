import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostRoutes } from '../src/host-routes.mjs';
import { createProfileStore } from '../src/character-store.mjs';
import { createStore } from '../src/gateway.mjs';

test('host routes serve studio assets and synchronize memory anchor after character save', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-host-routes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profiles = createProfileStore({ file: join(dir, 'characters.json'), seed: { id: 'ayu', name: '阿鱼', soul: '旧灵魂', voice: ['短句'], relationship: '刚开始' } });
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '旧灵魂', voice: ['短句'], relationship: '刚开始' });
  const routes = createHostRoutes({ store, profiles, characterId: 'ayu' });
  const server = createServer((req, res) => routes(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/flavor-memory/studio`);
  assert.equal(page.status, 200); assert.match(await page.text(), /角色记忆控制台/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  const js = await fetch(`${base}/flavor-memory/studio.js`);
  assert.equal(js.status, 200); const jsText = await js.text(); assert.match(jsText, /applyEvolution/); assert.match(jsText, /loadMemory/);
  const imported = await fetch(`${base}/flavor-memory/api/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { name: '导入鱼', description: '旧灵魂', first_mes: '来了。', character_book: { entries: [{ keys: ['海'], content: '海风很咸。' }] } } }),
  });
  assert.equal(imported.status, 200);
  const profile = await imported.json();
  assert.equal(profile.firstMessage, '来了。');
  assert.match(store.getCharacter(profile.id).soul, /旧灵魂/);
  const preview = await fetch(`${base}/flavor-memory/api/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterId: profile.id, query: '去海边' }) });
  assert.equal(preview.status, 200); assert.match((await preview.json()).prompt, /海风很咸/);
  const memory = await fetch(`${base}/flavor-memory/api/memory?characterId=ayu&scope=`).then(response => response.json());
  assert.equal(memory.initialRelationship, '刚开始');
  assert.equal(memory.memory.currentRelationship, '刚开始');
  const fact = await fetch(`${base}/flavor-memory/api/memory/fact`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ characterId: 'ayu', key: '住址', value: '城东', tags: ['重要'] }),
  });
  assert.equal(fact.status, 200);
  const state = await fact.json();
  assert.equal(state.memory.facts.active[0].value, '城东');
  const updated = await fetch(`${base}/flavor-memory/api/memory/fact`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ characterId: 'ayu', key: '住址', value: '城西' }),
  }).then(response => response.json());
  assert.equal(updated.memory.facts.active[0].value, '城西');
  assert.equal(updated.memory.facts.history[0].value, '城东');
});





test('memory API lazily creates the memory anchor for a profile that is not yet in the memory store', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-host-routes-lazy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profiles = createProfileStore({
    file: join(dir, 'characters.json'),
    seed: { id: 'lazy', name: '懒鱼', soul: '慢热但认人', voice: ['短句'], relationship: '还没认识' },
  });
  const store = createStore({ root: ':memory:' });
  assert.ok(!store.getCharacter('lazy'));
  const routes = createHostRoutes({ store, profiles, characterId: 'lazy' });
  const server = createServer((req, res) => routes(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const view = await fetch(`${base}/flavor-memory/api/memory?characterId=lazy`);
  assert.equal(view.status, 200);
  const state = await view.json();
  assert.equal(state.memory.currentRelationship, '还没认识');
  assert.ok(store.getCharacter('lazy'), 'memory anchor should be created on demand');
  const first = await fetch(`${base}/flavor-memory/api/memory/fact`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ characterId: 'lazy', key: '常去的地方', value: '海边' }),
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).memory.facts.active[0].value, '海边');
  const second = await fetch(`${base}/flavor-memory/api/memory/fact`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ characterId: 'lazy', key: '常去的地方', value: '旧书店' }),
  }).then(response => response.json());
  assert.equal(second.memory.facts.active[0].value, '旧书店');
  assert.equal(second.memory.facts.history[0].value, '海边');
  const missing = await fetch(`${base}/flavor-memory/api/memory?characterId=nobody`);
  assert.equal(missing.status, 404);
});


test('memory browser API supports scoped lexical search, exact reads and fact history', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-memory-browser-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profiles = createProfileStore({ file: join(dir, 'characters.json'), seed: { id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' } });
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' });
  store.remember({ characterId: 'ayu', id: 'u1', role: 'user', text: '我对花生过敏，绝对不能吃。', scope: 's1', at: '2026-10-28T10:00:00+08:00', tags: ['重要'] });
  store.remember({ characterId: 'ayu', id: 'a1', role: 'assistant', text: '记住了。下次点单我会先问。', scope: 's1', at: '2026-10-28T10:00:05+08:00' });
  store.remember({ characterId: 'ayu', id: 'old', role: 'user', text: '我住在城东。', scope: 's1', at: '2026-10-27T10:00:00+08:00' });
  store.remember({ characterId: 'ayu', id: 'new', role: 'user', text: '我搬到城西了。', scope: 's1', at: '2026-10-28T10:00:00+08:00' });
  store.remember({ characterId: 'ayu', id: 'other', role: 'user', text: '花生只属于另一个会话。', scope: 's2' });
  const routes = createHostRoutes({ store, profiles, characterId: 'ayu' });
  const server = createServer((req, res) => routes(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const found = await fetch(`${base}/flavor-memory/api/memory/search?characterId=ayu&scope=s1&q=%E8%8A%B1%E7%94%9F`).then(response => response.json());
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].id, 'u1');
  assert.doesNotMatch(found.hits[0].snippet, /另一个会话/);

  const raw = await fetch(`${base}/flavor-memory/api/memory/read?characterId=ayu&scope=s1&id=u1`).then(response => response.json());
  assert.equal(raw.entry.text, '我对花生过敏，绝对不能吃。');
  assert.equal(raw.entry.tags[0], '重要');
  const wrongScope = await fetch(`${base}/flavor-memory/api/memory/read?characterId=ayu&scope=s2&id=u1`);
  assert.equal(wrongScope.status, 404);

  const oldFact = store.setFact({ characterId: 'ayu', scope: 's1', key: '住址', value: '城东', sourceId: 'old' });
  store.setFact({ characterId: 'ayu', scope: 's1', key: '住址', value: '城西', sourceId: 'new', supersedes: oldFact.id });
  const facts = await fetch(`${base}/flavor-memory/api/memory/facts?characterId=ayu&scope=s1`).then(response => response.json());
  assert.equal(facts.active.find(item => item.key === '住址').value, '城西');
  assert.equal(facts.history.find(item => item.key === '住址').value, '城东');
});


test('host route pins and unpins a scoped original message without crossing sessions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-memory-pin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profiles = createProfileStore({ file: join(dir, 'characters.json'), seed: { id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' } });
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' });
  store.remember({ characterId: 'ayu', id: 'promise', role: 'user', text: '周五一起去看海。', scope: 's1' });
  const routes = createHostRoutes({ store, profiles, characterId: 'ayu' });
  const server = createServer((req, res) => routes(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pinned = await fetch(`${base}/flavor-memory/api/memory/pin`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ characterId: 'ayu', scope: 's1', id: 'promise', pinned: true }),
  });
  assert.equal(pinned.status, 200);
  const pinView = await pinned.json();
  assert.equal(pinView.entry.pinned, true);
  assert.equal(store.getRaw('ayu', 'promise').pinned, true);
  const wrongScope = await fetch(`${base}/flavor-memory/api/memory/pin`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ characterId: 'ayu', scope: 's2', id: 'promise', pinned: false }),
  });
  assert.equal(wrongScope.status, 404);
  const unpinned = await fetch(`${base}/flavor-memory/api/memory/pin`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ characterId: 'ayu', scope: 's1', id: 'promise', pinned: false }),
  }).then(response => response.json());
  assert.equal(unpinned.entry.pinned, false);
});


test('memory browser facts can be updated from the panel without manual supersedes ids', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-memory-fact-ui-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profiles = createProfileStore({ file: join(dir, 'characters.json'), seed: { id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' } });
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' });
  const routes = createHostRoutes({ store, profiles, characterId: 'ayu' });
  const server = createServer((req, res) => routes(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${base}/flavor-memory/api/memory/fact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(response => response.json());
  const first = await post({ characterId: 'ayu', scope: 's1', key: '常用伞', value: '透明长柄伞', tags: ['重要'] });
  assert.equal(first.memory.facts.active[0].value, '透明长柄伞');
  const second = await post({ characterId: 'ayu', scope: 's1', key: '常用伞', value: '深蓝色折叠伞' });
  assert.equal(second.memory.facts.active[0].value, '深蓝色折叠伞');
  assert.equal(second.memory.facts.history[0].value, '透明长柄伞');
  const other = await post({ characterId: 'ayu', scope: 's2', key: '常用伞', value: '透明长柄伞' });
  assert.equal(other.memory.facts.active[0].value, '透明长柄伞');
  assert.equal(other.memory.facts.history.length, 0);
  const list = await fetch(`${base}/flavor-memory/api/memory/facts?characterId=ayu&scope=s1`).then(response => response.json());
  assert.equal(list.active[0].value, '深蓝色折叠伞');
  assert.equal(list.history[0].value, '透明长柄伞');
});


test('full backup endpoint exports profiles and scoped memory, then imports without cross-scope leakage', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-memory-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profiles = createProfileStore({ file: join(dir, 'characters.json'), seed: { id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探', worldbook: [{ id: 'sea', name: '海边', content: '灯塔在城东。', keywords: ['海边'] }] } });
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' });
  store.remember({ characterId: 'ayu', id: 'u1', role: 'user', text: '我对花生过敏。', scope: 's1', tags: ['重要'] });
  store.setFact({ characterId: 'ayu', scope: 's1', key: '常用伞', value: '深蓝色折叠伞', sourceId: 'u1' });
  const routes = createHostRoutes({ store, profiles, characterId: 'ayu' });
  const server = createServer((req, res) => routes(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const backup = await fetch(`${base}/flavor-memory/api/backup/export`).then(response => response.json());
  assert.equal(backup.schema, 'flavor-memory-export');
  assert.equal(backup.profiles.length, 1);
  assert.equal(backup.profiles[0].id, 'ayu');
  assert.equal(backup.memories.length, 1);
  assert.equal(backup.memories[0].entries[0].text, '我对花生过敏。');
  assert.equal(backup.memories[0].entries[0].scope, 's1');
  assert.equal(backup.memories[0].facts[0].value, '深蓝色折叠伞');

  const reimport = await fetch(`${base}/flavor-memory/api/backup/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...backup, profiles: [] }),
  });
  assert.equal(reimport.status, 200);
  const result = await reimport.json();
  assert.equal(result.ok, true);
  assert.equal(result.profiles, 0);
  assert.equal(result.memories, 1);
  assert.equal(store.facts('ayu', { scope: 's1' }).active[0].value, '深蓝色折叠伞');
  assert.equal(store.facts('ayu', { scope: 's2' }).active.length, 0);
});


test('memory search excludes pinned-only cross-scope entries and includes pin state in read', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-memory-pin-ui-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profiles = createProfileStore({ file: join(dir, 'characters.json'), seed: { id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' } });
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' });
  store.remember({ characterId: 'ayu', id: 'u1', role: 'user', text: '不要忘记周五的约定。', scope: 's1' });
  store.remember({ characterId: 'ayu', id: 'u2', role: 'user', text: '不要忘记周五的约定。', scope: 's2' });
  const routes = createHostRoutes({ store, profiles, characterId: 'ayu' });
  const server = createServer((req, res) => routes(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/flavor-memory/api/memory/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ characterId: 'ayu', scope: 's1', id: 'u1', pinned: true }) });
  const found = await fetch(`${base}/flavor-memory/api/memory/search?characterId=ayu&scope=s1&q=%E7%BA%A6%E5%AE%9A`).then(response => response.json());
  assert.deepEqual(found.hits.map(hit => hit.id), ['u1']);
  assert.equal(found.hits[0].important, false);
  assert.equal(found.hits[0].pinned, true);
  const raw = await fetch(`${base}/flavor-memory/api/memory/read?characterId=ayu&scope=s1&id=u1`).then(response => response.json());
  assert.equal(raw.entry.pinned, true);
  const missing = await fetch(`${base}/flavor-memory/api/memory/read?characterId=ayu&scope=s1&id=u2`);
  assert.equal(missing.status, 404);
});


test('memory scope list surfaces only scopes that actually own archived data', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-memory-scopes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profiles = createProfileStore({ file: join(dir, 'characters.json'), seed: { id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' } });
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' });
  store.remember({ characterId: 'ayu', id: 'a1', role: 'user', text: 's1 的第一句', scope: 's1' });
  store.remember({ characterId: 'ayu', id: 'a2', role: 'assistant', text: 's1 的回复', scope: 's1' });
  store.remember({ characterId: 'ayu', id: 'b1', role: 'user', text: 's2 的第一句', scope: 's2' });
  store.remember({ characterId: 'ayu', id: 'g1', role: 'user', text: '全局的一句', scope: '' });
  const routes = createHostRoutes({ store, profiles, characterId: 'ayu' });
  const server = createServer((req, res) => routes(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const scopes = await fetch(`${base}/flavor-memory/api/memory/scopes?characterId=ayu`).then(response => response.json());
  assert.deepEqual(scopes.scopes.map(item => item.scope), ['', 's1', 's2']);
  assert.deepEqual(scopes.scopes.map(item => item.messages), [1, 2, 1]);
  const missing = await fetch(`${base}/flavor-memory/api/memory/scopes?characterId=nobody`);
  assert.equal(missing.status, 404);
});


test('compression metrics do not claim messages were moved out before a scene card exists', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-memory-metrics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profiles = createProfileStore({ file: join(dir, 'characters.json'), seed: { id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' } });
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' });
  store.remember({ characterId: 'ayu', id: 'u1', role: 'user', text: '今天雨很大，我们改天再去看海。', scope: 's1' });
  store.remember({ characterId: 'ayu', id: 'a1', role: 'assistant', text: '行吧，伞拿好，别又淋感冒。', scope: 's1' });
  const routes = createHostRoutes({ store, profiles, characterId: 'ayu' });
  const server = createServer((req, res) => routes(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = await fetch(`${base}/flavor-memory/api/memory?characterId=ayu&scope=s1`).then(response => response.json());
  assert.equal(before.memory.stats.activeCards, 0);
  assert.equal(before.memory.compression.savedPercent, 0);
  assert.equal(before.memory.compression.savedChars, 0);
  assert.equal(before.memory.stats.pendingMessages, 2);
  store.autoCompact('ayu', { scope: 's1', throughSeq: 2, quotes: 1 });
  const after = await fetch(`${base}/flavor-memory/api/memory?characterId=ayu&scope=s1`).then(response => response.json());
  assert.equal(after.memory.stats.activeCards, 1);
  assert.ok(after.memory.compression.cardChars > 0);
  assert.ok(after.memory.compression.savedPercent >= 0);
});


test('backup import accepts a restore larger than two megabytes and rejects oversized bodies with 413', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-memory-large-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profiles = createProfileStore({ file: join(dir, 'characters.json'), seed: { id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' } });
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'], relationship: '试探' });
  const routes = createHostRoutes({ store, profiles, characterId: 'ayu' });
  const server = createServer((req, res) => routes(req, res).catch(error => { res.writeHead(error.statusCode || 500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message })); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const exported = await fetch(`${base}/flavor-memory/api/backup/export`).then(response => response.json());
  const largeBackup = {
    ...exported,
    profiles: [],
    memories: [{ ...exported.memories[0], entries: [...exported.memories[0].entries, {
      id: 'large', seq: 999, role: 'user', text: '长'.repeat(2 * 1024 * 1024 + 1024), at: Date.now(), scope: '',
    }] }],
  };
  const restored = await fetch(`${base}/flavor-memory/api/backup/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(largeBackup),
  });
  if (restored.status !== 200) console.error('LARGE_BACKUP_RESPONSE', restored.status, await restored.text());
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).memories, 1);
  assert.equal(store.getRaw('ayu', 'large').text.length, 2 * 1024 * 1024 + 1024);
  assert.equal(store.getRaw('ayu', 'large').text.length, 2 * 1024 * 1024 + 1024);
  const tooLarge = {
    ...exported,
    profiles: [],
    memories: [{ ...exported.memories[0], entries: [...exported.memories[0].entries, {
      id: 'too-large', seq: 1000, role: 'user', text: '超'.repeat(65 * 1024 * 1024), at: Date.now(), scope: '',
    }] }],
  };
  const rejected = await fetch(`${base}/flavor-memory/api/backup/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tooLarge),
  });
  assert.equal(rejected.status, 413);
  assert.equal((await rejected.json()).error, 'request body too large');
});

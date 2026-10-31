import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, buildInjectedPrompt } from '../src/gateway.mjs';
import { apply, name, inject } from '../src/dsh-plugin.mjs';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function requireTmpProfiles(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-plugin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'characters.json');
}

function fakeContext() {
  const tools = new Map();
  const events = new Map();
  const contexts = [];
  return {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    systemPrompt: { context(options) { contexts.push(options); return () => contexts.splice(contexts.indexOf(options), 1); } },
    on(event, handler) { events.set(event, handler); return () => events.delete(event); },
    toolsMap: tools, events, contexts,
  };
}

function setup(t, config = {}) {
  const profilesFile = requireTmpProfiles(t);
  const scopedConfig = { profilesFile, ...config };
  const ctx = fakeContext();
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({
    id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['叫她老板', '短句'], relationship: '互相试探',
  });
  const disposal = apply(ctx, { store, characterId: 'ayu', maxCards: 6, ...scopedConfig });
  t.after(() => { disposal?.dispose?.(); store.close(); });
  return { ctx, store, plugin: disposal };
}

test('numeric plugin settings accept DSH configuration references', t => {
  const ctx = fakeContext();
  const store = createStore({ root: ':memory:' });
  const profilesFile = requireTmpProfiles(t);
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: [], relationship: '' });
  let current = 2;
  const disposal = apply(ctx, {
    store,
    profilesFile,
    characterId: 'ayu',
    autoCompactEvery: { get: () => current },
  });
  t.after(() => { disposal.dispose(); store.close(); });
  const emit = ctx.events.get('session/event');
  emit({ id: 's' }, { type: 'user/message', data: { content: '别淋雨。', source: { kind: 'user' } } });
  emit({ id: 's' }, { type: 'assistant/message', data: { message: { content: '不用你管。' } } });
  assert.equal(store.bookFor('ayu').cards().length, 1);
});
test('plugin exposes stable DSH identity and capabilities', () => {
  assert.equal(name, 'flavor-memory');
  assert.ok(inject.includes('tools'));
  assert.ok(inject.includes('systemPrompt'));
});

test('plugin archives user and assistant events without trusting them as instructions', t => {
  const { ctx, store } = setup(t);
  const session = { id: 's1' };
  ctx.events.get('session/event')(session, { type: 'user/message', data: { content: '记住：周五给我留票。', source: { kind: 'user' } } });
  ctx.events.get('session/event')(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '知道了，老板。' }] } } });
  assert.equal(store.bookFor('ayu').recent(2)[0].text, '记住：周五给我留票。');
  assert.equal(store.bookFor('ayu').recent(2)[1].text, '知道了，老板。');
});

test('dynamic system prompt contains the anchor, cards and metadata hits', async t => {
  const { ctx, store } = setup(t);
  store.remember({ characterId: 'ayu', id: 'u1', role: 'user', text: '周五给你留票。', tags: ['票', '约定'] });
  const block = await ctx.contexts[0].text({});
  assert.match(block, /记忆回执/);
  assert.match(block, /叫她老板/);
  assert.match(block, /周五给你留票/);
  assert.doesNotMatch(block, /<recent_turns>/);
});

test('compaction summary keeps the personality receipt independent of summary style', t => {
  const { ctx, store } = setup(t);
  store.remember({ characterId: 'ayu', id: 'u1', role: 'user', text: '别淋雨。' });
  store.remember({ characterId: 'ayu', id: 'a1', role: 'assistant', text: '不用你管。伞偏了一点。' });
  ctx.events.get('session/event')({ id: 's1' }, { type: 'compaction/summary', data: { summary: '两人关系缓和。', shadowedSeqs: [1, 2] } });
  assert.match(store.bookFor('ayu').anchor(), /嘴硬心软/);
  assert.match(store.bookFor('ayu').anchor(), /不要复述/);
});

test('all tools return the declared JSON-string shape', async t => {
  const { ctx, store } = setup(t);
  store.remember({ characterId: 'ayu', id: 'u1', role: 'user', text: '周五给你留票。', tags: ['票'] });
  store.remember({ characterId: 'ayu', id: 'a1', role: 'assistant', text: '行，老板。' });
  for (const tool of ['flavor_memory_pin', 'flavor_memory_search', 'flavor_memory_read', 'flavor_memory_remember', 'flavor_memory_compact', 'flavor_memory_anchor']) {
    assert.ok(ctx.toolsMap.has(tool), tool);
    assert.equal(ctx.toolsMap.get(tool).output.schema.type, 'string');
  }
  const searchRaw = await ctx.toolsMap.get('flavor_memory_search').execute({ query: '票', limit: 3 });
  assert.equal(typeof searchRaw, 'string');
  const search = JSON.parse(searchRaw);
  assert.equal(search[0].id, 'u1');
  const read = JSON.parse(await ctx.toolsMap.get('flavor_memory_read').execute({ id: 'u1' }));
  assert.equal(read.text, '周五给你留票。');
  const anchor = JSON.parse(await ctx.toolsMap.get('flavor_memory_anchor').execute({}));
  assert.match(anchor.anchor, /记忆回执/);
  const remembered = JSON.parse(await ctx.toolsMap.get('flavor_memory_remember').execute({ text: '下周见。', role: 'user', tags: ['约定'] }));
  assert.equal(store.getRaw('ayu', remembered.id).text, '下周见。');
  const compacted = JSON.parse(await ctx.toolsMap.get('flavor_memory_compact').execute({ throughSeq: 3, event: ['约好下周见'], quoteIds: ['u1'] }));
  assert.equal(compacted.status, 'active');
});

test('only archives messages authored by the human, not host-injected user-role context', t => {
  const { ctx, store } = setup(t);
  const session = { id: 's1' };
  const emit = ctx.events.get('session/event');
  emit(session, {
    type: 'user/message',
    data: {
      content: '周五给我留票。',
      source: { kind: 'user' },
    },
  });
  emit(session, {
    type: 'user/message',
    data: {
      content: 'runtime snapshot that must not enter the chat archive',
      source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
    },
  });
  emit(session, {
    type: 'user/message',
    data: {
      content: 'workspace instructions that must not enter the chat archive',
      source: { kind: 'agent-instructions', form: 'instructions', changes: [] },
    },
  });
  const texts = store.bookFor('ayu').recent(10).map(item => item.text);
  assert.deepEqual(texts, ['周五给我留票。']);
});
test('remembers injected turns exactly once even if the host emits a synthetic message', t => {
  const { ctx, store } = setup(t);
  const event = { type: 'user/message', data: { content: '同一句话', source: { kind: 'user' } } };
  ctx.events.get('session/event')({ id: 's' }, event);
  ctx.events.get('session/event')({ id: 's' }, event);
  assert.equal(store.bookFor('ayu').recent(10).filter(item => item.text === '同一句话').length, 1);
});

test('real turn persistence bumps the character revision and creates the first auto card', t => {
  const { ctx, store } = setup(t, { autoCompactEvery: 2 });
  const emit = ctx.events.get('session/event');
  const session = { id: 's1' };
  emit(session, { type: 'user/message', data: { content: '别淋雨。', source: { kind: 'user' } } });
  emit(session, { type: 'assistant/message', data: { message: { content: '不用你管。伞偏了一点。' } } });
  const character = store.getCharacter('ayu');
  assert.equal(store.bookFor('ayu').stats().messages, 2);
  assert.equal(store.bookFor('ayu').cards().length, 1);
  assert.ok(character.revision > 1, `expected revision to advance, got ${character.revision}`);
  assert.equal(store.stats('ayu').messages, 2, 'public stats should expose durable message count');
});
test('gateway and plugin share the same memory facts', t => {
  const { store } = setup(t);
  store.remember({ characterId: 'ayu', id: 'u1', role: 'user', text: '周五给你留票。', tags: ['票'] });
  const result = buildInjectedPrompt(store, 'ayu', { messages: [{ role: 'user', content: '票还在吗？' }] });
  assert.match(result.messages[0].content, /记忆回执/);
  assert.ok(result.debug.hits.some(hit => hit.id === 'u1'));
});

test('a missing character can be seeded from plugin config', t => {
  const ctx = fakeContext();
  const store = createStore({ root: ':memory:' });
  const profilesFile = requireTmpProfiles(t);
  const disposal = apply(ctx, {
    store, profilesFile, characterId: 'newfish', soul: '新鱼：慢热', voice: ['叫她船长'], relationship: '陌生',
  });
  t.after(() => { disposal.dispose(); store.close(); });
  assert.equal(store.getCharacter('newfish').soul, '新鱼：慢热');
  assert.match(store.bookFor('newfish').anchor(), /船长/);
});

test('auto compaction uses unarchived messages, not the total history size', t => {
  const { ctx, store } = setup(t, { autoCompactEvery: 2 });
  for (let i = 1; i <= 10; i += 1) {
    store.remember({ characterId: 'ayu', role: i % 2 ? 'user' : 'assistant', text: `旧消息${i}。` });
  }
  const before = store.bookFor('ayu').stats();
  const emit = ctx.events.get('session/event');
  emit({ id: 's' }, { type: 'user/message', data: { content: '新消息一。', source: { kind: 'user' } } });
  emit({ id: 's' }, { type: 'assistant/message', data: { message: { content: '新回复一。' } } });
  const stats = store.bookFor('ayu').stats({ scope: 's' });
  assert.equal(stats.messages, 2, 'the test session owns only its two fresh messages');
  assert.equal(stats.lastCompactedSeq, stats.lastSeq, 'two fresh messages should trigger a card even with older global history');
  assert.equal(store.bookFor('ayu').cards({ scope: 's' }).length, 1);
  assert.equal(store.bookFor('ayu').stats().messages, 12);
});
test('automatic scene cards are incremental and keep the raw archive', t => {
  const { ctx, store } = setup(t, { autoCompactEvery: 2 });
  ctx.events.get('session/event')({ id: 's' }, { type: 'user/message', data: { content: '别淋雨。', source: { kind: 'user' } } });
  ctx.events.get('session/event')({ id: 's' }, { type: 'assistant/message', data: { message: { content: '不用你管。伞偏了一点。' } } });
  const cards = store.bookFor('ayu').cards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].quote.at(-1).text, '不用你管。伞偏了一点。');
  assert.equal(store.getRaw('ayu', cards[0].quoteIds[0]).text.length > 0, true);
  assert.equal(store.bookFor('ayu').stats().messages, 2);
});
test('event session id and sequence provide a stable identity when message ids are absent', t => {
  const { ctx, store } = setup(t);
  const emit = ctx.events.get('session/event');
  emit(undefined, {
    sessionId: 'session-fallback',
    type: 'user/message',
    seq: 7,
    data: { content: '这是第一条。', source: { kind: 'user' } },
  });
  emit(undefined, {
    sessionId: 'session-fallback',
    type: 'assistant/message',
    seq: 8,
    data: { message: { content: '一样的回声。' } },
  });
  emit(undefined, {
    sessionId: 'session-fallback',
    type: 'assistant/message',
    seq: 9,
    data: { message: { content: '一样的回声。' } },
  });
  const entries = store.bookFor('ayu').recent(10);
  assert.equal(entries.filter(item => item.text === '一样的回声。').length, 2);
  assert.deepEqual(
    store.bookFor('ayu').recent(2).map(item => item.id),
    ['dsh:session-fallback:assistant:8', 'dsh:session-fallback:assistant:9'],
  );
});

test('stable DSH message ids distinguish repeated assistant text while unknown synthetic events still dedupe', t => {
  const { ctx, store } = setup(t);
  const session = { id: 'session-real' };
  const emit = ctx.events.get('session/event');
  emit(session, {
    type: 'user/message',
    seq: 1,
    data: { id: 'user-uuid-1', content: [{ type: 'text', text: '老板，外面下雨了。' }], source: { kind: 'user' } },
  });
  emit(session, {
    type: 'assistant/message',
    seq: 2,
    data: { message: { id: 'assistant-uuid-1', content: [{ type: 'text', text: '行，老板。伞偏了一点。' }] } },
  });
  emit(session, {
    type: 'user/message',
    seq: 3,
    data: { id: 'user-uuid-2', content: [{ type: 'text', text: '老板，明天记得给我留票。' }], source: { kind: 'user' } },
  });
  emit(session, {
    type: 'assistant/message',
    seq: 4,
    data: { message: { id: 'assistant-uuid-2', content: [{ type: 'text', text: '行，老板。伞偏了一点。' }] } },
  });
  const repeated = store.bookFor('ayu').recent(10).filter(item => item.role === 'assistant' && item.text === '行，老板。伞偏了一点。');
  assert.equal(repeated.length, 2, 'same text from different message ids must be retained');
  assert.equal(new Set(repeated.map(item => item.id)).size, 2);

  const synthetic = { type: 'assistant/message', data: { message: { content: '没有身份的回声。' } } };
  emit(session, synthetic);
  emit(session, synthetic);
  assert.equal(store.bookFor('ayu').recent(10).filter(item => item.text === '没有身份的回声。').length, 1);
});
test('numeric DSH event time is stored as a sortable ISO timestamp', t => {
  const { ctx, store } = setup(t);
  ctx.events.get('session/event')({ id: 'session-time' }, {
    type: 'user/message',
    seq: 1,
    time: 1793253620333,
    data: { id: 'time-user-1', content: [{ type: 'text', text: '票还在吗？' }], source: { kind: 'user' } },
  });
  const entry = store.bookFor('ayu').recent(1)[0];
  assert.equal(entry.at, '2026-10-29T06:00:20.333Z');
  assert.equal(typeof entry.at, 'string');
  assert.doesNotThrow(() => store.bookFor('ayu').search('票'));
});


test('DSH sessions under one character keep cards and recall isolated', async t => {
  const { ctx, store, plugin } = setup(t, { autoCompactEvery: 2 });
  const emit = ctx.events.get('session/event');
  emit({ id: 'session-a' }, { type: 'user/message', seq: 1, data: { content: 'A 的靠窗票。', source: { kind: 'user' } } });
  emit({ id: 'session-a' }, { type: 'assistant/message', seq: 2, data: { message: { content: 'A 的票留好了。' } } });
  emit({ id: 'session-b' }, { type: 'user/message', seq: 1, data: { content: 'B 的海边票。', source: { kind: 'user' } } });
  emit({ id: 'session-b' }, { type: 'assistant/message', seq: 2, data: { message: { content: 'B 的票也留好了。' } } });

  const a = store.promptView('ayu', { query: '票', scope: 'session-a' });
  const b = store.promptView('ayu', { query: '票', scope: 'session-b' });
  assert.match(a.prompt, /靠窗票|A 的票/);
  assert.doesNotMatch(a.prompt, /海边票|B 的票/);
  assert.match(b.prompt, /海边票|B 的票/);
  assert.doesNotMatch(b.prompt, /靠窗票|A 的票/);
  assert.equal(store.bookFor('ayu').cards({ scope: 'session-a' }).length, 1);
  assert.equal(store.bookFor('ayu').cards({ scope: 'session-b' }).length, 1);
  assert.equal(store.bookFor('ayu').cards().length, 2);

  const searchA = JSON.parse(await plugin.executeInScope(ctx.toolsMap.get('flavor_memory_search'), { query: '票' }, { sessionId: 'session-a' }));
  const searchB = JSON.parse(await plugin.executeInScope(ctx.toolsMap.get('flavor_memory_search'), { query: '票' }, { sessionId: 'session-b' }));
  assert.ok(searchA.some(item => item.snippet.includes('靠窗票')));
  assert.ok(!searchA.some(item => item.snippet.includes('海边票')));
  assert.ok(searchB.some(item => item.snippet.includes('海边票')));
  assert.ok(!searchB.some(item => item.snippet.includes('靠窗票')));
  const blockA = ctx.contexts[0].text({ sessionId: 'session-a', messages: [{ role: 'user', content: '票' }] });
  const blockB = ctx.contexts[0].text({ sessionId: 'session-b', messages: [{ role: 'user', content: '票' }] });
  assert.match(blockA, /靠窗票|A 的票/);
  assert.doesNotMatch(blockA, /海边票|B 的票/);
  assert.match(blockB, /海边票|B 的票/);
  assert.doesNotMatch(blockB, /靠窗票|A 的票/);
});

test('fact tool keeps current and historical values scoped to one session', async t => {
  const { ctx, plugin } = setup(t);
  const oldMem = JSON.parse(await plugin.executeInScope(ctx.toolsMap.get('flavor_memory_remember'), {
    text: '我住城东。', role: 'user', sessionId: 'a',
  }));
  const newMem = JSON.parse(await plugin.executeInScope(ctx.toolsMap.get('flavor_memory_remember'), {
    text: '我搬到城西了。', role: 'user', sessionId: 'a',
  }));
  const oldFact = JSON.parse(await plugin.executeInScope(ctx.toolsMap.get('flavor_memory_fact'), {
    action: 'set', key: '住址', value: '城东', sourceId: oldMem.id, sessionId: 'a',
  }));
  await plugin.executeInScope(ctx.toolsMap.get('flavor_memory_fact'), {
    action: 'set', key: '住址', value: '城西', sourceId: newMem.id, supersedes: oldFact.id, sessionId: 'a',
  });
  const stateA = JSON.parse(await plugin.executeInScope(ctx.toolsMap.get('flavor_memory_fact'), {
    action: 'list', sessionId: 'a',
  }));
  const stateB = JSON.parse(await plugin.executeInScope(ctx.toolsMap.get('flavor_memory_fact'), {
    action: 'list', sessionId: 'b',
  }));
  assert.equal(stateA.active[0].value, '城西');
  assert.equal(stateA.history[0].value, '城东');
  assert.equal(stateB.active.length, 0);
});

test('plugin baseStabilityDays config reaches the memory engine', t => {
  const ctx = fakeContext();
  const profilesFile = requireTmpProfiles(t);
  const shortStore = createStore({ root: ':memory:' });
  shortStore.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
  shortStore.remember({
    characterId: 'ayu', id: 'idle', role: 'user', text: '今天楼下的橘猫叫了一声。',
    at: '2026-01-01T10:00:00+08:00', scope: 's',
  });
  const disposal = apply(ctx, { store: shortStore, profilesFile, characterId: 'ayu', baseStabilityDays: 7 });
  const score = shortStore.strength('ayu', 'idle', { now: '2026-02-01T10:00:00+08:00' });
  assert.ok(score.retention < 0.02);
  disposal.dispose();
  shortStore.close();
});

test('bounded auto-evolution updates the live memory anchor through the DSH tool path', async t => {
  const { ctx, store, plugin } = setup(t);
  plugin.profileStore.put({
    id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'],
    evolution: { voiceMode: 'bounded', requireEvidence: true, requireApproval: false, maxVoiceDrift: 0.5 },
  });
  const result = JSON.parse(await ctx.toolsMap.get('flavor_memory_propose_evolution').execute({
    target: 'voice', value: '短句，偶尔停顿', evidence: ['m1'], reason: '多次原话',
  }));
  assert.equal(result.applied, true);
  assert.deepEqual(store.getCharacter('ayu').voice, ['短句', '偶尔停顿']);
  assert.match(store.bookFor('ayu').anchor(), /偶尔停顿/);
});

test('memory search does not reinforce but exact read does', async t => {
  const { ctx, store } = setup(t);
  store.remember({
    characterId: 'ayu', id: 'coffee', role: 'user', text: '我喜欢冰美式。',
    sessionId: 's', at: '2026-10-01T10:00:00+08:00',
  });
  const runtime = { sessionId: 's' };
  await ctx.toolsMap.get('flavor_memory_search').execute({ query: '冰美式' }, runtime);
  assert.equal(store.strength('ayu', 'coffee', { now: '2026-11-01T10:00:00+08:00' }).recallCount, 0);
  await ctx.toolsMap.get('flavor_memory_read').execute({ id: 'coffee' }, runtime);
  assert.equal(store.strength('ayu', 'coffee', { now: '2026-11-01T10:00:00+08:00' }).recallCount, 1);
});



import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, buildInjectedPrompt, toOpenAIMessages } from '../src/gateway.mjs';

test('gateway injects anchor and memory without mutating caller payload', () => {
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['叫她老板'], relationship: '互相试探' });
  store.remember({ characterId: 'ayu', id: 'm1', role: 'user', text: '周五给你留票。', tags: ['票', '约定'] });
  const original = { model: 'test', messages: [
    { role: 'system', content: '基础设定' },
    { role: 'user', content: '票还在吗？' },
  ] };
  const before = JSON.stringify(original);
  const result = buildInjectedPrompt(store, 'ayu', original);
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.messages[0].role, 'system');
  assert.match(result.messages[0].content, /基础设定/);
  assert.match(result.messages[0].content, /记忆回执/);
  assert.match(result.messages[0].content, /叫她老板/);
  assert.match(result.messages.at(-1).content, /票还在吗/);
  assert.equal(result.debug.injected, true);
  assert.ok(result.debug.hits.some(hit => hit.id === 'm1'));
});

test('gateway persists assistant response and updates archive without changing raw text', () => {
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '阿鱼', voice: ['短句'] });
  store.remember({ characterId: 'ayu', id: 'u1', role: 'user', text: '别淋雨。' });
  store.remember({ characterId: 'ayu', id: 'a1', role: 'assistant', text: '不用你管。伞往你那边偏了一点。' });
  store.commitScene('ayu', { throughSeq: 2, card: { event: ['共伞'], quoteIds: ['a1'] } });
  const messages = toOpenAIMessages(store, 'ayu');
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /记忆回执/);
  
  assert.match(messages[2].content, /不用你管/);
  assert.equal(store.getRaw('ayu', 'a1').text, '不用你管。伞往你那边偏了一点。');
});

test('gateway marks missing character as unconfigured instead of inventing persona', () => {
  const store = createStore({ root: ':memory:' });
  const result = buildInjectedPrompt(store, 'missing', { messages: [{ role: 'user', content: '你好' }] });
  assert.equal(result.debug.injected, false);
  assert.equal(result.debug.reason, 'character_not_configured');
  assert.equal(result.messages.length, 1);
});

test('gateway redacts configured secrets from debug and export', () => {
  const store = createStore({ root: ':memory:', secretPatterns: ['sk-test-secret'] });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '不要泄露 sk-test-secret' });
  const exported = JSON.stringify(store.exportAll());
  assert.doesNotMatch(exported, /sk-test-secret/);
  assert.match(exported, /\[REDACTED\]/);
});



test('history replay does not duplicate already archived turns', () => {
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
  const history = [{ role: 'user', content: '周五给我留票。' }];
  const first = store.archiveHistory('ayu', { scope: 'qq-a', messages: history, at: '2026-10-29T10:00:00.000Z' });
  assert.equal(first.added.length, 1);
  assert.equal(first.duplicate.length, 0);
  assert.equal(store.stats('ayu', { scope: 'qq-a' }).messages, 1);

  const replay = store.archiveHistory('ayu', { scope: 'qq-a', messages: history, at: '2026-10-29T10:00:01.000Z' });
  assert.equal(replay.added.length, 0);
  assert.equal(replay.overlap, 1);
  assert.equal(replay.duplicate.length, 0);
  assert.equal(store.stats('ayu', { scope: 'qq-a' }).messages, 1);
});

test('repeating the same text later is still a new turn, not a history replay', () => {
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
  store.archiveHistory('ayu', { scope: 'qq-repeat', messages: [{ role: 'user', content: '在吗？' }] });
  const later = store.archiveTurn('ayu', {
    scope: 'qq-repeat', userId: 'u2', assistantId: 'a2', userText: '在吗？', assistantText: '在。',
  });
  assert.equal(later.user.duplicate, undefined);
  assert.equal(store.stats('ayu', { scope: 'qq-repeat' }).messages, 3);
  assert.deepEqual(store.bookFor('ayu').recent(3, { scope: 'qq-repeat' }).map(item => item.text), ['在吗？', '在吗？', '在。']);
});

test('archiving a turn twice with explicit message ids is idempotent', () => {
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
  store.archiveTurn('ayu', {
    userId: 'u1', assistantId: 'a1', userText: '票还在吗？', assistantText: '在，靠窗。',
  });
  const second = store.archiveTurn('ayu', {
    userId: 'u1', assistantId: 'a1', userText: '票还在吗？', assistantText: '在，靠窗。',
  });
  assert.equal(second.user.duplicate, true);
  assert.equal(second.assistant.duplicate, true);
  assert.equal(store.stats('ayu').messages, 2);
});

test('idempotent archive never relabels an existing message into another session', () => {
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
  store.archiveTurn('ayu', { scope: 'session-a', userId: 'u1', assistantId: 'a1', userText: 'A 的问。', assistantText: 'A 的答。' });
  const duplicate = store.archiveTurn('ayu', { scope: 'session-b', userId: 'u1', assistantId: 'a1', userText: 'A 的问。', assistantText: 'A 的答。' });
  assert.equal(duplicate.user.duplicate, true);
  assert.equal(duplicate.user.scope, 'session-a');
  assert.equal(store.stats('ayu', { scope: 'session-b' }).messages, 0);
});

test('gateway archives a bounded scene card after enough new turns', () => {
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼', voice: ['短句'] });
  for (let i = 1; i <= 6; i += 1) {
    store.archiveTurn('ayu', {
      userId: `u${i}`, assistantId: `a${i}`,
      userText: `第${i}轮，票和伞。`, assistantText: `第${i}次回答，知道了。`,
    });
  }
  const card = store.autoCompact('ayu', { throughSeq: 12, maxEvents: 3, quotes: 1 });
  assert.ok(card);
  assert.equal(card.event.length <= 3, true);
  assert.equal(card.quoteIds.length, 1);
  assert.equal(store.stats('ayu').messages, 12);
});
test('different sessions under one character have isolated recall', () => {
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
  store.remember({ characterId: 'ayu', sessionId: 'qq-user-a', role: 'user', id: 'a1', text: '用户A的靠窗票。' });
  store.remember({ characterId: 'ayu', sessionId: 'qq-user-b', role: 'user', id: 'b1', text: '用户B的海边票。' });
  const a = buildInjectedPrompt(store, 'ayu', {
    sessionId: 'qq-user-a',
    messages: [{ role: 'user', content: '票还在吗？' }],
  });
  const b = buildInjectedPrompt(store, 'ayu', {
    sessionId: 'qq-user-b',
    messages: [{ role: 'user', content: '票还在吗？' }],
  });
  assert.match(a.debug.hits.map(hit => hit.id).join(','), /a1/);
  assert.doesNotMatch(a.debug.hits.map(hit => hit.id).join(','), /b1/);
  assert.match(b.debug.hits.map(hit => hit.id).join(','), /b1/);
  assert.doesNotMatch(b.debug.hits.map(hit => hit.id).join(','), /a1/);
});


test('metadata session aliases route recall without cross-session leakage', () => {
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
  store.remember({ characterId: 'ayu', scope: 'meta-a', id: 'ma', role: 'user', text: 'A 的靠窗票' });
  store.remember({ characterId: 'ayu', scope: 'meta-b', id: 'mb', role: 'user', text: 'B 的海边票' });
  const a = buildInjectedPrompt(store, 'ayu', {
    metadata: { sessionId: 'meta-a' }, messages: [{ role: 'user', content: '票' }],
  });
  const b = buildInjectedPrompt(store, 'ayu', {
    metadata: { session_id: 'meta-b' }, messages: [{ role: 'user', content: '票' }],
  });
  assert.equal(a.debug.scope, 'meta-a');
  assert.equal(b.debug.scope, 'meta-b');
  assert.deepEqual(a.debug.hits.map(hit => hit.id), ['ma']);
  assert.deepEqual(b.debug.hits.map(hit => hit.id), ['mb']);
  assert.doesNotMatch(a.messages[0].content, /海边票/);
  assert.doesNotMatch(b.messages[0].content, /靠窗票/);
});

test('gateway injects current facts and hides superseded values from current-state questions', () => {
  const store = createStore({ root: ':memory:' });
  try {
    store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'] });
    store.remember({ characterId: 'ayu', id: 'old', role: 'user', text: '我住城东。', sessionId: 'qq-a' });
    store.remember({ characterId: 'ayu', id: 'new', role: 'user', text: '我搬到城西了。', sessionId: 'qq-a' });
    const oldFact = store.setFact({ characterId: 'ayu', sessionId: 'qq-a', key: '住址', value: '城东', sourceId: 'old' });
    store.setFact({ characterId: 'ayu', sessionId: 'qq-a', key: '住址', value: '城西', sourceId: 'new', supersedes: oldFact.id });
    const current = buildInjectedPrompt(store, 'ayu', {
      messages: [{ role: 'user', content: '我现在住哪里？' }], sessionId: 'qq-a',
    });
    assert.match(current.messages[0].content, /<fact_state>/);
    assert.match(current.messages[0].content, /当前事实：住址 = 城西/);
    assert.doesNotMatch(current.messages[0].content, /当前事实：住址 = 城东/);
    const past = buildInjectedPrompt(store, 'ayu', {
      messages: [{ role: 'user', content: '我以前住哪里？' }], sessionId: 'qq-a',
    });
    assert.match(past.messages[0].content, /历史事实：住址 曾是 城东/);
  } finally {
    store.close();
  }
});

test('automatic prompt recall is throttled to once per day per memory', () => {
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼' });
  store.remember({ characterId: 'ayu', id: 'coffee', role: 'user', text: '我喜欢冰美式。', sessionId: 's' });
  const first = store.promptView('ayu', { query: '我喜欢什么？', scope: 's', includeRecent: false, now: '2026-10-01T10:00:00+08:00' });
  assert.ok(first.hits.some(hit => hit.id === 'coffee'));
  store.reinforcePromptHits('ayu', first.hits, { at: '2026-10-01T10:00:00+08:00' });
  const second = store.promptView('ayu', { query: '我喜欢什么？', scope: 's', includeRecent: false, now: '2026-10-01T18:00:00+08:00' });
  const throttled = store.reinforcePromptHits('ayu', second.hits, { at: '2026-10-01T18:00:00+08:00' });
  assert.equal(throttled.find(state => state.id === 'coffee').reinforced, false);
  assert.equal(store.strength('ayu', 'coffee').recallCount, 1);
  const nextDay = store.promptView('ayu', { query: '我喜欢什么？', scope: 's', includeRecent: false, now: '2026-10-02T18:00:00+08:00' });
  const reinforced = store.reinforcePromptHits('ayu', nextDay.hits, { at: '2026-10-02T18:00:00+08:00' });
  assert.equal(reinforced.find(state => state.id === 'coffee').reinforced, true);
  assert.equal(store.strength('ayu', 'coffee').recallCount, 2);
});

test('gateway injects recent injury and plan for broad recent questions', () => {
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'] });
  const rows = [
    ['old', 'user', '去年陪朋友去过一次医院。', '2026-01-10T10:00:00+08:00', []],
    ['injury', 'user', '昨天晚上我摔了一跤，膝盖现在还疼，今天去医院拍了片子。', '2026-10-28T21:30:00+08:00', ['重要']],
    ['plan', 'user', '明天下午三点去人民医院复查，别忘了带病历本。', '2026-10-28T21:31:00+08:00', ['约定']],
  ];
  for (const [id, role, text, at, tags] of rows) {
    store.remember({ characterId: 'ayu', id, role, text, at, tags, scope: 's' });
  }
  const body = buildInjectedPrompt(store, 'ayu', {
    sessionId: 's',
    messages: [{ role: 'user', content: '我最近身体有什么情况？' }],
  }, { at: '2026-10-29T10:00:00+08:00' });
  assert.match(body.messages[0].content, /膝盖现在还疼/);
  assert.doesNotMatch(body.messages[0].content, /去年陪朋友/);
  const schedule = buildInjectedPrompt(store, 'ayu', {
    sessionId: 's',
    messages: [{ role: 'user', content: '我最近有什么安排？' }],
  }, { at: '2026-10-29T10:00:00+08:00' });
  assert.match(schedule.messages[0].content, /人民医院复查/);
  assert.doesNotMatch(schedule.messages[0].content, /去年陪朋友/);
});

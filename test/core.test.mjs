import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryMirror, acceptanceChecks } from '../src/core.mjs';

const now = (n) => `2026-10-${String(n).padStart(2, '0')}T10:00:00+08:00`;

test('snapshot keeps exact soul, voice and relationship anchors out of compaction', () => {
  const book = createMemoryMirror({
    characterId: 'ayu',
    soul: '阿鱼：嘴硬心软，先损后哄，不主动说教。',
    voice: ['叫她老板', '生气时先沉默两次呼吸', '开心时会拖长尾音'],
  });
  book.append({ id: 'm1', role: 'user', text: '第一次见面，她叫我老板。', at: now(1) });
  book.append({ id: 'm2', role: 'assistant', text: '知道了，老板。', at: now(1) });
  const view = book.promptView({ query: '你还记得第一次怎么叫我吗？', recent: 4 });
  assert.match(view.prompt, /阿鱼：嘴硬心软/);
  assert.match(view.prompt, /叫她老板/);
  assert.match(view.prompt, /第一次见面/);
  assert.doesNotMatch(view.prompt, /voice: /);
});

test('compaction keeps original styling and backlinks, without deleting source messages', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  const a = book.append({ id: 'm1', role: 'user', text: '别淋雨。', at: now(1) });
  const b = book.append({ id: 'm2', role: 'assistant', text: '不用你管。伞往你那边偏了一点。', at: now(1) });
  book.compactThrough(b.seq, {
    card: {
      time: '十月一日晚上', place: '街口', present: ['阿鱼', '老板'],
      event: ['下雨', '共伞'], relation: '嘴硬但开始照顾',
      state: ['伞在阿鱼手里'], open: ['未说出口的担心'],
      quoteIds: [a.id, b.id],
    },
  });
  const card = book.cards()[0];
  assert.deepEqual(card.quoteIds, ['m1', 'm2']);
  assert.equal(card.quote[0].text, '别淋雨。');
  assert.equal(card.quote[1].text, '不用你管。伞往你那边偏了一点。');
  assert.equal(book.get(a.id).text, '别淋雨。');
  assert.equal(book.get(b.id).text, '不用你管。伞往你那边偏了一点。');
});

test('incremental card keeps changed fields and explicit supersession', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'm1', role: 'user', text: '我们在街口。', at: now(1) });
  book.compactThrough(1, { card: { event: ['共伞'], relation: '疏远' } });
  book.append({ id: 'm2', role: 'assistant', text: '下次别来了。', at: now(2) });
  book.compactThrough(2, { card: { relation: '嘴硬但关心', supersedes: 'c1' } });
  assert.equal(book.cards().length, 2);
  assert.equal(book.cards()[1].relation, '嘴硬但关心');
  assert.equal(book.getCard('c1').status, 'superseded');
});

test('anchor does not duplicate sentence punctuation at the soul boundary', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '嘴硬心软。', voice: ['短句'], relationship: '试探' });
  const text = book.anchor();
  assert.doesNotMatch(text, /。。/);
  assert.match(text, /你是嘴硬心软/);
});

test('anchor is short and explicitly prevents recital', () => {
  const book = createMemoryMirror({
    characterId: 'ayu', soul: '阿鱼：嘴硬心软', voice: ['叫她老板', '短句'],
    relationship: '互相试探',
  });
  const anchor = book.anchor();
  assert.ok(anchor.length <= 240);
  assert.match(anchor, /阿鱼/);
  assert.match(anchor, /老板/);
  assert.match(anchor, /不要复述/);
});

test('numeric timestamp strings are normalized before retrieval sorting', () => {
  const book = createMemoryMirror({
    characterId: 'ayu', soul: '嘴硬心软', voice: ['叫她老板'], relationship: '试探',
  });
  book.append({ id: 'numeric-string', role: 'user', text: '票还在吗？', at: '1793253620333' });
  assert.equal(book.read('numeric-string').at, '2026-10-29T06:00:20.333Z');
  assert.doesNotThrow(() => book.search('票'));
});

test('retrieval sorts mixed numeric and ISO timestamps without throwing', () => {
  const book = createMemoryMirror({
    characterId: 'ayu', soul: '嘴硬心软', voice: ['叫她老板'], relationship: '试探',
  });
  book.append({ id: 'numeric', role: 'user', text: '票还在吗？', at: 1793253620333 });
  book.append({ id: 'iso', role: 'user', text: '票还在。', at: '2026-10-29T13:00:00.000Z' });
  const hits = book.search('票');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(hit => hit.id).sort(), ['iso', 'numeric']);
});

test('retrieval prioritizes meaningful query terms over common single characters', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'rain', role: 'user', text: '老板，外面下雨了，我伞忘在公司。', at: now(1) });
  book.append({ id: 'ticket', role: 'user', text: '老板，明天给我留一张靠窗的票。', at: now(2) });
  book.append({ id: 'candy', role: 'user', text: '别偷吃我桌上的糖。', at: now(3) });
  const both = book.search('票和伞', { limit: 4 });
  assert.deepEqual(both.map(hit => hit.id).sort(), ['rain', 'ticket']);
  assert.ok(!both.some(hit => hit.id === 'candy'));
  const seat = book.search('我坐哪儿来着？', { limit: 4 });
  assert.ok(seat.some(hit => hit.id === 'ticket'));
  assert.ok(!seat.some(hit => hit.id === 'candy'));
});

test('prompt policy requires preserving gift and promise direction', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'gift', role: 'user', text: '你送我的旧书签，背面写着下次别迟到。', at: now(1), scope: 's' });
  const view = book.promptView({ query: '你送过我什么？', scope: 's', includeRecent: false });
  assert.match(view.prompt, /逐字保留主语和方向/);
  assert.match(view.prompt, /我送你的.*不能写成.*我送过你/);
  assert.match(view.prompt, /不主动展开隐私、药物、地址/);
  assert.match(view.prompt, /旧书签/);
});

test('prompt includes a bounded hit snippet so the model can use retrieved facts', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'allergy', role: 'user', text: '我对花生过敏，别给我点带花生的菜。', at: now(1) });
  book.append({ id: 'noise', role: 'user', text: '今天普通闲聊。', at: now(2) });
  const view = book.promptView({ query: '我有什么东西不能吃？', includeRecent: false });
  assert.ok(view.hits.some(hit => hit.id === 'allergy'), JSON.stringify(view.hits));
  assert.ok(view.hits.some(hit => hit.id === 'allergy'));
  assert.match(view.prompt, /花生过敏/);
  assert.ok(view.prompt.length < 500);
});

test('retrieval is explainable and returns metadata before full text', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'm1', role: 'user', text: '上次说周五留票。', at: now(1), tags: ['票', '约定'] });
  const hits = book.search('票还有吗', { limit: 2 });
  assert.equal(hits[0].id, 'm1');
  assert.equal(hits[0].text, undefined);
  assert.ok(hits[0].why.includes('票'));
  assert.equal(book.read('m1').text, '上次说周五留票。');
});

test('auto compaction preserves assistant quotes and source ids', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  for (let i = 1; i <= 12; i += 1) {
    book.append({ id: `m${i}`, role: i % 2 ? 'user' : 'assistant', text: `第${i}句。这里有一点情绪和细节。`, at: now(i) });
  }
  const card = book.autoCompact({ throughSeq: 8, quotes: 2 });
  assert.equal(card.status, 'active');
  assert.equal(card.event.length <= 5, true);
  assert.equal(card.quote.length, 2);
  assert.equal(card.quote.at(-1).role, 'assistant');
  assert.equal(book.stats().messages, 12);
  assert.equal(book.stats().rawChars > book.stats().cardChars, true);
});

test('snapshot round-trips without losing raw messages, cards or compaction state', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'm1', role: 'user', text: '别淋雨。', at: now(1) });
  book.append({ id: 'm2', role: 'assistant', text: '不用你管。伞往你那边偏了一点。', at: now(1) });
  book.compactThrough(2, { card: { event: ['共伞'], quoteIds: ['m2'] } });
  const restored = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'], snapshot: book.snapshot() });
  assert.deepEqual(restored.snapshot(), book.snapshot());
  assert.equal(restored.get('m1').text, '别淋雨。');
  assert.equal(restored.cards()[0].quote[0].text, '不用你管。伞往你那边偏了一点。');
});

test('acceptance checks reject summaries without voice, quotes or anchor', () => {
  const report = acceptanceChecks({
    messages: [{ role: 'assistant', text: '好的。' }],
    cards: [{ event: ['聊天'], quoteIds: [] }],
    hasAnchor: false,
  });
  assert.equal(report.pass, false);
  assert.deepEqual(report.failed.sort(), ['anchor_missing', 'quotes_missing', 'voice_missing']);
});

test('retrieval blends relevance, recency and importance instead of raw keyword count alone', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'old-important', role: 'user', text: '答应我，永远别消失。', at: now(1), tags: ['重要'] });
  book.append({ id: 'recent-noise', role: 'user', text: '老板，今天票又提了一次。', at: now(20) });
  const hits = book.search('你以前答应过永远别消失吗？', { limit: 2 });
  assert.equal(hits[0].id, 'old-important');
});

test('auto cards prefer human event sentences and keep the latest context', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  for (let i = 1; i <= 12; i += 1) {
    book.append({ id: `u${i}`, role: 'user', text: i === 1 ? '答应我永远别消失。' : `第${i}轮，票和伞。`, at: now(i) });
    book.append({ id: `a${i}`, role: 'assistant', text: `第${i}次回答，知道了。`, at: now(i) });
  }
  const card = book.autoCompact({ throughSeq: 24, maxEvents: 4, quotes: 1 });
  assert.match(card.event[0], /答应我永远别消失/);
  assert.match(card.event[1], /第2轮/);
  assert.match(card.event.at(-1), /第12轮/);
  assert.equal(card.quoteIds[0], 'a12');
});
test('auto cards choose expressive assistant quotes over repeated low-value replies', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'u1', role: 'user', text: '别淋雨。', at: now(1) });
  book.append({ id: 'a1', role: 'assistant', text: '收到。', at: now(1) });
  book.append({ id: 'u2', role: 'user', text: '伞拿着。', at: now(2) });
  book.append({ id: 'a2', role: 'assistant', text: '不用你管。伞往你那边偏了一点。', at: now(2) });
  book.append({ id: 'u3', role: 'user', text: '票别忘了。', at: now(3) });
  book.append({ id: 'a3', role: 'assistant', text: '知道了。', at: now(3) });
  const card = book.autoCompact({ throughSeq: 6, quotes: 1 });
  assert.deepEqual(card.quoteIds, ['a2']);
});


test('scene cards and compaction cursors are isolated per scope', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'a-u', role: 'user', text: 'A 的靠窗票。', at: now(1), scope: 'a' });
  book.append({ id: 'a-a', role: 'assistant', text: 'A 的票留好了。', at: now(1), scope: 'a' });
  book.append({ id: 'b-u', role: 'user', text: 'B 的海边票。', at: now(2), scope: 'b' });
  book.append({ id: 'b-a', role: 'assistant', text: 'B 的票留好了。', at: now(2), scope: 'b' });
  const aCard = book.autoCompact({ throughSeq: 4, scope: 'a', quotes: 1 });
  const bCard = book.autoCompact({ throughSeq: 4, scope: 'b', quotes: 1 });
  assert.deepEqual(aCard.quoteIds, ['a-a']);
  assert.deepEqual(bCard.quoteIds, ['b-a']);
  assert.equal(book.cards({ scope: 'a' }).length, 1);
  assert.equal(book.cards({ scope: 'b' }).length, 1);
  assert.equal(book.stats({ scope: 'a' }).lastCompactedSeq, 2);
  assert.equal(book.stats({ scope: 'b' }).lastCompactedSeq, 4);
  assert.equal(book.stats({ scope: 'b' }).cards, 1);
  assert.equal(book.stats({ scope: 'b' }).lastSeq, 4);
  assert.doesNotMatch(book.promptView({ query: '票', scope: 'a' }).prompt, /海边票|B 的票/);
  const restored = createMemoryMirror({ characterId: 'ayu', snapshot: book.snapshot() });
  assert.equal(restored.stats({ scope: 'a' }).lastCompactedSeq, 2);
  assert.equal(restored.stats({ scope: 'b' }).lastCompactedSeq, 4);
});


test('early durable facts remain recallable after many later scene cards', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'ticket', role: 'user', text: '老板，明天给我留一张靠窗的票。', at: now(1), scope: 'long' });
  book.append({ id: 'ticket-reply', role: 'assistant', text: '留了，靠窗。别弄丢。', at: now(1), scope: 'long' });
  for (let i = 2; i <= 240; i += 1) {
    book.append({ id: `u${i}`, role: 'user', text: `第${i}轮普通对话。`, at: now(Math.min(28, i % 28 + 1)), scope: 'long' });
    book.append({ id: `a${i}`, role: 'assistant', text: `第${i}轮回应。`, at: now(Math.min(28, i % 28 + 1)), scope: 'long' });
    if (i % 20 === 0) book.autoCompact({ throughSeq: i * 2, scope: 'long', maxEvents: 5, quotes: 2 });
  }
  const view = book.promptView({ query: '我坐哪儿来着？', includeRecent: false, scope: 'long' });
  assert.ok(view.hits.some(hit => hit.id === 'ticket'));
  assert.ok(view.cards.length <= 6);
  assert.ok(view.chars < book.stats({ scope: 'long' }).rawChars);
});


test('two cards in one scope have distinct ranges and cursors', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼' });
  for (let i = 1; i <= 8; i += 1) book.append({ id: `m${i}`, role: i % 2 ? 'user' : 'assistant', text: `第${i}条。`, at: now(i), scope: 's' });
  const first = book.autoCompact({ throughSeq: 4, scope: 's', maxEvents: 2, quotes: 1 });
  const second = book.autoCompact({ throughSeq: 8, scope: 's', maxEvents: 2, quotes: 1 });
  assert.equal(first.fromSeq, 1);
  assert.equal(first.toSeq, 4);
  assert.equal(second.fromSeq, 5);
  assert.equal(second.toSeq, 8);
  assert.equal(book.stats({ scope: 's' }).lastCompactedSeq, 8);
});

test('fact state supersedes stale value without deleting its source', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'old', role: 'user', text: '我明天坐靠窗。', at: now(1), scope: 's' });
  book.append({ id: 'new', role: 'user', text: '票改期了，我现在坐过道。', at: now(2), scope: 's' });
  const oldFact = book.setFact({
    scope: 's', key: '座位', value: '靠窗', sourceId: 'old', at: now(1),
  });
  book.setFact({
    scope: 's', key: '座位', value: '过道', sourceId: 'new', at: now(2), supersedes: oldFact.id,
  });
  const facts = book.facts({ scope: 's' });
  assert.equal(facts.active.length, 1);
  assert.equal(facts.active[0].value, '过道');
  assert.equal(facts.history.length, 1);
  assert.equal(facts.history[0].value, '靠窗');
  assert.equal(book.get('old').text, '我明天坐靠窗。');
  assert.equal(book.facts({ scope: 's' }).active[0].sourceId, 'new');
});

test('prompt distinguishes current fact from historical fact', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'home-old', role: 'user', text: '我住城东。', at: now(1), scope: 's' });
  book.append({ id: 'home-new', role: 'user', text: '我搬到城西了。', at: now(2), scope: 's' });
  const oldHome = book.setFact({ scope: 's', key: '住址', value: '城东', sourceId: 'home-old', at: now(1) });
  book.setFact({ scope: 's', key: '住址', value: '城西', sourceId: 'home-new', at: now(2), supersedes: oldHome.id });
  const current = book.promptView({ query: '我现在住哪里？', scope: 's', includeRecent: false });
  assert.match(current.prompt, /当前事实/);
  assert.match(current.prompt, /城西/);
  assert.doesNotMatch(current.prompt, /当前事实[^\n]*城东/);
  const past = book.promptView({ query: '我以前住哪里？', scope: 's', includeRecent: false });
  assert.match(past.prompt, /历史事实/);
  assert.match(past.prompt, /城东/);
});

test('fact snapshots round-trip and stay isolated by scope', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'a-src', role: 'user', text: 'A 住城东。', at: now(1), scope: 'a' });
  book.setFact({ scope: 'a', key: '住址', value: '城东', sourceId: 'a-src', at: now(1) });
  const restored = createMemoryMirror({ characterId: 'ayu', snapshot: book.snapshot() });
  assert.equal(restored.facts({ scope: 'a' }).active[0].value, '城东');
  assert.equal(restored.facts({ scope: 'b' }).active.length, 0);
  assert.doesNotMatch(restored.promptView({ query: '住址', scope: 'b' }).prompt, /城东/);
});

test('auto facts supersede only high-confidence key-value updates', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'u1', role: 'user', text: '我住在城东。', at: now(1), scope: 's' });
  book.append({ id: 'u2', role: 'user', text: '我搬到城西了。', at: now(2), scope: 's' });
  book.autoCompact({ throughSeq: 2, scope: 's', quotes: 1 });
  const state = book.facts({ scope: 's' });
  assert.equal(state.active.find(item => item.key === '住址')?.value, '城西');
  assert.equal(state.history.find(item => item.key === '住址')?.value, '城东');
  book.append({ id: 'u3', role: 'user', text: '我昨天吃了面。', at: now(3), scope: 's' });
  book.autoCompact({ throughSeq: 3, scope: 's', quotes: 1 });
  assert.equal(book.facts({ scope: 's' }).active.some(item => item.value.includes('面')), false);
});

test('memory strength decays with time but important and reinforced memories survive', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'smalltalk', role: 'user', text: '今天楼下的猫叫了一声。', at: now(1), scope: 's' });
  book.append({ id: 'important', role: 'user', text: '我对花生过敏，绝对不能吃。', at: now(1), tags: ['重要'], scope: 's' });
  book.append({ id: 'repeat', role: 'user', text: '我还是喜欢喝冰美式。', at: now(1), scope: 's' });
  book.recall('repeat', { at: now(20) });
  book.recall('repeat', { at: now(40) });
  const later = Date.parse('2026-12-01T10:00:00+08:00');
  const smalltalkScore = book.strength('smalltalk', { now: later });
  const importantScore = book.strength('important', { now: later });
  const repeatedScore = book.strength('repeat', { now: later });
  assert.ok(smalltalkScore.retention < 0.25);
  assert.equal(importantScore.protected, true);
  assert.ok(importantScore.retention >= 0.99);
  assert.ok(repeatedScore.retention > smalltalkScore.retention);
  assert.equal(book.get('smalltalk').text, '今天楼下的猫叫了一声。');
});

test('prompt does not surface decayed small talk when a protected fact matches', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'old-noise', role: 'user', text: '花生味的糖真难吃。', at: now(1), scope: 's' });
  book.append({ id: 'allergy', role: 'user', text: '我对花生过敏，不能吃。', at: now(2), tags: ['重要'], scope: 's' });
  const view = book.promptView({ query: '我能吃花生吗？', scope: 's', now: Date.parse('2026-12-01T10:00:00+08:00'), includeRecent: false });
  assert.match(view.prompt, /花生过敏/);
  assert.ok(view.hits.some(hit => hit.id === 'allergy'));
});

test('recall reinforcement survives a snapshot round-trip', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼' });
  book.append({ id: 'm1', role: 'user', text: '我喜欢冰美式。', at: now(1), scope: 's' });
  book.recall('m1', { at: now(20) });
  const restored = createMemoryMirror({ characterId: 'ayu', snapshot: book.snapshot() });
  assert.equal(restored.strength('m1', { now: now(31) }).recallCount, 1);
  assert.throws(() => restored.recall('missing'), /memory not found/);
});

test('protected memory and repeatedly recalled memory keep more strength than idle small talk', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼' });
  book.append({ id: 'idle', role: 'user', text: '今天楼下有一只橘猫。', at: '2026-01-01T10:00:00+08:00', scope: 's' });
  book.append({ id: 'used', role: 'user', text: '我喜欢冰美式。', at: '2026-01-01T10:00:00+08:00', scope: 's' });
  book.append({ id: 'safe', role: 'user', text: '我对花生过敏。', at: '2026-01-01T10:00:00+08:00', scope: 's' });
  for (let day = 10; day <= 170; day += 20) book.recall('used', { at: `2026-01-${day}T10:00:00+08:00` });
  const at = '2026-06-30T10:00:00+08:00';
  const idleScore = book.strength('idle', { now: at });
  const usedScore = book.strength('used', { now: at });
  const safeScore = book.strength('safe', { now: at });
  assert.ok(idleScore.retention < 0.01);
  assert.ok(usedScore.retention > idleScore.retention * 10);
  assert.equal(safeScore.protected, true);
  assert.equal(book.get('idle').text, '今天楼下有一只橘猫。');
});

test('broad recent-event questions surface recent important events within the topic window', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'old', role: 'user', text: '去年陪朋友去过一次医院。', at: '2026-01-10T10:00:00+08:00', scope: 's' });
  book.append({ id: 'injury', role: 'user', text: '昨天晚上我摔了一跤，膝盖现在还疼，今天去医院拍了片子。', at: '2026-10-28T21:30:00+08:00', tags: ['重要'], scope: 's' });
  book.append({ id: 'plan', role: 'user', text: '明天下午三点去人民医院复查，别忘了带病历本。', at: '2026-10-28T21:31:00+08:00', tags: ['约定'], scope: 's' });
  const body = book.promptView({ query: '我最近身体有什么情况？', scope: 's', includeRecent: false, now: '2026-10-29T10:00:00+08:00' });
  assert.ok(body.hits.some(hit => hit.id === 'injury'), JSON.stringify(body.hits));
  assert.ok(!body.hits.some(hit => hit.id === 'old'), JSON.stringify(body.hits));
  const schedule = book.promptView({ query: '我最近有什么安排？', scope: 's', includeRecent: false, now: '2026-10-29T10:00:00+08:00' });
  assert.ok(schedule.hits.some(hit => hit.id === 'plan'), JSON.stringify(schedule.hits));
  assert.ok(!schedule.hits.some(hit => hit.id === 'old'), JSON.stringify(schedule.hits));
});

test('recent event text remains visible after it has been compacted into a scene card', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'u1', role: 'user', text: '昨天晚上我摔了一跤，膝盖现在还疼。', at: '2026-10-28T21:30:00+08:00', tags: ['重要'], scope: 's' });
  book.append({ id: 'a1', role: 'assistant', text: '怎么这么不小心。', at: '2026-10-28T21:30:05+08:00', scope: 's' });
  book.autoCompact({ throughSeq: 2, scope: 's', maxEvents: 5, quotes: 1 });
  const view = book.promptView({ query: '我最近身体有什么情况？', scope: 's', includeRecent: false, now: '2026-10-29T10:00:00+08:00' });
  assert.match(view.prompt, /膝盖现在还疼/);
});

test('broad what happened recently excludes stale events unless directly asked', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'old-allergy', role: 'user', text: '我对花生过敏，绝对不能吃。', at: '2026-01-10T10:00:00+08:00', tags: ['重要'], scope: 's' });
  book.append({ id: 'recent-injury', role: 'user', text: '昨天晚上我摔了一跤，膝盖现在还疼。', at: '2026-10-28T21:30:00+08:00', tags: ['重要'], scope: 's' });
  const broad = book.promptView({ query: '我最近发生了什么重要的事？', scope: 's', includeRecent: false, now: '2026-10-29T10:00:00+08:00' });
  assert.deepEqual(broad.hits.map(hit => hit.id).sort(), ['recent-injury']);
  const direct = book.promptView({ query: '我能吃花生吗？', scope: 's', includeRecent: false, now: '2026-10-29T10:00:00+08:00' });
  assert.ok(direct.hits.some(hit => hit.id === 'old-allergy'));
});


test('memory mirror pinning protects an entry from decay and can be unpinned', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'] });
  book.append({ id: 'promise', role: 'user', text: '我答应你周五一起去看海。', at: '2026-01-01T10:00:00+08:00', scope: 's' });
  book.append({ id: 'small', role: 'user', text: '今天楼下的猫叫了一声。', at: '2026-01-01T10:00:00+08:00', scope: 's' });
  const before = book.strength('promise', { now: '2027-01-01T10:00:00+08:00' });
  assert.ok(before.retention < 0.1);
  const pinned = book.pin('promise');
  assert.equal(pinned.pinned, true);
  const after = book.strength('promise', { now: '2027-01-01T10:00:00+08:00' });
  assert.equal(after.retention, 1);
  assert.equal(after.protected, true);
  assert.equal(book.strength('small', { now: '2027-01-01T10:00:00+08:00' }).protected, false);
  const restored = createMemoryMirror({ characterId: 'ayu', snapshot: book.snapshot() });
  assert.equal(restored.read('promise').pinned, true);
  assert.equal(restored.strength('promise', { now: '2027-01-01T10:00:00+08:00' }).retention, 1);
  const unpinned = restored.unpin('promise');
  assert.equal(unpinned.pinned, false);
  assert.ok(restored.strength('promise', { now: '2027-01-01T10:00:00+08:00' }).retention < 0.1);
  assert.throws(() => restored.pin('missing'), /memory not found/);
});

test('hit snippet clips to the sentence the question is about and keeps the full text readable', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '海边旧书店店员', voice: [], relationship: '试探' });
  const full = '老板，我叫小满。我花生过敏，绝对不能吃。周五给我留一张靠窗的票，别记错了。';
  book.append({ id: 'u1', role: 'user', text: full, at: now(1), scope: 's', tags: ['重要'] });
  for (let i = 2; i <= 12; i += 1) {
    book.append({ id: `u${i}`, role: 'user', text: '今天海风很大。', at: now(i), scope: 's' });
  }
  const [promise] = book.search('把我说过的那句约定原话尽量复述出来。', { scope: 's', limit: 1 });
  assert.match(promise.snippet, /靠窗/);
  assert.doesNotMatch(promise.snippet, /花生过敏/);
  const [allergy] = book.search('我花生过敏吗？', { scope: 's', limit: 1 });
  assert.match(allergy.snippet, /过敏/);
  assert.equal(book.read('u1').text, full);
});

test('prompt policy forbids dumping a whole message and bans meta phrasing', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: [], relationship: '试探' });
  book.append({ id: 'u1', role: 'user', text: '周五给我留一张靠窗的票，别记错了。', at: now(1), scope: 's' });
  const view = book.promptView({ query: '约定原话', scope: 's', recent: 0, maxCards: 0, includeRecent: false });
  assert.match(view.prompt, /复述只给相关那一句/);
  assert.match(view.prompt, /不说“根据记忆\/资料”/);
});

test('voice samples expose a few short assistant lines and never user lines', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: [], relationship: '试探' });
  book.append({ id: 'u1', role: 'user', text: '老板，今天风很大。', at: now(1), scope: 's' });
  book.append({ id: 'a1', role: 'assistant', text: '行吧，别又淋感冒。', at: now(1), scope: 's' });
  book.append({ id: 'a2', role: 'assistant', text: '谁管你。', at: now(2), scope: 's' });
  book.append({ id: 'a3', role: 'assistant', text: '谁管你。', at: now(3), scope: 's' });
  book.append({ id: 'a4', role: 'assistant', text: '记住了，下次先问。', at: now(4), scope: 's' });
  const view = book.promptView({ query: '在吗', scope: 's', recent: 0, maxCards: 0, includeRecent: false, voiceSamples: 2 });
  assert.deepEqual(view.voiceSamples, ['谁管你。', '记住了，下次先问。']);
  assert.match(view.prompt, /<voice_samples>/);
  assert.doesNotMatch(view.prompt, /今天风很大/);
});

test('voice samples stay optional and bounded', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: [], relationship: '试探' });
  book.append({ id: 'a1', role: 'assistant', text: '行吧，别又淋感冒。', at: now(1), scope: 's' });
  const off = book.promptView({ query: '在吗', scope: 's', recent: 0, maxCards: 0, includeRecent: false, voiceSamples: 0 });
  assert.deepEqual(off.voiceSamples, []);
  assert.doesNotMatch(off.prompt, /<voice_samples>/);
  const on = book.promptView({ query: '在吗', scope: 's', recent: 0, maxCards: 0, includeRecent: false });
  assert.equal(on.voiceSamples.length, 1);
  assert.ok(on.prompt.length - off.prompt.length < 200);
});

test('rarer query terms outrank terms that appear in every message', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: [] });
  book.append({ id: 'rare', role: 'user', text: '灯塔的灯还亮着。', at: now(1), scope: 's' });
  for (let i = 2; i <= 6; i += 1) {
    book.append({ id: `common${i}`, role: 'user', text: '今天海风很大。', at: now(i), scope: 's' });
  }
  const hits = book.search('海风 灯塔', { scope: 's', limit: 3 });
  assert.equal(hits[0].id, 'rare');
});

test('prompt drops duplicate hit snippets instead of repeating them', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: [] });
  book.append({ id: 'a', role: 'user', text: '周五给我留一张靠窗的票。', at: now(1), scope: 's' });
  book.append({ id: 'b', role: 'user', text: '周五给我留一张靠窗的票。', at: now(2), scope: 's' });
  const view = book.promptView({ query: '票', scope: 's', includeRecent: false, maxCards: 0 });
  assert.equal(view.hits.length, 1);
});

test('prompt budget trims optional sections but keeps policy and anchor', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'], relationship: '试探' });
  for (let i = 1; i <= 12; i += 1) {
    book.append({ id: `m${i}`, role: 'user', text: `第${i}轮：今天海风很大，我们聊了很久。`, at: now(i), scope: 's' });
  }
  const view = book.promptView({ query: '海风', scope: 's', includeRecent: true, recent: 12, maxCards: 0, maxPromptChars: 450 });
  assert.ok(view.prompt.length <= 450, String(view.prompt.length));
  assert.equal(view.trimmed, true);
  assert.match(view.prompt, /<flavor_memory_policy>/);
  assert.match(view.prompt, /<flavor_anchor>/);
});

test('older scene cards that match the question outrank newer unrelated cards', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: [] });
  book.append({ id: 'u1', role: 'user', text: '我们在灯塔下见面。', at: now(1), scope: 's' });
  book.append({ id: 'a1', role: 'assistant', text: '嗯。', at: now(1), scope: 's' });
  book.compactThrough(2, { scope: 's', card: { event: ['在灯塔下见面'], quoteIds: ['a1'] } });
  book.append({ id: 'u2', role: 'user', text: '今天海风很大。', at: now(2), scope: 's' });
  book.append({ id: 'a2', role: 'assistant', text: '嗯。', at: now(2), scope: 's' });
  book.compactThrough(4, { scope: 's', card: { event: ['海风很大'], quoteIds: ['a2'] } });
  book.append({ id: 'u3', role: 'user', text: '晚饭有点咸。', at: now(3), scope: 's' });
  book.append({ id: 'a3', role: 'assistant', text: '嗯。', at: now(3), scope: 's' });
  book.compactThrough(6, { scope: 's', card: { event: ['晚饭有点咸'], quoteIds: ['a3'] } });
  const view = book.promptView({ query: '灯塔', scope: 's', includeRecent: false, maxCards: 1 });
  assert.equal(view.cards.length, 1);
  assert.match(view.cards[0].event.join(' '), /灯塔/);
});

test('near-duplicate hit snippets are collapsed to one', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: [] });
  book.append({ id: 'a', role: 'user', text: '周五给我留一张靠窗的票。', at: now(1), scope: 's' });
  book.append({ id: 'b', role: 'user', text: '周五给我留一张靠窗的票，别忘。', at: now(2), scope: 's' });
  const view = book.promptView({ query: '票', scope: 's', includeRecent: false, maxCards: 0 });
  assert.equal(view.hits.length, 1);
});

test('compaction extracts durable identity facts beyond address', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: [] });
  const lines = [
    '我生日是3月14日。',
    '我对花生过敏，不能吃。',
    '我是急诊科医生。',
    '我家养了一只叫豆豆的猫。',
    '我们的纪念日是十月一号。',
  ];
  lines.forEach((line, index) => {
    book.append({ id: `u${index + 1}`, role: 'user', text: line, at: now(index + 1), scope: 's' });
    book.append({ id: `a${index + 1}`, role: 'assistant', text: '嗯。', at: now(index + 1), scope: 's' });
  });
  book.autoCompact({ throughSeq: 10, scope: 's', maxEvents: 6, quotes: 1 });
  const keys = book.facts({ scope: 's' }).active.map(fact => `${fact.key}=${fact.value}`);
  assert.ok(keys.includes('生日=3月14日'), JSON.stringify(keys));
  assert.ok(keys.some(item => item.startsWith('忌口·')), JSON.stringify(keys));
  assert.ok(keys.some(item => item.startsWith('职业=')), JSON.stringify(keys));
  assert.ok(keys.includes('宠物=豆豆'), JSON.stringify(keys));
  assert.ok(keys.some(item => item.startsWith('纪念日·')), JSON.stringify(keys));
});

test('a new birthday supersedes the old one and keeps history', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: [] });
  book.append({ id: 'u1', role: 'user', text: '我生日是3月14日。', at: now(1), scope: 's' });
  book.append({ id: 'a1', role: 'assistant', text: '嗯。', at: now(1), scope: 's' });
  book.autoCompact({ throughSeq: 2, scope: 's', maxEvents: 4, quotes: 1 });
  book.append({ id: 'u2', role: 'user', text: '我生日其实是6月2日。', at: now(2), scope: 's' });
  book.append({ id: 'a2', role: 'assistant', text: '嗯。', at: now(2), scope: 's' });
  book.autoCompact({ throughSeq: 4, scope: 's', maxEvents: 4, quotes: 1 });
  const { active, history } = book.facts({ scope: 's' });
  const birthday = active.find(fact => fact.key === '生日');
  assert.equal(birthday.value, '6月2日');
  assert.ok(history.some(fact => fact.value === '3月14日'));
});

test('voice samples skip sensitive assistant lines', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: [] });
  book.append({ id: 'a1', role: 'assistant', text: '记得十点吃药。', at: now(1), scope: 's' });
  book.append({ id: 'a2', role: 'assistant', text: '行吧，别又淋感冒。', at: now(2), scope: 's' });
  book.append({ id: 'a3', role: 'assistant', text: '我的电话是13800138000。', at: now(3), scope: 's' });
  const view = book.promptView({ query: '在吗', scope: 's', includeRecent: false, maxCards: 0 });
  assert.deepEqual(view.voiceSamples, ['行吧，别又淋感冒。']);
  assert.doesNotMatch(view.prompt, /吃药|13800138000/);
});

test('prompt budget trims item by item instead of dropping a whole section', () => {
  const book = createMemoryMirror({ characterId: 'ayu', soul: '阿鱼', voice: ['短句'], relationship: '试探' });
  for (let i = 1; i <= 20; i += 1) {
    book.append({ id: `u${i}`, role: 'user', text: `第${i}轮：今天海风很大，我们在书店聊了很久，后来一起去海边走了走。`, at: `2026-10-${String(i).padStart(2, '0')}T10:00:00+08:00`, scope: 's' });
    book.append({ id: `a${i}`, role: 'assistant', text: '嗯。', at: `2026-10-${String(i).padStart(2, '0')}T10:00:00+08:00`, scope: 's' });
  }
  const view = book.promptView({ query: '海风', scope: 's', includeRecent: true, recent: 20, maxCards: 0, maxPromptChars: 900 });
  assert.equal(view.trimmed, true);
  assert.ok(view.prompt.length <= 900, String(view.prompt.length));
  assert.match(view.prompt, /<recent_turns>/);
  const lines = (view.prompt.match(/^user:/gm) || []).length;
  assert.ok(lines > 0 && lines < 10, String(lines));
});

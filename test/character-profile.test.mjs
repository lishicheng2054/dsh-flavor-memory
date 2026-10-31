import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyCharacterProfile, normalizeCharacterProfile, evaluateLore, selectExamples,
  renderProfilePrompt, createEvolutionCandidate, applyApprovedEvolution, profileToLegacy,
  importSillyTavernCard, rejectEvolution, restoreRevision, approveEvolution,
} from '../src/character-profile.mjs';
import { createProfileStore } from '../src/character-store.mjs';

test('profile normalizes SillyTavern-style fields and keeps defaults', () => {
  const profile = normalizeCharacterProfile({
    id: 'ayu', name: '阿鱼', description: '住在海边', personality: '嘴硬心软',
    scenario: '雨夜', firstMessage: '你来了。', soul: '阿鱼：不会抛下老板',
    voice: ['短句', '', '短句'], relationship: '试探',
    examples: [{ user: '你冷吗', assistant: '谁管你。', tags: ['关心'] }],
    worldbook: [{ name: '海边', content: '灯塔在城东。', keywords: ['海边'] }],
    triggers: [{ keywords: ['灯塔'], prompt: '灯塔只在夜里亮。' }],
    evolution: { soulMode: 'locked', voiceMode: 'bounded', requireEvidence: true },
  });
  assert.equal(profile.id, 'ayu'); assert.deepEqual(profile.voice, ['短句']);
  assert.equal(profile.examples[0].assistant, '谁管你。'); assert.equal(profile.worldbook[0].priority, 50);
  assert.equal(profile.evolution.soulMode, 'locked'); assert.equal(profile.evolution.voiceMode, 'bounded');
});

test('SillyTavern fields beyond the core prompt survive import, prompt and export', t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-tavern-fields-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'characters.json');
  const store = createProfileStore({ file, seed: {
    id: 'ayu', name: '阿鱼', soul: '嘴硬心软',
    systemPrompt: '保持第一人称。',
    postHistoryInstructions: '不要总结。',
    alternateGreetings: ['第二句开场。', '第三句开场。'],
    creatorNotes: '测试角色',
    creator: 'tester',
    characterVersion: '1.2.0',
    tags: ['日常', '嘴硬'],
  } });
  const exported = store.exportCharacter('ayu');
  assert.equal(exported.data.system_prompt, '保持第一人称。');
  assert.deepEqual(exported.data.alternate_greetings, ['第二句开场。', '第三句开场。']);
  assert.deepEqual(exported.data.tags, ['日常', '嘴硬']);
  const imported = importSillyTavernCard(exported);
  assert.equal(imported.postHistoryInstructions, '不要总结。');
  assert.equal(imported.creator, 'tester');
  assert.equal(imported.characterVersion, '1.2.0');
  assert.deepEqual(imported.alternateGreetings, ['第二句开场。', '第三句开场。']);
  const prompt = store.buildPrompt('ayu', '你好').prompt;
  assert.match(prompt, /保持第一人称/);
  assert.match(prompt, /不要总结/);
});

test('default evolution keeps the soul reviewed, voice bounded and relationship bounded', () => {
  const profile = normalizeCharacterProfile({ id: 'ayu', soul: '嘴硬心软' });
  assert.equal(profile.evolution.soulMode, 'suggest');
  assert.equal(profile.evolution.voiceMode, 'bounded');
  assert.equal(profile.evolution.relationshipMode, 'bounded');

  const legacy = normalizeCharacterProfile({
    id: 'legacy', soul: '旧角色', evolution: { mode: 'free' },
  });
  assert.equal(legacy.evolution.soulMode, 'free');
  assert.equal(legacy.evolution.voiceMode, 'free');
});

test('lore activates by keyword, regex, constant and trigger with explainable ordering', () => {
  const profile = { id: 'ayu', soul: '阿鱼', worldbook: [
    { id: 'sea', name: '海边', content: '灯塔在城东。', keywords: ['海边'], priority: 40 },
    { id: 'rain', name: '雨夜', content: '雨夜会停电。', regex: '下雨|雨夜', priority: 60 },
    { id: 'always', name: '常识', content: '她怕冷。', constant: true, priority: 10 },
  ], triggers: [{ id: 'light', name: '灯塔', keywords: ['灯塔'], loreIds: ['sea'], prompt: '灯塔只在夜里亮。', priority: 30 }] };
  const hits = evaluateLore(profile, { query: '下雨时去海边灯塔' });
  assert.deepEqual(hits.map(item => item.id).slice(0, 3).sort(), ['light', 'rain', 'sea']);
  assert.ok(hits.every(item => item.reason));
  assert.equal(evaluateLore(profile, { query: '今天吃什么' }).some(item => item.id === 'always'), true);
});

test('lore honors cooldown, max injections and probability boundaries', () => {
  const profile = { id: 'ayu', soul: '阿鱼', worldbook: [{ id: 'once', name: '一次性', content: '只出现一次', constant: true, maxInjections: 1, cooldownMs: 1000 }] };
  assert.equal(evaluateLore(profile, { usage: {} }).length, 1);
  assert.equal(evaluateLore(profile, { usage: { once: { count: 1 } } }).length, 0);
  assert.equal(evaluateLore(profile, { at: 500, usage: { once: { lastAt: 0 } } }).length, 0);
  const impossible = { id: 'ayu', soul: '阿鱼', worldbook: [{ id: 'no', content: 'x', constant: true, probability: 0 }] };
  assert.equal(evaluateLore(impossible, {}).length, 0);
});

test('examples are selected by query relevance and budget rendering stays bounded', () => {
  const profile = { id: 'ayu', soul: '阿鱼', voice: ['短句'], relationship: '试探', examples: [
    { user: '下雨了', assistant: '伞拿着。', tags: ['雨'] }, { user: '吃了吗', assistant: '你猜。', tags: ['日常'] },
  ] };
  const selected = selectExamples(profile, { query: '外面下雨了', limit: 1 });
  assert.equal(selected[0].assistant, '伞拿着。');
  const prompt = renderProfilePrompt(profile, { query: '雨', examples: selected, maxChars: 100 });
  assert.ok(prompt.length <= 100); assert.match(prompt, /<examples>/);
});

test('worldbook before and after positions are applied around the core profile', () => {
  const prompt = renderProfilePrompt({
    id: 'ayu', soul: '灵魂核心', relationship: '关系核心',
    worldbook: [
      { id: 'pre', name: '前置', content: '前置设定', position: 'before' },
      { id: 'post', name: '后置', content: '后置设定', position: 'after' },
    ],
  }, { lore: [
    { id: 'pre', name: '前置', content: '前置设定', position: 'before' },
    { id: 'post', name: '后置', content: '后置设定', position: 'after' },
  ] });
  assert.ok(prompt.indexOf('前置设定') < prompt.indexOf('灵魂核心'));
  assert.ok(prompt.indexOf('关系核心') < prompt.indexOf('后置设定'));
});

test('SillyTavern v2 cards unpack data, examples and character book entries', () => {
  const profile = importSillyTavernCard({ spec: 'chara_card_v2', data: {
    name: '雨音', description: '旧书店店主', personality: '安静', scenario: '雨夜',
    first_mes: '门没锁。', mes_example: '<START>\n{{user}}：你冷吗\n{{char}}：先坐。',
    character_book: { entries: [{
      keys: ['旧书', '书店'], secondary_keys: ['雨'], content: '地下书库不开放。',
      constant: false, probability: 70, insertion_order: 80, enabled: true, comment: '书库',
    }] },
  } });
  assert.equal(profile.name, '雨音'); assert.equal(profile.firstMessage, '门没锁。');
  assert.equal(profile.examples[0].assistant, '先坐。');
  assert.equal(profile.worldbook[0].name, '书库'); assert.deepEqual(profile.worldbook[0].keywords, ['旧书', '书店', '雨']);
  assert.equal(profile.worldbook[0].probability, 70); assert.equal(profile.worldbook[0].priority, 80);
  assert.match(profile.soul, /旧书店店主/);
});

test('evolution is evidence-bound and can require approval before applying', () => {
  const profile = emptyCharacterProfile({ id: 'ayu', soul: '阿鱼', voice: ['短句'], relationship: '试探', evolution: { soulMode: 'locked', voiceMode: 'suggest', requireEvidence: true, requireApproval: true } });
  assert.throws(() => createEvolutionCandidate(profile, { target: 'soul', value: '新灵魂', evidence: ['m1'] }), /locked/);
  assert.throws(() => createEvolutionCandidate(profile, { target: 'voice', value: ['短句', '新口癖'] }), /evidence/);
  const candidate = createEvolutionCandidate(profile, { target: 'voice', value: ['短句', '新口癖'], evidence: ['m1', 'm2'], reason: '多次原话' });
  assert.equal(candidate.status, 'pending');
  const withPending = normalizeCharacterProfile({ ...profile, pendingEvolutions: [candidate] });
  const changed = approveEvolution(withPending, candidate.id);
  assert.deepEqual(changed.voice, ['短句', '新口癖']);
  assert.equal(changed.pendingEvolutions.length, 0); assert.equal(changed.evolutionHistory[0].status, 'applied');
  assert.ok(changed.revisions.length >= 1);
  assert.deepEqual(profileToLegacy(changed), { id: 'ayu', name: 'ayu', soul: '阿鱼', voice: ['短句', '新口癖'], relationship: '试探' });
});

test('pending evolution can be rejected and applied history restored', () => {
  const profile = normalizeCharacterProfile({ id: 'ayu', soul: '原灵魂', voice: ['原声'], evolution: { soulMode: 'suggest', requireApproval: true } });
  const candidate = createEvolutionCandidate(profile, { target: 'soul', value: '新灵魂', evidence: ['m1'] });
  const pending = normalizeCharacterProfile({ ...profile, pendingEvolutions: [candidate] });
  const rejected = rejectEvolution(pending, candidate.id);
  assert.equal(rejected.pendingEvolutions.length, 0); assert.equal(rejected.evolutionHistory[0].status, 'rejected');
  const applied = applyApprovedEvolution(pending, candidate, { at: '2026-10-29T12:00:00.000Z' });
  const revision = applied.revisions.find(item => item.kind === 'evolution');
  const restored = restoreRevision(applied, revision.id);
  assert.equal(restored.soul, '原灵魂');
});

test('profile store persists pending evolution and lore cooldown usage', t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-profile-v3-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'characters.json');
  const store = createProfileStore({ file, now: () => 1000, seed: {
    id: 'ayu', soul: '原灵魂', worldbook: [{ id: 'once', name: '一次性', content: '只出现一次', constant: true, maxInjections: 1 }],
    evolution: { soulMode: 'suggest', requireApproval: true, requireEvidence: true },
  } });
  const first = store.buildPrompt('ayu', '你好'); assert.match(first.prompt, /只出现一次/);
  const second = store.buildPrompt('ayu', '再来'); assert.doesNotMatch(second.prompt, /只出现一次/);
  const candidate = store.makeCandidate('ayu', { target: 'soul', value: '新灵魂', evidence: ['m1'] });
  assert.equal(store.find('ayu').pendingEvolutions[0].id, candidate.id);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.characters[0].pendingEvolutions[0].id, candidate.id);
  assert.equal(saved.characters[0].loreUsage.once.count, 1);
});

test('exported SillyTavern card can be imported back without losing soul, examples or worldbook', t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-roundtrip-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'characters.json');
  const store = createProfileStore({ file, seed: {
    id: 'ayu', name: '阿鱼', soul: '不会抛下老板', description: '海边', firstMessage: '你来了。',
    voice: ['短句'], relationship: '试探',
    examples: [{ user: '冷吗', assistant: '谁管你。', tags: ['关心'] }],
    worldbook: [{ id: 'sea', name: '海边', content: '灯塔在城东。', keywords: ['海边'], priority: 70, position: 'after', constant: true }],
  } });
  const exported = store.exportCharacter('ayu');
  assert.equal(exported.spec, 'chara_card_v2');
  assert.equal(exported.data.extensions['dsh-flavor-memory'].soul, '不会抛下老板');
  const imported = importSillyTavernCard(exported);
  assert.equal(imported.soul, '不会抛下老板'); assert.equal(imported.examples[0].assistant, '谁管你。');
  assert.equal(imported.worldbook[0].name, '海边'); assert.equal(imported.worldbook[0].priority, 70);
});

test('bounded evolution enforces configured delta and auto-applies when approval is off', () => {
  const profile = normalizeCharacterProfile({
    id: 'ayu', soul: '阿鱼嘴硬心软', evolution: {
      soulMode: 'bounded', requireApproval: false, requireEvidence: true, maxSoulDelta: 0.2,
    },
  });
  assert.throws(() => createEvolutionCandidate(profile, {
    target: 'soul', value: '完全不同的另一个人格，价值观和底线全部改写。', evidence: ['m1'],
  }), /exceeds/);
  const candidate = createEvolutionCandidate(profile, {
    target: 'soul', value: '阿鱼嘴硬心更软', evidence: ['m1'],
  });
  assert.equal(candidate.status, 'bounded-auto');
  assert.ok(candidate.change.value <= 0.2);
  const changed = applyApprovedEvolution(profile, candidate);
  assert.equal(changed.soul, '阿鱼嘴硬心更软');
});








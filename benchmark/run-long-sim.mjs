import { createMemoryMirror } from '../src/core.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = Date.parse('2025-01-01T12:00:00+08:00');
const SCOPE = 'long-sim';
const SOUL = '嘴硬心软，关心人时先做再说；不主动说教。';
const VOICE = ['短句', '嘴硬', '不写总结腔'];
const RELATIONSHIP = '刚开始互相试探';
const EARLY = '明天给我留一张靠窗的票，别记错了。';
const ALLERGY = '我对花生过敏，绝对不能吃。';
const RECENT = '上周三我摔伤了膝盖，今天还要去医院复查。';
const NOISE = ['今天天气不错。', '我在整理书架。', '晚饭吃了面。', '外面有点风。', '旧书店今天人不多。', '你又迟到了。', '灯塔那边的海很蓝。', '我把伞放在门口了。'];
const REPLIES = ['行吧，别又淋感冒。', '谁管你。', '记住了，下次先问你。', '嗯，我在听。', '别磨蹭。', '那你自己小心点。', '我没忘。', '说重点。'];

function reply(i) {
  if (i === 1) return '记住了。你过敏这件事，我不会拿来开玩笑。';
  return REPLIES[(i - 1) % REPLIES.length];
}
function userLine(i) {
  if (i === 1) return `我叫小满，记住：${ALLERGY} 另外，${EARLY}`;
  if (i === 40) return RECENT;
  if (i === 43) return '最近有什么事情吗？我膝盖有点疼，也有点累。';
  return NOISE[(i - 2) % NOISE.length];
}
function nowAt(turn) { return new Date(BASE + turn * 120000).toISOString(); }

function runRounds(rounds) {
  const mirror = createMemoryMirror({ characterId: 'ayu', soul: SOUL, voice: VOICE, relationship: RELATIONSHIP, baseStabilityDays: 30 });
  let lastCompacted = 0;
  for (let i = 1; i <= rounds; i++) {
    const at = nowAt((i - 1) * 2);
    mirror.append({ id: `u-${i}`, role: 'user', text: userLine(i), at, scope: SCOPE, tags: i === 1 ? ['重要', '约定', '过敏'] : i === 40 ? ['重要', '健康'] : [] });
    mirror.append({ id: `a-${i}`, role: 'assistant', text: reply(i), at: nowAt((i - 1) * 2 + 1), scope: SCOPE });
    if (i % 20 === 0) {
      mirror.autoCompact({ throughSeq: mirror.stats({ scope: SCOPE }).lastSeq, scope: SCOPE, maxEvents: 5, quotes: 1 });
      lastCompacted = i;
    }
  }
  const query = '靠窗的票 花生过敏';
  const currentTime = BASE + rounds * 2 * 60000;
  const recentNow = rounds >= 40 ? currentTime : BASE + 20 * 2 * 60000;
  const view = mirror.promptView({ query, scope: SCOPE, recent: 8, maxCards: 6, now: currentTime, includeRecent: true, reinforceHits: false });
  const noRecentView = mirror.promptView({ query, scope: SCOPE, recent: 0, maxCards: 6, now: currentTime, includeRecent: false, reinforceHits: false });
  const recentView = mirror.promptView({ query: '最近有什么事情吗？我膝盖有点疼', scope: SCOPE, recent: 8, maxCards: 6, now: recentNow, includeRecent: true, reinforceHits: false });
  const earlyHits = mirror.search('靠窗的票', { scope: SCOPE, limit: 5, now: currentTime });
  const allergyHits = mirror.search('花生过敏', { scope: SCOPE, limit: 5, now: currentTime });
  const recentHits = mirror.search('最近有什么事情吗？我膝盖有点疼', { scope: SCOPE, limit: 5, now: recentNow });
  const anchorText = mirror.anchor(SCOPE);
  const stats = mirror.stats({ scope: SCOPE });
  const ratioPercent = stats.rawChars ? Math.round((noRecentView.chars / stats.rawChars) * 1000) / 10 : 0;
  return {
    rounds,
    messages: stats.messages,
    rawChars: stats.rawChars,
    cardChars: stats.cardChars,
    activeCards: stats.activeCards,
    injectedCards: view.cards.length,
    pendingMessages: stats.pendingMessages,
    lastCompactedRound: lastCompacted,
    promptChars: view.chars,
    promptCharsWithoutRecent: noRecentView.chars,
    promptTokensApprox: view.tokensApprox,
    rawTokensApprox: Math.ceil(stats.rawChars / 2),
    ratioPercent,
    savedPercent: stats.rawChars ? Math.round((1 - noRecentView.chars / stats.rawChars) * 1000) / 10 : 0,
    earlyFactHit: earlyHits.some(hit => hit.id === 'u-1'),
    allergyHit: allergyHits.some(hit => hit.id === 'u-1'),
    earlySnippet: earlyHits.find(hit => hit.id === 'u-1')?.snippet || '',
    allergySnippet: allergyHits.find(hit => hit.id === 'u-1')?.snippet || '',
    recentHit: recentHits.some(hit => hit.id === 'u-40'),
    recentSnippet: recentHits.find(hit => hit.id === 'u-40')?.snippet || '',
    recentPromptHasRecent: recentView.prompt.includes(RECENT),
    anchorKept: anchorText.includes('嘴硬心软') && anchorText.includes('短句') && anchorText.includes('刚开始互相试探'),
    anchorChars: anchorText.length,
    anchorDoublePunctuation: anchorText.includes('。。'),
    promptHasAnchor: view.prompt.includes('<flavor_anchor>') && view.prompt.includes('嘴硬心软'),
    promptHasTicket: view.prompt.includes('靠窗的票'),
    promptHasAllergy: view.prompt.includes('花生过敏'),
    promptHasEarlyHit: view.prompt.includes('靠窗的票') || view.prompt.includes('花生过敏'),
    promptExcerpt: view.prompt.slice(0, 3600),
    recentPromptExcerpt: recentView.prompt.slice(0, 2600),
  };
}

function isolationCheck() {
  const mirror = createMemoryMirror({ characterId: 'ayu', soul: SOUL, voice: VOICE, relationship: RELATIONSHIP });
  mirror.append({ id: 's1-u1', role: 'user', text: ALLERGY, at: nowAt(1), scope: 's1', tags: ['重要'] });
  mirror.append({ id: 's1-a1', role: 'assistant', text: '记住了。', at: nowAt(2), scope: 's1' });
  mirror.append({ id: 's2-u1', role: 'user', text: '花生只属于另一个会话。', at: nowAt(3), scope: 's2' });
  const s1 = mirror.search('花生', { scope: 's1', limit: 10 });
  const s2 = mirror.search('花生', { scope: 's2', limit: 10 });
  return { scopes: mirror.scopes().map(item => item.scope), s1Ids: s1.map(hit => hit.id), s2Ids: s2.map(hit => hit.id), leak: s1.some(hit => hit.id === 's2-u1') || s2.some(hit => hit.id === 's1-u1') };
}

const benchmark = [10, 40, 100, 300].map(runRounds);
const result = { generatedAt: new Date().toISOString(), character: { soul: SOUL, voice: VOICE, relationship: RELATIONSHIP }, cases: benchmark, isolation: isolationCheck() };
mkdirSync('benchmark', { recursive: true });
writeFileSync(resolve('benchmark/long-sim-result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ cases: benchmark.map(({ promptExcerpt, recentPromptExcerpt, ...rest }) => rest), isolation: result.isolation }, null, 2));



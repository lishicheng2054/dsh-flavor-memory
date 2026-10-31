import { createMemoryMirror } from '../src/core.mjs';
import { writeFileSync } from 'node:fs';

const BASE = Date.parse('2025-01-01T12:00:00+08:00');
const SCOPE = 'long-rich';
const soul = '阿鱼：嘴硬心软，先损后哄，不主动说教。';
const voice = ['叫她老板', '短句', '被关心时先嘴硬'];
const relationship = '刚开始互相试探';
const longNoise = [
  '老板，今天海边风很大，我把书店门口那块旧木牌擦了一遍，木头缝里全是盐。',
  '刚才有个客人问灯塔怎么走，我给他指了城东那条路，他走的时候还回头看了一眼。',
  '晚饭在街角吃的面，汤有点咸，我坐着听完了一首很老的歌才回来。',
  '今天整理书架的时候翻到一本旧航海图，边角写着一行看不清的日期。',
  '外面下雨了，屋檐一直滴水，我把靠门的那排书往里挪了一点。',
  '你说我总迟到，可今天明明是你先没回消息，我坐在窗边等了很久。',
];
const longReplies = [
  '行吧，别又淋感冒。', '谁管你。', '记住了，下次先问你。', '嗯，我在听。',
  '别磨蹭。', '那你自己小心点。', '我没忘。', '说重点。',
];
const early = '明天给我留一张靠窗的票，别记错了。';
const allergy = '我对花生过敏，绝对不能吃。';
const recent = '上周三我摔伤了膝盖，今天还要去医院复查。';

const mirror = createMemoryMirror({ characterId: 'ayu', soul, voice, relationship, baseStabilityDays: 30 });
for (let i = 1; i <= 300; i++) {
  const user = i === 1
    ? `老板，我叫小满，记住：${allergy} 另外，${early}`
    : i === 280
      ? recent
      : longNoise[(i - 2) % longNoise.length];
  const assistant = i === 1 ? '记住了。你过敏这件事，我不会拿来开玩笑。' : longReplies[(i - 1) % longReplies.length];
  mirror.append({ id: `u-${i}`, role: 'user', text: user, at: new Date(BASE + (i - 1) * 2 * 60000).toISOString(), scope: SCOPE, tags: i === 1 ? ['重要', '约定', '过敏'] : i === 280 ? ['重要', '健康'] : [] });
  mirror.append({ id: `a-${i}`, role: 'assistant', text: assistant, at: new Date(BASE + ((i - 1) * 2 + 1) * 60000).toISOString(), scope: SCOPE });
  if (i % 20 === 0) mirror.autoCompact({ throughSeq: mirror.stats({ scope: SCOPE }).lastSeq, scope: SCOPE, maxEvents: 5, quotes: 1 });
}
const now = BASE + 300 * 2 * 60000;
const stats = mirror.stats({ scope: SCOPE });
const withRecent = mirror.promptView({ query: '靠窗的票 花生过敏', scope: SCOPE, recent: 8, maxCards: 6, now, includeRecent: true });
const withoutRecent = mirror.promptView({ query: '靠窗的票 花生过敏', scope: SCOPE, recent: 0, maxCards: 6, now, includeRecent: false });
const recentView = mirror.promptView({ query: '最近有什么事情吗？我膝盖有点疼', scope: SCOPE, recent: 8, maxCards: 6, now, includeRecent: true });
const result = {
  rounds: 300, messages: stats.messages, rawChars: stats.rawChars, cardChars: stats.cardChars,
  activeCards: stats.activeCards, injectedCards: withRecent.cards.length,
  promptCharsWithRecent: withRecent.chars, promptCharsWithoutRecent: withoutRecent.chars,
  ratioPercentMemoryOnly: Math.round((withoutRecent.chars / stats.rawChars) * 1000) / 10,
  ratioPercentWithRecent: Math.round((withRecent.chars / stats.rawChars) * 1000) / 10,
  earlyFactHit: mirror.search('靠窗的票', { scope: SCOPE, limit: 5, now }).some(hit => hit.id === 'u-1'),
  allergyHit: mirror.search('花生过敏', { scope: SCOPE, limit: 5, now }).some(hit => hit.id === 'u-1'),
  recentInjected: recentView.prompt.includes(recent),
  anchorKept: mirror.anchor(SCOPE).includes('阿鱼') && mirror.anchor(SCOPE).includes('叫她老板') && mirror.anchor(SCOPE).includes(relationship),
  anchorDoublePunctuation: mirror.anchor(SCOPE).includes('。。'),
  promptExcerpt: withRecent.prompt.slice(0, 2000),
};
writeFileSync('benchmark/long-rich-result.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, promptExcerpt: undefined }, null, 2));

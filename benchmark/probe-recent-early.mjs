import { createMemoryMirror } from '../src/core.mjs';

const BASE = Date.parse('2025-01-01T12:00:00+08:00');
const SOUL = '嘴硬心软，关心人时先做再说；不主动说教。';
const VOICE = ['短句', '嘴硬', '不写总结腔'];
const RELATIONSHIP = '刚开始互相试探';
const RECENT = '上周三我摔伤了膝盖，今天还要去医院复查。';
const mirror = createMemoryMirror({ characterId: 'ayu', soul: SOUL, voice: VOICE, relationship: RELATIONSHIP });
mirror.append({ id: 'u-1', role: 'user', text: '我叫小满，我对花生过敏。', at: new Date(BASE).toISOString(), scope: 's1', tags: ['重要'] });
mirror.append({ id: 'u-40', role: 'user', text: RECENT, at: new Date(BASE + 39 * 2 * 60000).toISOString(), scope: 's1', tags: ['重要', '健康'] });
const earlier = mirror.promptView({ query: '最近有什么事情吗？我膝盖有点疼', scope: 's1', recent: 8, now: BASE + 20 * 2 * 60000, includeRecent: true });
const after = mirror.promptView({ query: '最近有什么事情吗？我膝盖有点疼', scope: 's1', recent: 8, now: BASE + 40 * 2 * 60000, includeRecent: true });
console.log(JSON.stringify({ earlier: { hits: earlier.hits.map(h => h.id), hasRecent: earlier.prompt.includes(RECENT) }, after: { hits: after.hits.map(h => h.id), hasRecent: after.prompt.includes(RECENT) } }, null, 2));

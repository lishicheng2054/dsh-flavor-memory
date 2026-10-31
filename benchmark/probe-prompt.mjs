import { createMemoryMirror } from '../src/core.mjs';
const BASE=Date.parse('2025-01-01T12:00:00+08:00');
const m=createMemoryMirror({characterId:'ayu',soul:'嘴硬心软',voice:['短句'],relationship:'试探'});
for(let i=1;i<=40;i++){const text=i===1?'老板，我叫小满。我花生过敏，绝对不能吃。周五给我留一张靠窗的票，别记错了。':i===3?'我送你的那枚旧书签，背面写着“下次别迟到”。':'今天海风很大。';m.append({id:`u-${i}`,role:'user',text,at:new Date(BASE+(i-1)*2*60000).toISOString(),scope:'s',tags:i===1?['重要']:[]});m.append({id:`a-${i}`,role:'assistant',text:i===3?'行吧，别又淋感冒。':'谁管你。',at:new Date(BASE+((i-1)*2+1)*60000).toISOString(),scope:'s'});if(i%20===0)m.autoCompact({throughSeq:m.stats({scope:'s'}).lastSeq,scope:'s',maxEvents:5,quotes:1});}
const v=m.promptView({query:'你送过我什么？或者我们第一次见面是什么样？',scope:'s',recent:8,maxCards:6,now:BASE+40*2*60000,includeRecent:true});
console.log(v.prompt);

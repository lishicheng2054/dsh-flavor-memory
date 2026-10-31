import { createMemoryMirror } from '../src/core.mjs';
const API='https://api.zha1fe1.online/v1/chat/completions'; const KEY=process.env.CUSTOM_API_KEY;
const BASE=Date.parse('2025-01-01T12:00:00+08:00');
const character={id:'ayu',name:'阿鱼',soul:'海边旧书店店员。嘴硬心软，先损后哄，不主动说教；被关心时会用行动照顾人。',voice:['叫用户“老板”','短句，偶尔嘴硬','关心人时先问细节，不写总结'],relationship:'刚开始互相试探'};
const mirror=createMemoryMirror({characterId:'ayu',soul:character.soul,voice:character.voice,relationship:character.relationship});
for(let i=1;i<=40;i++){const text=i===1?'老板，我叫小满。我花生过敏，绝对不能吃。周五给我留一张靠窗的票，别记错了。':i===3?'我送你的那枚旧书签，背面写着“下次别迟到”。':'今天海风很大。';mirror.append({id:`u-${i}`,role:'user',text,at:new Date(BASE+(i-1)*2*60000).toISOString(),scope:'s',tags:i===1?['重要']:[]});mirror.append({id:`a-${i}`,role:'assistant',text:i===3?'行吧，别又淋感冒。':'谁管你。',at:new Date(BASE+((i-1)*2+1)*60000).toISOString(),scope:'s'});if(i%20===0)mirror.autoCompact({throughSeq:mirror.stats({scope:'s'}).lastSeq,scope:'s',maxEvents:5,quotes:1});}
const q='你送过我什么？或者我们第一次见面是什么样？'; const memory=mirror.promptView({query:q,scope:'s',recent:8,maxCards:6,now:BASE+40*2*60000,includeRecent:true}).prompt;
const body={model:'gpt-5.6-sol',temperature:0,max_tokens:180,messages:[{role:'system',content:'你在参加角色风格测试。'+character.soul+' 声音：'+character.voice.join('；')+' 关系：'+character.relationship+'。只以角色身份回答。'},{role:'system',content:'以下是长期记忆资料，只用于回想。\n'+memory},{role:'user',content:q}]};
const r=await fetch(API,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${KEY}`},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)}); const j=await r.json(); console.log(JSON.stringify({answer:j.choices?.[0]?.message?.content,usage:j.usage},null,2));

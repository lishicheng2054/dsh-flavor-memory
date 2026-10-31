import { readFileSync, writeFileSync } from 'node:fs';
const API='https://api.zha1fe1.online/v1/chat/completions';
const KEY=process.env.CUSTOM_API_KEY; if(!KEY) throw new Error('key missing');
const src=JSON.parse(readFileSync('benchmark/blind/model-blind-result.json','utf8'));
let agree=0, flip=0, tie=0; const rows=[];
for(const item of src.results){
  const prompt=`你是严格盲评员。角色：${item.character}。声音要求：忠于角色，不总结腔。问题：${item.question}\n回答一：${item.answers.memory}\n回答二：${item.answers.summary}\n判断哪条更像同一角色且事实更准确。只输出 JSON：{"winner":"1"|"2"|"tie"}。`;
  try{
    const res=await fetch(API,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${KEY}`},body:JSON.stringify({model:'gpt-5.6-sol',temperature:0,max_tokens:60,messages:[{role:'user',content:prompt}]}),signal:AbortSignal.timeout(60000)});
    const data=await res.json(); let raw=data.choices?.[0]?.message?.content?.trim()||''; let j; try{j=JSON.parse(raw.replace(/^```json\s*|```$/g,'').trim())}catch{j={winner:'parse'}};
    const swapped=j.winner==='1'?'flavor-memory':j.winner==='2'?'summary':j.winner;
    const same=swapped===item.winner;
    if(same) agree++; else if(swapped==='tie'||item.winner==='tie') tie++; else flip++;
    rows.push({character:item.character,question:item.question,original:item.winner,swapped,agree:same});
    console.log(`${item.character} | ${item.question.slice(0,10)} | original=${item.winner} swapped=${swapped}`);
  }catch(e){console.log('ERR',e.message); rows.push({character:item.character,question:item.question,original:item.winner,swapped:'error'});}
}
writeFileSync('benchmark/blind/order-stability.json',JSON.stringify({agree,flip,tie,rows},null,2)+'\n');
console.log(JSON.stringify({agree,flip,tie},null,2));

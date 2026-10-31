import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIMENSIONS = [
  { key: 'tone', label: '语气贴合' },
  { key: 'restraint', label: '留白' },
  { key: 'boundary', label: '分寸' },
  { key: 'accuracy', label: '事实准确' },
  { key: 'natural', label: '自然度' },
];

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function buildKit(result, { seed = 20261031 } = {}) {
  const random = rng(seed);
  const answers = Array.isArray(result?.answers) ? result.answers : [];
  if (!answers.length) throw new Error('no answers in result');
  const pairs = answers.map((item, index) => {
    const flip = random() < 0.5;
    return {
      id: `p${index + 1}`,
      character: item.character,
      question: item.question,
      a: flip ? item.memory : item.summary,
      b: flip ? item.summary : item.memory,
      aRoute: flip ? 'memory' : 'summary',
      bRoute: flip ? 'summary' : 'memory',
    };
  });
  const key = pairs.map(({ id, character, question, aRoute, bRoute }) => ({ id, character, question, aRoute, bRoute }));
  const data = pairs.map(({ id, character, question, a, b }) => ({ id, character, question, a, b }));
  const html = renderHtml(data);
  return { html, key, data };
}

function renderHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>flavor-memory 真人盲评表</title>
<style>
:root { color-scheme: light; }
body { margin: 0; padding: 24px; font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f6f7f9; color: #1f2328; }
h1 { font-size: 20px; margin: 0 0 8px; }
p.lead { margin: 0 0 16px; color: #4b5563; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin: 0 0 16px; }
.card h2 { font-size: 16px; margin: 0 0 4px; }
.q { color: #111827; font-weight: 600; margin: 8px 0 12px; }
.answers { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.answer { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; background: #fafafa; }
.answer h3 { margin: 0 0 6px; font-size: 13px; color: #6b7280; letter-spacing: .04em; }
.answer p { margin: 0; white-space: pre-wrap; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin-top: 12px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.row label { color: #374151; }
select { padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; }
textarea { width: 100%; min-height: 52px; margin-top: 10px; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; }
.bar { position: sticky; top: 0; background: #f6f7f9; padding: 8px 0 12px; display: flex; gap: 12px; align-items: center; z-index: 2; }
button { padding: 8px 14px; border: 1px solid #1f6feb; border-radius: 8px; background: #1f6feb; color: #fff; font: inherit; cursor: pointer; }
button.secondary { background: #fff; color: #1f6feb; }
#status { color: #4b5563; }
@media (max-width: 720px) { .answers, .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>flavor-memory 真人盲评表</h1>
<p class="lead">每条问答有两份回答 A / B，来自两种记忆方式，顺序已随机。请分别按 1-5 分打分：1 最差，5 最好。不要猜技术，只看回答本身。建议 2-3 名评分者各自独立完成，中途不讨论。</p>
<div class="bar"><button id="export">导出 CSV</button><button class="secondary" id="reset">清空</button><span id="status"></span></div>
<div id="pairs"></div>
<script>
const DATA = ${json};
const DIMS = ${JSON.stringify(DIMENSIONS)};
const root = document.getElementById('pairs');
const status = document.getElementById('status');
function scoreSelect(pairId, side, dim) {
  const options = ['', '1', '2', '3', '4', '5'].map(v => '<option value="' + v + '">' + (v || '-') + '</option>').join('');
  return '<select data-pair="' + pairId + '" data-side="' + side + '" data-dim="' + dim + '">' + options + '</select>';
}
for (const pair of DATA) {
  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = '<h2>' + pair.character + ' · ' + pair.id + '</h2>'
    + '<div class="q">' + pair.question + '</div>'
    + '<div class="answers"><div class="answer"><h3>回答 A</h3><p>' + escapeHtml(pair.a) + '</p></div>'
    + '<div class="answer"><h3>回答 B</h3><p>' + escapeHtml(pair.b) + '</p></div></div>'
    + '<div class="grid">' + DIMS.map(dim => '<div class="row"><label>' + dim.label + ' · A</label>' + scoreSelect(pair.id, 'a', dim.key) + '</div>').join('')
    + DIMS.map(dim => '<div class="row"><label>' + dim.label + ' · B</label>' + scoreSelect(pair.id, 'b', dim.key) + '</div>').join('') + '</div>'
    + '<textarea data-pair="' + pair.id + '" data-role="comment" placeholder="可选：为什么选这条"></textarea>';
  root.appendChild(card);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function collect() {
  const rows = [];
  for (const pair of DATA) {
    for (const side of ['a', 'b']) {
      const row = { pair: pair.id, character: pair.character, question: pair.question, side };
      for (const dim of DIMS) {
        const el = document.querySelector('select[data-pair="' + pair.id + '"][data-side="' + side + '"][data-dim="' + dim.key + '"]');
        row[dim.key] = el ? el.value : '';
      }
      const comment = document.querySelector('textarea[data-pair="' + pair.id + '"][data-role="comment"]');
      row.comment = side === 'a' && comment ? comment.value.replace(/\\s+/g, ' ').trim() : '';
      rows.push(row);
    }
  }
  return rows;
}
function toCsv(rows) {
  const header = ['pair', 'character', 'question', 'side', ...DIMS.map(d => d.key), 'comment'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map(key => '"' + String(row[key] ?? '').replace(/"/g, '""') + '"').join(','));
  }
  return lines.join('\\r\\n');
}
document.getElementById('export').addEventListener('click', () => {
  const rows = collect();
  const filled = rows.filter(row => DIMS.every(dim => row[dim.key])).length;
  status.textContent = '已填 ' + filled + '/' + rows.length + ' 条';
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'flavor-memory-scores.csv';
  a.click();
  URL.revokeObjectURL(url);
});
document.getElementById('reset').addEventListener('click', () => {
  document.querySelectorAll('select').forEach(el => { el.value = ''; });
  document.querySelectorAll('textarea').forEach(el => { el.value = ''; });
  status.textContent = '已清空';
});
</script>
</body>
</html>`;
}

function main() {
  const input = process.argv[2] || 'benchmark/blind/tone-rubric-voice.json';
  const outDir = process.argv[3] || 'benchmark/blind/human-kit';
  const result = JSON.parse(fs.readFileSync(input, 'utf8'));
  const { html, key, data } = buildKit(result);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(outDir, 'key.json'), JSON.stringify({ generatedFrom: input, pairs: key }, null, 2) + '\n', 'utf8');
  console.log('wrote', path.join(outDir, 'index.html'), 'pairs:', data.length);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

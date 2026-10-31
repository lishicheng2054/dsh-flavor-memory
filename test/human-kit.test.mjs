import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKit } from '../benchmark/blind/human-kit.mjs';

const result = {
  answers: [
    { answerModel: 'x', characterId: 'a', character: '阿鱼', question: '约定是什么？', summary: '摘要回答', memory: '原话回答' },
    { answerModel: 'x', characterId: 'b', character: '林雾', question: '你什么态度？', summary: '摘要态度', memory: '原话态度' },
  ],
};

test('human kit anonymizes both answers and keeps a separate key', () => {
  const { html, key, data } = buildKit(result, { seed: 7 });
  assert.equal(data.length, 2);
  assert.equal(key.length, 2);
  assert.ok(key.every(item => ['memory', 'summary'].includes(item.aRoute) && ['memory', 'summary'].includes(item.bRoute)));
  assert.ok(key.every(item => item.aRoute !== item.bRoute));
  assert.doesNotMatch(html, /\"summary\"/);
  assert.doesNotMatch(html, /\"memory\"/);
  assert.doesNotMatch(html, /aRoute|bRoute/);
  assert.match(html, /阿鱼/);
  assert.match(html, /约定是什么/);
});

test('human kit is deterministic for a fixed seed', () => {
  const first = buildKit(result, { seed: 42 });
  const second = buildKit(result, { seed: 42 });
  assert.deepEqual(first.key, second.key);
  assert.deepEqual(first.data, second.data);
});

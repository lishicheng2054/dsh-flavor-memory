import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, extractText } from '../src/gateway.mjs';
import { apply } from '../src/dsh-plugin.mjs';

function fakeContext() {
  const tools = new Map();
  const events = new Map();
  const contexts = [];
  return {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    systemPrompt: { context(options) { contexts.push(options); return () => contexts.splice(contexts.indexOf(options), 1); } },
    on(event, handler) { events.set(event, handler); return () => events.delete(event); },
    toolsMap: tools, events, contexts,
  };
}

test('extractText reads OpenAI string, OpenAI blocks and DSH content blocks', () => {
  assert.equal(extractText('直接字符串'), '直接字符串');
  assert.equal(extractText([{ type: 'text', text: 'OpenAI 块' }]), 'OpenAI 块');
  assert.equal(extractText([{ type: 'text', text: 'DSH 块' }]), 'DSH 块');
  assert.equal(extractText([{ type: 'image', source: 'x' }, { type: 'text', text: '混排' }]), '混排');
});

test('DSH-shaped user and assistant events are archived as readable text', t => {
  const ctx = fakeContext();
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', soul: '阿鱼', voice: ['短句'] });
  const disposal = apply(ctx, { store, characterId: 'ayu', autoCompactEvery: 0 });
  t.after(() => { disposal.dispose(); store.close(); });
  ctx.events.get('session/event')({ id: 's' }, {
    type: 'user/message',
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '别淋雨。' }], source: { kind: 'user' } },
  });
  ctx.events.get('session/event')({ id: 's' }, {
    type: 'assistant/message',
    data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '不用你管。' }] } },
  });
  assert.deepEqual(store.bookFor('ayu').recent(2).map(item => item.text), ['别淋雨。', '不用你管。']);
});

test('extractText accepts a bare DSH text block without an OpenAI type tag', () => {
  assert.equal(extractText([{ text: '裸文本块' }]), '裸文本块');
});

test('extractText accepts nested DSH content wrappers', () => {
  assert.equal(extractText({ content: [{ type: 'text', text: '嵌套内容' }] }), '嵌套内容');
});

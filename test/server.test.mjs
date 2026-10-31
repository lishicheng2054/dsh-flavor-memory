import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/gateway.mjs';
import { createGateway } from '../src/server.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

function jsonResponse(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function setup(t, upstreamHandler, options = {}) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ headers: req.headers, body: JSON.parse(raw || '{}') });
    await upstreamHandler(req, res, requests.length);
  });
  const upstreamPort = await listen(upstream);
  const store = createStore({ root: ':memory:' });
  store.upsertCharacter({ id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['叫她老板', '短句'], relationship: '互相试探' });
  const gateway = createGateway({
    store, defaultCharacter: 'ayu', token: 'client-token',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    upstreamApiKey: 'sk-upstream-must-not-leak', requestTimeoutMs: 5000,
    autoCompactEvery: options.autoCompactEvery ?? 20,
  });
  const port = await listen(gateway.server);
  t.after(async () => { await gateway.close(); await close(upstream); store.close(); });
  return { requests, base: `http://127.0.0.1:${port}`, store };
}

test('health is public but model completions require the client token', async t => {
  const { base } = await setup(t, (req, res) => jsonResponse(res, { choices: [{ message: { content: 'ok' } }] }));
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const denied = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);
});

test('non-streaming request injects memory and archives exact user/assistant text', async t => {
  const { base, requests } = await setup(t, (_req, res) => jsonResponse(res, {
    id: 'chat-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '行，老板。' }, finish_reason: 'stop' }],
  }));
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer client-token' },
    body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: '周五给我留票。' }] }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.choices[0].message.content, '行，老板。');
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.messages[0].content, /<flavor_anchor>/);
  assert.match(requests[0].body.messages[0].content, /记忆回执/);
  assert.equal(requests[0].headers.authorization, 'Bearer sk-upstream-must-not-leak');
  const memory = JSON.parse(await (await fetch(`${base}/admin/export`, { headers: { authorization: 'Bearer client-token' } })).text());
  const entries = memory.characters[0].memory.entries;
  assert.deepEqual(entries.map(item => item.text), ['周五给我留票。', '行，老板。']);
});

test('second request can retrieve the first turn through shared memory', async t => {
  const { base, requests } = await setup(t, (req, res, n) => jsonResponse(res, {
    choices: [{ message: { content: n === 1 ? '好，票给你留着。' : '当然，老板。' } }],
  }));
  const headers = { 'content-type': 'application/json', authorization: 'Bearer client-token' };
  await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: '周五给我留票。' }] }) });
  await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: '票还在吗？' }] }) });
  assert.equal(requests.length, 2);
  assert.match(requests[1].body.messages[0].content, /票给你留着|周五给我留票/);
});

test('SSE is relayed and assistant deltas are archived after completion', async t => {
  const { base } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"不用"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"你管。"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer client-token' },
    body: JSON.stringify({ model: 'mock', stream: true, messages: [{ role: 'user', content: '别淋雨。' }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type').startsWith('text/event-stream'), true);
  const body = await response.text();
  assert.match(body, /不用/);
  assert.match(body, /你管。/);
  assert.match(body, /\[DONE\]/);
  const memory = JSON.parse(await (await fetch(`${base}/admin/export`, { headers: { authorization: 'Bearer client-token' } })).text());
  assert.ok(memory.characters[0].memory.entries.some(item => item.text === '不用你管。'));
});

test('missing character passes through unchanged rather than inventing a persona', async t => {
  const { base, requests } = await setup(t, (req, res) => jsonResponse(res, { choices: [{ message: { content: 'ok' } }] }));
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer client-token', 'x-flavor-character': 'nobody' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(requests[0].body.messages[0].content, '你好');
  assert.equal(requests[0].body.messages[0].role, 'user');
});

test('upstream failures do not leak the API key or raw upstream body', async t => {
  const { base } = await setup(t, (_req, res) => jsonResponse(res, { error: { message: 'bad sk-upstream-must-not-leak' } }, 502));
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer client-token' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
  });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.doesNotMatch(text, /sk-upstream-must-not-leak/);
  assert.match(text, /upstream/i);
});

test('SSE parsing handles an event boundary split across upstream chunks', async t => {
  const { base } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"跨块"}}]}');
    setTimeout(() => res.end('\n\ndata: [DONE]\n\n'), 10);
  });
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer client-token' },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: '测试分块。' }] }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const memory = JSON.parse(await (await fetch(`${base}/admin/export`, { headers: { authorization: 'Bearer client-token' } })).text());
  assert.ok(memory.characters[0].memory.entries.some(item => item.text === '跨块'));
});

test('SSE parsing handles an event boundary split inside one UTF-8 character', async t => {
  const { base } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const payload = Buffer.from('data: {"choices":[{"delta":{"content":"雨"}}]}\n\n', 'utf8');
    const cut = payload.indexOf(Buffer.from('雨')) + 1;
    res.write(payload.subarray(0, cut));
    setTimeout(() => res.end(Buffer.concat([payload.subarray(cut), Buffer.from('data: [DONE]\n\n')])), 10);
  });
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer client-token' },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: '测试中文分块。' }] }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const memory = JSON.parse(await (await fetch(`${base}/admin/export`, { headers: { authorization: 'Bearer client-token' } })).text());
  assert.ok(memory.characters[0].memory.entries.some(item => item.text === '雨'));
});

test('two sessions under one character are isolated across HTTP, cards and fixed answers', async t => {
  const { base, requests, store } = await setup(t, (req, res, n) => jsonResponse(res, {
    choices: [{ message: { role: 'assistant', content: n <= 2 ? `票${n}留好了。` : `还在，票${n}。` } }],
  }), { autoCompactEvery: 4 });
  async function ask(sessionId, text) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer client-token' },
      body: JSON.stringify({ sessionId, messages: [{ role: 'user', content: text }] }),
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  await ask('qq-a', 'A 的靠窗票。');
  await ask('qq-b', 'B 的海边票。');
  await ask('qq-a', '票还在吗？');
  await ask('qq-b', '票还在吗？');
  const aRequest = requests.at(-2).body.messages[0].content;
  const bRequest = requests.at(-1).body.messages[0].content;
  assert.match(aRequest, /靠窗票/);
  assert.doesNotMatch(aRequest, /海边票/);
  assert.match(bRequest, /海边票/);
  assert.doesNotMatch(bRequest, /靠窗票/);
  assert.equal(store.stats('ayu', { scope: 'qq-a' }).messages, 4);
  assert.equal(store.stats('ayu', { scope: 'qq-b' }).messages, 4);
  assert.equal(store.bookFor('ayu').cards({ scope: 'qq-a' }).length, 1);
  assert.ok(store.bookFor('ayu').cards({ scope: 'qq-b' }).length >= 1);
  assert.equal(
    store.bookFor('ayu').cards({ scope: 'qq-b' }).some(card => card.quoteIds.some(id => id.startsWith('m-') && store.getRaw('ayu', id)?.scope === 'qq-a')),
    false,
    'card quotes must not cross sessions',
  );
});

test('full history replay is deduplicated while a new turn is still archived', async t => {
  const { base, store } = await setup(t, (req, res, n) => jsonResponse(res, {
    choices: [{ message: { role: 'assistant', content: `第${n}次回答。` } }],
  }));
  const headers = { 'content-type': 'application/json', authorization: 'Bearer client-token' };
  const firstMessages = [{ role: 'user', content: '第一问。' }];
  const first = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify({ sessionId: 'qq-history', messages: firstMessages }),
  });
  assert.equal(first.status, 200);
  await first.text();
  assert.equal(store.stats('ayu', { scope: 'qq-history' }).messages, 2);

  const replay = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({
      sessionId: 'qq-history',
      messages: [
        ...firstMessages,
        { role: 'assistant', content: '第1次回答。' },
        { role: 'user', content: '第二问。' },
      ],
    }),
  });
  assert.equal(replay.status, 200);
  await replay.text();
  assert.equal(store.stats('ayu', { scope: 'qq-history' }).messages, 4);
  const entries = store.bookFor('ayu').recent(10, { scope: 'qq-history' }).map(item => item.text);
  assert.deepEqual(entries, ['第一问。', '第1次回答。', '第二问。', '第2次回答。']);
});

test('streaming full history replay is also deduplicated', async t => {
  const { base, store } = await setup(t, (req, res, n) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: {"choices":[{"delta":{"content":"流式第${n}次。"}}]}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const headers = { 'content-type': 'application/json', authorization: 'Bearer client-token' };
  async function ask(messages) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ stream: true, sessionId: 'qq-stream-history', messages }),
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  await ask([{ role: 'user', content: '流式第一问。' }]);
  await ask([
    { role: 'user', content: '流式第一问。' },
    { role: 'assistant', content: '流式第1次。' },
    { role: 'user', content: '流式第二问。' },
  ]);
  assert.deepEqual(
    store.bookFor('ayu').recent(10, { scope: 'qq-stream-history' }).map(item => item.text),
    ['流式第一问。', '流式第1次。', '流式第二问。', '流式第2次。'],
  );
});

test('gateway creates scene cards automatically after enough archived turns', async t => {
  const { base, store } = await setup(t, (_req, res) => jsonResponse(res, {
    choices: [{ message: { role: 'assistant', content: '知道了，老板。' } }],
  }), { autoCompactEvery: 10 });
  const headers = { 'content-type': 'application/json', authorization: 'Bearer client-token' };
  for (let i = 1; i <= 6; i += 1) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [{ role: 'user', content: `第${i}轮，票和伞。` }] }),
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(store.stats('ayu').messages, 12);
  assert.equal(store.stats('ayu').cards, 1);
});


test('header-only session routing keeps memory isolated', async t => {
  const { base, requests, store } = await setup(t, (_req, res, n) => jsonResponse(res, {
    choices: [{ message: { role: 'assistant', content: `header reply ${n}` } }],
  }));
  async function ask(headerSession, text) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: 'Bearer client-token',
        'x-flavor-session': headerSession,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  await ask('header-a', 'H-A 的靠窗票。');
  await ask('header-b', 'H-B 的海边票。');
  await ask('header-a', '票还在吗？');
  await ask('header-b', '票还在吗？');
  const a = requests.at(-2).body.messages[0].content;
  const b = requests.at(-1).body.messages[0].content;
  assert.match(a, /靠窗票/);
  assert.doesNotMatch(a, /海边票/);
  assert.match(b, /海边票/);
  assert.doesNotMatch(b, /靠窗票/);
  assert.equal(store.stats('ayu', { scope: 'header-a' }).messages, 4);
  assert.equal(store.stats('ayu', { scope: 'header-b' }).messages, 4);
});

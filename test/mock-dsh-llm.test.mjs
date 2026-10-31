import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockDshLlm } from './fixtures/mock-dsh-llm.mjs';

test('mock DSH model records requests and streams an OpenAI-compatible reply', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-mock-llm-'));
  const logFile = join(dir, 'requests.ndjson');
  const mock = createMockDshLlm({ logFile, reply: '知道了，老板。' });
  t.after(() => mock.close());
  const address = await mock.listen();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder' },
    body: JSON.stringify({
      model: 'mock-chat',
      stream: true,
      messages: [{ role: 'user', content: '别忘了带伞。' }],
    }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /知道了，老板。/);
  assert.match(text, /\[DONE\]/);
  const logged = JSON.parse(readFileSync(logFile, 'utf8').trim());
  assert.equal(logged.payload.messages[0].content, '别忘了带伞。');
  assert.equal(logged.authorization, 'Bearer placeholder');
});

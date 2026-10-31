import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

function endSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

export function createMockDshLlm({
  logFile,
  reply = '行，老板。伞偏了一点。',
  port = 0,
  host = '127.0.0.1',
} = {}) {
  if (!logFile) throw new Error('logFile is required');
  mkdirSync(dirname(logFile), { recursive: true });
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: [{ id: 'mock-chat', object: 'model', created: 0, owned_by: 'local-test' }],
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      sendJson(res, 404, { error: { message: 'not found' } });
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { sendJson(res, 400, { error: { message: 'invalid JSON' } }); return; }
      const record = {
        at: new Date().toISOString(),
        authorization: req.headers.authorization || '',
        payload,
      };
      requests.push(record);
      appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');
      const created = Math.floor(Date.now() / 1000);
      const firstUser = [...(payload.messages || [])].reverse().find(item => item?.role === 'user');
      const answer = typeof reply === 'function' ? reply({ payload, text: textOfContent(firstUser?.content) }) : reply;
      if (payload.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-mock-1', object: 'chat.completion.chunk', created,
          model: payload.model || 'mock-chat',
          choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }],
        })}\n\n`);
        endSse(res, {
          id: 'chatcmpl-mock-1', object: 'chat.completion.chunk', created,
          model: payload.model || 'mock-chat',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        return;
      }
      sendJson(res, 200, {
        id: 'chatcmpl-mock-1',
        object: 'chat.completion',
        created,
        model: payload.model || 'mock-chat',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: answer },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
  });
  return {
    server,
    requests,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
    },
  };
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isEntry) {
  const logFile = process.env.MOCK_LOG_FILE;
  const mock = createMockDshLlm({ logFile, port: Number(process.env.MOCK_PORT || 8788) });
  mock.listen().then(address => {
    process.stdout.write(`${JSON.stringify({ type: 'ready', address })}\n`);
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
  const stop = async () => { await mock.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
import http from 'node:http';
import { createStore, buildInjectedPrompt, extractText, captureResponse } from './gateway.mjs';

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tokenOf(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function safeMessage(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'upstream request timed out';
  if (error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') return 'upstream is unavailable';
  return 'upstream request failed';
}

function parseSseLine(line) {
  if (!line.startsWith('data:')) return null;
  const value = line.slice(5).trim();
  if (!value || value === '[DONE]') return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function createGateway({
  store = createStore({ root: ':memory:' }), defaultCharacter = '', token = '',
  upstreamBaseUrl = 'https://api.deepseek.com/v1', upstreamApiKey = '',
  requestTimeoutMs = 120000, fetchImpl = globalThis.fetch, autoCompactEvery = 20,
} = {}) {
  if (!upstreamApiKey) throw new Error('upstreamApiKey is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const base = String(upstreamBaseUrl).replace(/\/+$/, '');

  function autoCompactIfNeeded(characterId, scope = '') {
    const every = Number(autoCompactEvery);
    if (!Number.isFinite(every) || every <= 0) return null;
    const stats = store.stats(characterId, { scope });
    if (stats.lastSeq - stats.lastCompactedSeq < every) return null;
    return store.autoCompact(characterId, {
      throughSeq: stats.lastSeq, maxEvents: 5, quotes: 2, scope,
    });
  }

  function archiveExchange(characterId, requestPayload, responsePayload, scope = '') {
    if (!characterId || !store.getCharacter(characterId)) return null;
    const captured = captureResponse(store, characterId, {
      requestPayload, responsePayload, scope,
    });
    if (captured.archived) autoCompactIfNeeded(characterId, scope);
    return captured;
  }

  function archiveAssistantText(characterId, requestPayload, assistantText, scope = '') {
    if (!characterId || !assistantText?.trim() || !store.getCharacter(characterId)) return null;
    const captured = captureResponse(store, characterId, {
      requestPayload,
      responsePayload: { choices: [{ message: { content: assistantText } }] },
      scope,
    });
    if (captured.archived) autoCompactIfNeeded(characterId, scope);
    return captured;
  }

  async function proxyCompletion(req, res, body) {
    let payload;
    try { payload = JSON.parse(body); } catch { sendJson(res, 400, { error: { message: 'invalid JSON body' } }); return; }
    if (!payload || !Array.isArray(payload.messages)) { sendJson(res, 400, { error: { message: 'messages must be an array' } }); return; }
    const characterId = store.resolveCharacter({
      headers: req.headers,
      metadata: payload.metadata,
      characterId: payload.character_id,
    }) || defaultCharacter;
    const sessionId = store.resolveSession({
      headers: req.headers,
      metadata: payload.metadata,
      sessionId: payload.sessionId,
      conversationId: payload.conversationId,
      conversation_id: payload.conversation_id,
    });
    const originalBody = JSON.parse(JSON.stringify(payload));
    const injected = characterId
      ? buildInjectedPrompt(store, characterId, originalBody, {
        maxCards: 6, recent: 8, headers: req.headers,
      })
      : { messages: originalBody.messages, debug: { injected: false, reason: 'character_missing' } };
    const upstreamBody = { ...originalBody, messages: injected.messages };
    delete upstreamBody.character_id;
    delete upstreamBody.metadata;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref?.();
    try {
      const upstream = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${upstreamApiKey}` },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        await upstream.text().catch(() => '');
        sendJson(res, 502, { error: { message: `upstream request failed (${upstream.status})` } });
        return;
      }
      const contentType = upstream.headers.get('content-type') || '';
      if (payload.stream || contentType.includes('text/event-stream')) {
        await relayStream(res, upstream, characterId, originalBody, sessionId);
      } else {
        const raw = await upstream.text();
        let result;
        try { result = JSON.parse(raw); } catch {
          sendJson(res, 502, { error: { message: 'upstream returned invalid JSON' } });
          return;
        }
        sendJson(res, 200, result);
        archiveExchange(characterId, originalBody, result, sessionId);
      }
    } catch (error) {
      if (!res.headersSent) sendJson(res, error?.status || 502, { error: { message: safeMessage(error) } });
      else res.destroy();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function relayStream(res, upstream, characterId, requestPayload, sessionId = '') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = '';
    let assistant = '';
    for await (const chunk of upstream.body) {
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      res.write(bytes);
      pending += decoder.decode(bytes, { stream: true });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() || '';
      for (const frame of frames) {
        const event = frame.split(/\r?\n/).map(parseSseLine).find(Boolean);
        const delta = extractText(event?.choices?.[0]?.delta?.content);
        if (delta) assistant += delta;
      }
    }
    pending += decoder.decode();
    const tail = pending.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).map(parseSseLine).find(Boolean)).find(Boolean);
    const tailDelta = extractText(tail?.choices?.[0]?.delta?.content);
    if (tailDelta) assistant += tailDelta;
    res.end();
    archiveAssistantText(characterId, requestPayload, assistant, sessionId);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, profiles: store.listCharacters().map(item => item.id) });
        return;
      }
      if (token && tokenOf(req) !== token) {
        sendJson(res, 401, { error: { message: 'unauthorized' } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(res, 200, { object: 'list', data: [] });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/admin/export') {
        sendJson(res, 200, store.exportAll());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/admin/characters') {
        const body = JSON.parse(await readBody(req));
        sendJson(res, 201, store.upsertCharacter(body));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/admin/memory/remember') {
        const body = JSON.parse(await readBody(req));
        const characterId = body.characterId || defaultCharacter;
        if (!store.getCharacter(characterId)) throw Object.assign(new Error('character not found'), { status: 404 });
        sendJson(res, 201, store.remember({ ...body, characterId }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const raw = await readBody(req);
        await proxyCompletion(req, res, raw);
        return;
      }
      sendJson(res, 404, { error: { message: 'not found' } });
    } catch (error) {
      if (!res.headersSent) sendJson(res, error?.status || 500, { error: { message: error?.status ? error.message : 'internal error' } });
      else res.destroy();
    }
  });

  return {
    server,
    store,
    async close() {
      await new Promise(resolve => server.close(resolve));
      store.close();
    },
  };
}

export async function startGateway(options = process.env) {
  const env = options;
  const store = createStore({
    root: env.DATA_FILE || ':memory:',
    secretPatterns: [env.UPSTREAM_API_KEY, env.GATEWAY_TOKEN].filter(Boolean),
  });
  const characterId = env.DEFAULT_CHARACTER || 'ayu';
  if (!store.getCharacter(characterId)) {
    store.upsertCharacter({
      id: characterId,
      name: env.CHARACTER_NAME || characterId,
      soul: env.CHARACTER_SOUL || '',
      voice: String(env.CHARACTER_VOICE || '').split('|').filter(Boolean),
      relationship: env.CHARACTER_RELATIONSHIP || '',
    });
  }
  const gateway = createGateway({
    store,
    defaultCharacter: env.DEFAULT_CHARACTER || 'ayu',
    token: env.GATEWAY_TOKEN || '',
    upstreamBaseUrl: env.UPSTREAM_BASE_URL || 'https://api.deepseek.com/v1',
    upstreamApiKey: env.UPSTREAM_API_KEY || '',
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS || 120000),
    autoCompactEvery: env.AUTO_COMPACT_EVERY === undefined ? 20 : Number(env.AUTO_COMPACT_EVERY),
  });
  await new Promise((resolve, reject) => {
    gateway.server.once('error', reject);
    gateway.server.listen(Number(env.PORT || 8787), env.HOST || '127.0.0.1', resolve);
  });
  return gateway;
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isEntry) {
  startGateway().then(gateway => {
    const address = gateway.server.address();
    console.log(`flavor-memory gateway listening on http://${address.address}:${address.port}`);
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}



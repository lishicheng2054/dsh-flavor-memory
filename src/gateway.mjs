import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createMemoryMirror } from './core.mjs';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function redact(value, patterns) {
  let text = String(value ?? '');
  for (const pattern of patterns) text = text.split(pattern).join('[REDACTED]');
  return text;
}

function nowIso() { return new Date().toISOString(); }

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item.text === 'string' && (item.type === undefined || item.type === 'text')) return item.text;
        if (item && typeof item.content === 'string') return item.content;
        if (item && Array.isArray(item.content)) return extractText(item.content);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.content)) return extractText(content.content);
  }
  return '';
}

function collectAssistantText(response) {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  if (typeof response.output_text === 'string') return response.output_text;
  if (response.message && typeof response.message.content === 'string') return response.message.content;
  if (Array.isArray(response.choices)) {
    return response.choices.map(choice => extractText(choice?.message?.content)).filter(Boolean).join('\n');
  }
  if (Array.isArray(response.content)) return extractText(response.content);
  return '';
}

let nextMessageNumber = 0;
function nextId(prefix = 'm') {
  nextMessageNumber += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextMessageNumber}`;
}

function isMemoryRoot(root) {
  return !root || root === ':memory:';
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function isStaleLock(lockFile) {
  let payload;
  try { payload = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { return true; }
  if (!payload || !processAlive(Number(payload.pid))) return true;
  const age = Date.now() - Number(payload.at || 0);
  return !Number.isFinite(age) || age > 30000;
}

function acquireLock(target) {
  const lockFile = `${target}.lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }), null, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const current = JSON.parse(readFileSync(lockFile, 'utf8'));
      if (current.token === token) return { lockFile, token };
      throw Object.assign(new Error('lock ownership was lost'), { code: 'EEXIST' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (isStaleLock(lockFile)) {
        try { unlinkSync(lockFile); } catch {}
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + (attempt % 8));
    }
  }
  throw Object.assign(new Error('memory store is busy'), { code: 'ELOCKED' });
}

function releaseLock(lock) {
  if (!lock) return;
  try {
    const current = JSON.parse(readFileSync(lock.lockFile, 'utf8'));
    if (current.token === lock.token) unlinkSync(lock.lockFile);
  } catch {}
}

function mergeFacts(existingFacts = [], incomingFacts = []) {
  const byId = new Map(existingFacts.map(item => [item.id, item]));
  for (const item of incomingFacts) byId.set(item.id, item);
  return [...byId.values()];
}

function mergeCharacterPayloads(existing, incoming) {
  if (!existing || !Array.isArray(existing.characters)) return incoming;
  if (!incoming || !Array.isArray(incoming.characters)) return existing;
  const merged = new Map(existing.characters.map(item => [item.id, item]));
  for (const item of incoming.characters) {
    const previous = merged.get(item.id);
    if (!previous?.memory || !item.memory) {
      merged.set(item.id, item);
      continue;
    }
    merged.set(item.id, {
      ...previous,
      ...item,
      memory: {
        ...previous.memory,
        ...item.memory,
        facts: mergeFacts(previous.memory.facts, item.memory.facts),
      },
    });
  }
  return { ...existing, ...incoming, characters: [...merged.values()] };
}

function writeAtomic(file, content) {
  const target = resolve(file);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(dirname(target), { recursive: true });
  const lock = acquireLock(target);
  try {
    const result = typeof content === 'function' ? content(target) : { text: String(content), value: undefined };
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeSync(fd, result.text, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    let replaced = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        renameSync(temp, target);
        replaced = true;
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt === 19) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + attempt * 5);
      }
    }
    if (!replaced) throw new Error('atomic replace failed');
    return result.value;
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  } finally {
    releaseLock(lock);
  }
}

export function createStore({
  root = ':memory:', secretPatterns = [], initial = null, onChange = null, saveDelayMs = 40,
  baseStabilityDays = 30,
} = {}) {
  const dataFile = isMemoryRoot(root) ? null : resolve(root);
  const characters = new Map();
  const books = new Map();
  const patterns = [...secretPatterns].filter(Boolean).map(String);
  const sessionCursors = new Map();
  let saveTimer = null;
  let dirty = false;
  let closed = false;

  function sanitize(value) {
    if (typeof value === 'string') return redact(value, patterns);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
    }
    return value;
  }

  function emit(event) {
    if (typeof onChange === 'function') onChange(Object.freeze({ ...event }));
  }

  function loadPayload(payload) {
    if (!payload || payload.version !== 1 || !Array.isArray(payload.characters)) {
      throw new Error('unsupported format');
    }
    const nextCharacters = new Map();
    const nextBooks = new Map();
    for (const item of payload.characters) {
      if (!item || typeof item.id !== 'string' || !item.id.trim()) throw new Error('invalid character');
      const character = {
        id: item.id,
        name: String(item.name || item.id),
        soul: String(item.soul || ''),
        voice: [...(item.voice || [])].map(String),
        relationship: String(item.relationship || ''),
        revision: Number(item.revision || 1),
        updatedAt: String(item.updatedAt || nowIso()),
      };
      nextCharacters.set(character.id, character);
      nextBooks.set(character.id, createMemoryMirror({
        characterId: character.id,
        soul: character.soul,
        voice: character.voice,
        relationship: character.relationship,
        snapshot: item.memory || null,
        baseStabilityDays,
        }));
    }
    characters.clear();
    books.clear();
    for (const [id, character] of nextCharacters) characters.set(id, character);
    for (const [id, book] of nextBooks) books.set(id, book);
  }

  function saveNow() {
    if (!dataFile || !dirty) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const payload = {
      version: 1,
      savedAt: nowIso(),
      characters: [...characters.values()].map(character => ({
        ...character,
        memory: books.get(character.id).snapshot(),
      })),
    };
    const merged = writeAtomic(dataFile, target => {
      let existing = null;
      try { if (existsSync(target)) existing = JSON.parse(readFileSync(target, 'utf8')); } catch (error) {
        throw new Error(`data file is corrupt or unreadable: ${target}`, { cause: error });
      }
      const next = mergeCharacterPayloads(existing, payload);
      return { text: `${JSON.stringify(next, null, 2)}\n`, value: next };
    });
    for (const item of merged.characters) {
      if (characters.has(item.id)) continue;
      characters.set(item.id, {
        id: item.id,
        name: String(item.name || item.id),
        soul: String(item.soul || ''),
        voice: [...(item.voice || [])].map(String),
        relationship: String(item.relationship || ''),
        revision: Number(item.revision || 1),
        updatedAt: String(item.updatedAt || nowIso()),
      });
      books.set(item.id, createMemoryMirror({
        characterId: item.id,
        soul: String(item.soul || ''),
        voice: [...(item.voice || [])].map(String),
        relationship: String(item.relationship || ''),
        snapshot: item.memory || null,
        baseStabilityDays,
        }));
    }
    dirty = false;
  }

  function scheduleSave() {
    if (!dataFile || closed) return;
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    if (saveDelayMs <= 0) { saveNow(); return; }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { saveNow(); } catch (error) {
        if (typeof onChange === 'function') onChange(Object.freeze({ type: 'save:error', error }));
      }
    }, saveDelayMs);
    saveTimer.unref?.();
  }

  if (initial) {
    try { loadPayload(clone(initial)); } catch (error) {
      throw new Error('initial data is invalid', { cause: error });
    }
  }
  if (dataFile && existsSync(dataFile)) {
    let payload;
    try { payload = JSON.parse(readFileSync(dataFile, 'utf8')); } catch (error) {
      throw new Error(`data file is corrupt or unreadable: ${dataFile}`, { cause: error });
    }
    try { loadPayload(payload); } catch (error) {
      throw new Error(`data file is invalid: ${dataFile}`, { cause: error });
    }
  }

  function upsertCharacter(input = {}) {
    const id = String(input.id || '').trim();
    if (!id) throw new Error('character id is required');
    const previous = characters.get(id) || {};
    const character = {
      id,
      name: String(input.name || previous.name || id),
      soul: String(input.soul ?? previous.soul ?? ''),
      voice: [...(input.voice ?? previous.voice ?? [])].map(String),
      relationship: String(input.relationship ?? previous.relationship ?? ''),
      revision: (previous.revision || 0) + 1,
      updatedAt: nowIso(),
    };
    const oldBook = books.get(id);
    const snapshot = oldBook ? oldBook.snapshot() : null;
    characters.set(id, character);
    books.set(id, createMemoryMirror({
      characterId: id,
      soul: character.soul,
      voice: character.voice,
      relationship: character.relationship,
      snapshot,
      baseStabilityDays,
    }));
    scheduleSave();
    emit({ type: 'character:upsert', characterId: id });
    return clone(character);
  }

  function getCharacter(id) { return characters.has(id) ? clone(characters.get(id)) : null; }
  function listCharacters() { return [...characters.values()].map(clone); }

  function bookFor(id) {
    const book = books.get(id);
    if (!book) throw new Error(`character not found: ${id}`);
    return book;
  }

  function bumpRevision(characterId) {
    const current = characters.get(characterId);
    if (!current) return;
    characters.set(characterId, {
      ...current,
      revision: Number(current.revision || 0) + 1,
      updatedAt: nowIso(),
    });
  }

  function remember({ characterId, id, role, text, at, tags = [], scope = '', sessionId }) {
    const entry = bookFor(characterId).append({
      id: id || nextId('m'),
      role,
      text,
      at: at || nowIso(),
      tags,
      scope: scope || sessionId || '',
    });
    bumpRevision(characterId);
    scheduleSave();
    emit({ type: 'message:remember', characterId, id: entry.id, scope: entry.scope });
    return clone(entry);
  }

  function rememberIdempotent(input = {}) {
    const existing = input.id ? bookFor(input.characterId).read(input.id) : null;
    if (existing) return { ...existing, duplicate: true };
    return remember(input);
  }

  function rememberBatch(characterId, messages, options = {}) {
    const scope = options.scope ?? options.sessionId ?? '';
    return messages.map(message => rememberIdempotent({ ...message, characterId, scope: message.scope ?? message.sessionId ?? scope }));
  }

  function getRaw(characterId, id) { return bookFor(characterId).read(id); }

  function pinMemory(characterId, id, pinned = true) {
    const entry = bookFor(characterId).pin(id, { pinned });
    bumpRevision(characterId);
    scheduleSave();
    emit({ type: 'memory:pin', characterId, id, pinned: Boolean(pinned), scope: entry.scope });
    return entry;
  }
  function search(characterId, query, options) { return bookFor(characterId).search(query, options); }

  function recall(characterId, id, { at } = {}) {
    const entry = getRaw(characterId, id);
    if (!entry) throw new Error('memory not found');
    const state = bookFor(characterId).recall(id, { at });
    bumpRevision(characterId);
    scheduleSave();
    emit({ type: 'memory:recall', characterId, id, scope: entry.scope, recallCount: state.recallCount });
    return state;
  }

  function strength(characterId, id, options = {}) {
    return bookFor(characterId).strength(id, options);
  }


  function commitScene(characterId, options) {
    const card = bookFor(characterId).compactThrough(options.throughSeq, options);
    bumpRevision(characterId);
    scheduleSave();
    emit({ type: 'scene:commit', characterId, cardId: card.id });
    return card;
  }

  function autoCompact(characterId, options) {
    const card = bookFor(characterId).autoCompact(options);
    if (card) {
      bumpRevision(characterId);
      scheduleSave();
      emit({ type: 'scene:auto-compact', characterId, cardId: card.id });
    }
    return card;
  }

  function setFact(characterIdOrInput, maybeOptions) {
    const input = characterIdOrInput && typeof characterIdOrInput === 'object'
      ? characterIdOrInput
      : maybeOptions;
    const resolvedCharacterId = characterIdOrInput && typeof characterIdOrInput === 'object'
      ? characterIdOrInput.characterId
      : characterIdOrInput;
    if (!resolvedCharacterId) throw new Error('character id is required');
    const fact = bookFor(resolvedCharacterId).setFact({
      scope: input?.scope ?? input?.sessionId,
      key: input?.key,
      value: input?.value,
      sourceId: input?.sourceId,
      at: input?.at,
      tags: input?.tags,
      supersedes: input?.supersedes,
    });
    bumpRevision(resolvedCharacterId);
    scheduleSave();
    emit({ type: 'fact:set', characterId: resolvedCharacterId, factId: fact.id, scope: fact.scope });
    return fact;
  }

  function facts(characterId, options = {}) { return bookFor(characterId).facts(options); }
  function promptView(characterId, options = {}) { return bookFor(characterId).promptView(options); }

  function reinforcePromptHits(characterId, hits, { at, minIntervalMs = 86400000 } = {}) {
    const valid = (Array.isArray(hits) ? hits : []).map(hit => typeof hit === 'string' ? hit : hit?.id).filter(Boolean);
    if (!valid.length) return [];
    const states = bookFor(characterId).recallMany(valid, { at, minIntervalMs });
    const reinforced = states.filter(state => state.reinforced).map(state => state.id);
    if (reinforced.length) {
      bumpRevision(characterId);
      scheduleSave();
      emit({ type: 'memory:prompt-recall', characterId, ids: reinforced });
    }
    return states;
  }
  function stats(characterId, options = {}) { return bookFor(characterId).stats(options); }
  function scopes(characterId) { return bookFor(characterId).scopes(); }

  function exportAll() {
    const payload = {
      version: 1,
      exportedAt: nowIso(),
      characters: [...characters.values()].map(character => ({
        ...character,
        memory: books.get(character.id).snapshot(),
      })),
    };
    return sanitize(payload);
  }

  function replaceCharacterMemory(id, memory) {
    if (!characters.has(id)) throw new Error(`character not found: ${id}`);
    const character = characters.get(id);
    books.set(id, createMemoryMirror({
      characterId: id,
      soul: character.soul,
      voice: character.voice,
      relationship: character.relationship,
      snapshot: memory,
      baseStabilityDays,
    }));
    bumpRevision(id);
    scheduleSave();
    emit({ type: 'character:memory-replace', characterId: id });
  }

  function importAll(payload) {
    if (!payload || payload.version !== 1 || !Array.isArray(payload.characters)) throw new Error('invalid import');
    try { loadPayload(payload); } catch (error) {
      throw new Error('invalid import', { cause: error });
    }
    scheduleSave();
    emit({ type: 'store:import' });
  }

  function archiveTurn(characterId, {
    userText, assistantText, userId, assistantId, at, tags = [], scope = '', sessionId,
  }) {
    const resolvedScope = scope || sessionId || '';
    const user = userText ? rememberIdempotent({
      characterId, id: userId, role: 'user', text: userText, at, tags, scope: resolvedScope,
    }) : null;
    const assistant = assistantText ? rememberIdempotent({
      characterId, id: assistantId, role: 'assistant', text: assistantText, at, tags, scope: resolvedScope,
    }) : null;
    return { user, assistant };
  }

  function archiveHistory(characterId, { messages = [], scope = '', sessionId, at } = {}) {
    const requestedScope = String(scope || sessionId || '').trim().slice(0, 256);
    const before = stats(characterId, { scope: requestedScope }).messages;
    const result = bookFor(characterId).appendHistory({ scope: requestedScope, messages, at });
    const after = stats(characterId, { scope: requestedScope }).messages;
    if (after > before) {
      bumpRevision(characterId);
      scheduleSave();
      emit({ type: 'history:archive', characterId, scope: requestedScope, added: result.added.length });
    }
    return clone(result);
  }

  function resolveSession(payload) {
    const metadata = payload?.metadata || payload?.meta || {};
    const headers = payload?.headers || {};
    return String(
      metadata.sessionId || metadata.session_id || metadata.conversationId ||
      metadata.conversation_id || headers['x-flavor-session'] ||
      payload?.sessionId || payload?.session_id || payload?.conversation_id ||
      payload?.conversationId || '',
    ).trim().slice(0, 256);
  }

  function resolveCharacter(payload) {
    const metadata = payload?.metadata || payload?.meta || {};
    const headers = payload?.headers || {};
    return String(
      metadata.characterId || metadata.character_id || headers['x-flavor-character'] ||
      payload?.characterId || payload?.character_id || '',
    ).trim();
  }

  function setSessionCursor(sessionId, characterId, value) {
    if (!sessionId) return;
    sessionCursors.set(`${sessionId}:${characterId}`, value);
  }

  function getSessionCursor(sessionId, characterId) {
    return sessionId ? sessionCursors.get(`${sessionId}:${characterId}`) : undefined;
  }

  function close() {
    closed = true;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow();
  }

  return Object.freeze({
    upsertCharacter, getCharacter, listCharacters, remember, rememberBatch,
    getRaw, pin: pinMemory, search, recall, strength, promptView, reinforcePromptHits, setFact, facts, scopes, commitScene, autoCompact, stats,
    exportAll, importAll, replaceCharacterMemory, archiveTurn, archiveHistory, resolveCharacter, resolveSession, rememberIdempotent,
    setSessionCursor, getSessionCursor, bookFor,
    flush: saveNow, close, dataFile,
  });
}

export function buildInjectedPrompt(store, characterId, payload, options = {}) {
  const body = clone(payload || {});
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const character = characterId ? store.getCharacter(characterId) : null;
  if (!character) {
    return { messages, debug: { injected: false, reason: characterId ? 'character_not_configured' : 'character_missing' } };
  }
  const scope = store.resolveSession({
    ...body,
    headers: body.headers || options.headers,
    metadata: body.metadata || body.meta,
  });
  const lastUser = [...messages].reverse().find(message => message?.role === 'user');
  const query = extractText(lastUser?.content);
  const view = store.promptView(characterId, {
    query,
    recent: options.recent ?? 8,
    includeRecent: false,
    maxCards: options.maxCards ?? 6,
    scope,
    voiceSamples: options.voiceSamples,
    maxPromptChars: options.maxPromptChars,
  });
  if (view.hits.length) store.reinforcePromptHits(characterId, view.hits, { at: options.at });
  const memoryBlock = view.prompt;
  if (!memoryBlock) {
    return { messages, debug: { injected: false, reason: 'memory_empty' } };
  }
  const nextMessages = messages.map(message => ({ ...message }));
  let systemIndex = nextMessages.findIndex(message => message?.role === 'system');
  if (systemIndex < 0) {
    nextMessages.unshift({ role: 'system', content: memoryBlock });
    systemIndex = 0;
  } else {
    const original = extractText(nextMessages[systemIndex].content);
    nextMessages[systemIndex] = {
      ...nextMessages[systemIndex],
      content: `${original}\n\n${memoryBlock}`.trim(),
    };
  }
  return {
    messages: nextMessages,
    debug: {
      injected: true,
      characterId,
      scope,
      anchor: store.bookFor(characterId).anchor(scope),
      hits: view.hits,
      chars: memoryBlock.length,
      tokensApprox: view.tokensApprox,
      quotedIds: view.quotedIds,
      systemIndex,
    },
  };
}

export function toOpenAIMessages(store, characterId, { scope = null } = {}) {
  const book = store.bookFor(characterId);
  const view = book.promptView({ includeRecent: false, scope });
  const raw = book.recent(20, { scope }).map(entry => ({ role: entry.role === 'system' ? 'system' : entry.role, content: entry.text }));
  return [{ role: 'system', content: view.prompt }, ...raw];
}

export function captureResponse(store, characterId, { requestPayload, responsePayload, at, scope = '', sessionId } = {}) {
  const messages = Array.isArray(requestPayload?.messages) ? requestPayload.messages : [];
  const lastUserIndex = messages.map(message => message?.role).lastIndexOf('user');
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : null;
  const userText = extractText(lastUser?.content).trim();
  if (!userText) return { archived: false, reason: 'no_user_message' };
  const assistantText = collectAssistantText(responsePayload).trim();
  if (!assistantText) return { archived: false, reason: 'no_assistant_message' };
  const resolvedScope = scope || sessionId || '';
  const history = messages.slice(0, lastUserIndex).filter(message => ['user', 'assistant', 'system'].includes(message?.role));
  const replay = history.length ? store.archiveHistory(characterId, {
    messages: history, at: at || nowIso(), scope: resolvedScope,
  }) : null;
  const archive = store.archiveTurn(characterId, {
    userText,
    assistantText,
    userId: nextId('u'),
    assistantId: nextId('a'),
    at: at || nowIso(),
    scope: resolvedScope,
  });
  return { archived: true, replay, ...archive };
}

export { extractText, collectAssistantText, extractText as messageText };

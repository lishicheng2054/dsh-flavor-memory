import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  emptyCharacterProfile, normalizeCharacterProfile, evaluateLore, selectExamples,
  renderProfilePrompt, createEvolutionCandidate, applyApprovedEvolution, approveEvolution,
  rejectEvolution, restoreRevision, importSillyTavernCard,
} from './character-profile.mjs';

function expand(value) {
  const text = String(value ?? '');
  if (text === '~') return homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2));
  return text;
}
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    throw new Error(`cannot read character profile ${path}: ${error.message}`);
  }
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function dshHomeDir() {
  const raw = String(process.env.DSH_HOME || '').trim();
  if (raw) return expand(raw);
  return join(homedir(), '.dsh');
}

export function resolveProfilesFile(value) {
  if (!value) return join(dshHomeDir(), 'flavor-memory', 'characters.json');
  return resolve(expand(value));
}

export function loadProfiles(file) {
  const source = readJson(file, { version: 1, characters: [] });
  const rows = Array.isArray(source) ? source : source.characters;
  return Array.isArray(rows) ? rows.map(normalizeCharacterProfile) : [];
}

export function saveProfiles(file, profiles) {
  const normalized = profiles.map(normalizeCharacterProfile);
  writeJson(file, { version: 2, savedAt: new Date().toISOString(), characters: normalized });
  return normalized;
}

export function createProfileStore({
  file = resolveProfilesFile(), seed = null, loreUsage = new Map(), now = () => Date.now(),
} = {}) {
  let profiles = loadProfiles(file);
  if (!profiles.length && seed) profiles = saveProfiles(file, [seed]);
  if (seed) {
    const seeded = normalizeCharacterProfile(seed);
    const existing = profiles.find(profile => profile.id === seeded.id);
    if (!existing) profiles = saveProfiles(file, [...profiles, seeded]);
  }
  const byId = () => new Map(profiles.map(profile => [profile.id, profile]));
  const find = characterId => byId().get(String(characterId)) || null;
  const put = (input, { create = true } = {}) => {
    const profile = normalizeCharacterProfile(input);
    const existing = find(profile.id);
    if (!existing && !create) throw new Error(`character not found: ${profile.id}`);
    profiles = profiles.filter(item => item.id !== profile.id).concat(profile);
    saveProfiles(file, profiles);
    return profile;
  };
  const remove = characterId => {
    const before = profiles.length;
    profiles = profiles.filter(item => item.id !== characterId);
    if (profiles.length === before) return false;
    saveProfiles(file, profiles);
    return true;
  };
  const updateEvolution = (characterId, candidate) => {
    const profile = find(characterId);
    if (!profile) throw new Error(`character not found: ${characterId}`);
    const next = candidate?.status === 'pending' ? approveEvolution(profile, candidate.id) : applyApprovedEvolution(profile, candidate);
    put(next);
    return next;
  };
  const makeCandidate = (characterId, input) => {
    const profile = find(characterId);
    if (!profile) throw new Error(`character not found: ${characterId}`);
    const candidate = createEvolutionCandidate(profile, input);
    if (candidate?.status === 'pending') {
      put(normalizeCharacterProfile({ ...profile, pendingEvolutions: [...profile.pendingEvolutions, candidate] }));
    } else if (candidate?.status === 'bounded-auto') {
      put(applyApprovedEvolution(profile, candidate));
      return { ...candidate, applied: true };
    }
    return candidate;
  };
  const rejectCandidate = (characterId, candidateId) => {
    const profile = find(characterId);
    if (!profile) throw new Error(`character not found: ${characterId}`);
    const next = rejectEvolution(profile, candidateId);
    put(next);
    return next;
  };
  const restore = (characterId, revisionId) => {
    const profile = find(characterId);
    if (!profile) throw new Error(`character not found: ${characterId}`);
    const next = restoreRevision(profile, revisionId);
    put(next);
    return next;
  };
  const buildPrompt = (characterId, query = '', { maxChars = 6000, examplesLimit = 3 } = {}) => {
    const profile = find(characterId);
    if (!profile) return { prompt: '', profile: null, lore: [], examples: [] };
    const usage = { ...profile.loreUsage, ...Object.fromEntries(loreUsage.entries()) };
    const lore = evaluateLore(profile, { query, at: now(), usage });
    if (lore.length) {
      const nextUsage = { ...profile.loreUsage };
      for (const item of lore) {
        const previous = nextUsage[item.id] || { count: 0, lastAt: 0 };
        const next = { count: previous.count + 1, lastAt: now() };
        loreUsage.set(item.id, next);
        nextUsage[item.id] = next;
      }
      put({ ...profile, loreUsage: nextUsage });
    }
    const examples = selectExamples(profile, { query, limit: examplesLimit });
    return { prompt: renderProfilePrompt(profile, { query, lore, examples, maxChars }), profile, lore, examples };
  };
  return Object.freeze({
    file, list: () => [...profiles], find, put, remove, buildPrompt, makeCandidate,
    updateEvolution, rejectCandidate, restore,
    has: characterId => Boolean(find(characterId)),
    exportCharacter: characterId => {
      const profile = find(characterId);
      if (!profile) throw new Error(`character not found: ${characterId}`);
      return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
          name: profile.name,
          description: profile.description || profile.soul,
          personality: profile.personality,
          scenario: profile.scenario,
          first_mes: profile.firstMessage,
          mes_example: renderExampleBlocks(profile.examples),
          alternate_greetings: profile.alternateGreetings,
          system_prompt: profile.systemPrompt,
          post_history_instructions: profile.postHistoryInstructions,
          creator_notes: profile.creatorNotes || `Exported by dsh-flavor-memory (${profile.id})`,
          creator: profile.creator,
          character_version: profile.characterVersion,
          tags: profile.tags,
          character_book: { entries: profile.worldbook.map((item, index) => ({
            keys: item.keywords,
            secondary_keys: [],
            content: item.content,
            enabled: item.enabled,
            constant: item.constant,
            probability: item.probability,
            insertion_order: item.priority,
            comment: item.name,
            position: item.position === 'after' ? 'after' : 'before',
            extensions: { 'dsh-flavor-memory': { id: item.id, regex: item.regex, cooldownMs: item.cooldownMs, maxInjections: item.maxInjections, tags: item.tags } },
            id: index + 1,
          })) },
          extensions: {
            'dsh-flavor-memory': {
              id: profile.id, soul: profile.soul, voice: profile.voice,
              relationship: profile.relationship, examples: profile.examples,
              alternateGreetings: profile.alternateGreetings, systemPrompt: profile.systemPrompt,
              postHistoryInstructions: profile.postHistoryInstructions, creatorNotes: profile.creatorNotes,
              creator: profile.creator, characterVersion: profile.characterVersion, tags: profile.tags,
              triggers: profile.triggers, evolution: profile.evolution,
              evolutionHistory: profile.evolutionHistory, revisions: profile.revisions,
            },
          },
        },
      };
    },
  });
}

function renderExampleBlocks(examples) {
  return examples.map(item => `<START>\n{{user}}：${item.user}\n{{char}}：${item.assistant}`).join('\n\n');
}

export function createControlApi({ store, profiles, authToken = '', origin = '' } = {}) {
  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  function authorized(req) {
    if (!authToken) return true;
    return String(req.headers?.authorization || '') === `Bearer ${authToken}`;
  }
  async function body(req, maxBytes = 2 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('request body too large');
        error.statusCode = 413;
        for await (const ignored of req) void ignored;
        throw error;
      }
      chunks.push(chunk);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  function syncMemory(profile) {
    if (typeof store?.upsertCharacter !== 'function') return;
    store.upsertCharacter({
      id: profile.id,
      name: profile.name,
      soul: profile.soul,
      voice: profile.voice,
      relationship: profile.relationship,
    });
  }
  function ensureMemory(characterId) {
    const profile = profiles.find(characterId);
    if (!profile) return null;
    if (typeof store?.getCharacter === 'function' && typeof store?.upsertCharacter === 'function' && !store.getCharacter(characterId)) {
      syncMemory(profile);
    }
    return profile;
  }
  function memoryView(characterId, scope = '') {
    const profile = ensureMemory(characterId);
    if (!profile) return null;
    const cleanScope = String(scope || '').slice(0, 256);
    let memory = null;
    if (store && typeof store.getCharacter === 'function' && store.getCharacter(characterId) && typeof store.bookFor === 'function') {
      const book = store.bookFor(characterId);
      const facts = book.facts({ scope: cleanScope });
      const cards = book.cards({ scope: cleanScope }).slice(-8).reverse().map(card => ({
        id: card.id, fromSeq: card.fromSeq, toSeq: card.toSeq, time: card.time, place: card.place,
        event: card.event, relation: card.relation, state: card.state, open: card.open,
        quotes: card.quote.map(item => ({ id: item.id, role: item.role, text: item.text })),
      }));
      const stats = book.stats({ scope: cleanScope });
      const rawChars = Number(stats.rawChars) || 0;
      const cardChars = Number(stats.cardChars) || 0;
      memory = {
        anchor: book.anchor(cleanScope),
        currentRelationship: book.currentRelationship(cleanScope),
        facts,
        cards,
        stats,
        compression: {
          rawChars,
          cardChars,
          savedChars: rawChars && cardChars ? Math.max(0, rawChars - cardChars) : 0,
          cardRatio: rawChars ? Math.round((cardChars / rawChars) * 1000) / 10 : 0,
          savedPercent: rawChars && cardChars ? Math.max(0, Math.round((1 - cardChars / rawChars) * 1000) / 10) : 0,
        },
      };
    }
    return {
      characterId,
      scope: cleanScope,
      name: profile.name,
      initialRelationship: profile.relationship,
      memory,
    };
  }
  return async function handle(req, res, url, context = {}) {
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
    const activeId = String(context.characterId || '');
    if (url.pathname === '/flavor-memory/api/state' && req.method === 'GET') {
      return send(res, 200, {
        characters: profiles.list(),
        activeCharacterId: profiles.find(activeId)?.id || profiles.list()[0]?.id || null,
        dataFile: store.dataFile || profiles.file || null,
      });
    }
    if (url.pathname === '/flavor-memory/api/memory' && req.method === 'GET') {
      const requested = String(url.searchParams.get('characterId') || activeId || '');
      if (!requested) return send(res, 400, { error: 'characterId is required' });
      const view = memoryView(requested, url.searchParams.get('scope') || '');
      return view ? send(res, 200, view) : send(res, 404, { error: 'character not found' });
    }
    if (url.pathname === '/flavor-memory/api/memory/scopes' && req.method === 'GET') {
      const characterId = String(url.searchParams.get('characterId') || activeId || '');
      if (!ensureMemory(characterId)) return send(res, 404, { error: 'character not found' });
      return send(res, 200, { characterId, scopes: store.scopes(characterId) });
    }
    if (url.pathname === '/flavor-memory/api/memory/search' && req.method === 'GET') {
      const characterId = String(url.searchParams.get('characterId') || activeId || '');
      if (!ensureMemory(characterId)) return send(res, 404, { error: 'character not found' });
      const scope = String(url.searchParams.get('scope') || '').slice(0, 256);
      const query = String(url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
      if (!query) return send(res, 400, { error: 'q is required' });
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 12, 1), 40);
      const hits = store.search(characterId, query, { scope, limit, now: Date.now() });
      return send(res, 200, { characterId, scope, query, hits });
    }
    if (url.pathname === '/flavor-memory/api/memory/read' && req.method === 'GET') {
      const characterId = String(url.searchParams.get('characterId') || activeId || '');
      if (!ensureMemory(characterId)) return send(res, 404, { error: 'character not found' });
      const scope = String(url.searchParams.get('scope') || '').slice(0, 256);
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) return send(res, 400, { error: 'id is required' });
      const entry = store.getRaw(characterId, id);
      if (!entry || (entry.scope || '') !== scope) return send(res, 404, { error: 'memory not found' });
      if (typeof store.recall === 'function') store.recall(characterId, id);
      return send(res, 200, { characterId, scope, entry });
    }
    if (url.pathname === '/flavor-memory/api/memory/pin' && req.method === 'POST') {
      const input = await body(req);
      const characterId = String(input.characterId || activeId || '');
      if (!ensureMemory(characterId)) return send(res, 404, { error: 'character not found' });
      const scope = String(input.scope || '').slice(0, 256);
      const id = String(input.id || '').trim();
      if (!id) return send(res, 400, { error: 'id is required' });
      const entry = store.getRaw(characterId, id);
      if (!entry || (entry.scope || '') !== scope) return send(res, 404, { error: 'memory not found' });
      const updated = store.pin(characterId, id, input.pinned !== false);
      return send(res, 200, { characterId, scope, entry: updated });
    }
    if (url.pathname === '/flavor-memory/api/memory/facts' && req.method === 'GET') {
      const characterId = String(url.searchParams.get('characterId') || activeId || '');
      if (!ensureMemory(characterId)) return send(res, 404, { error: 'character not found' });
      const scope = String(url.searchParams.get('scope') || '').slice(0, 256);
      return send(res, 200, { characterId, scope, ...store.facts(characterId, { scope }) });
    }
    if (url.pathname === '/flavor-memory/api/memory/fact' && req.method === 'POST') {
      const input = await body(req);
      const characterId = String(input.characterId || activeId || '');
      if (!ensureMemory(characterId)) return send(res, 404, { error: 'character not found' });
      if (!store || typeof store.setFact !== 'function' || typeof store.facts !== 'function') return send(res, 503, { error: 'memory store unavailable' });
      const scope = String(input.scope || '').slice(0, 256);
      const key = String(input.key || '').trim();
      const value = String(input.value || '').trim();
      if (!key || !value) return send(res, 400, { error: 'key and value are required' });
      const facts = store.facts(characterId, { scope });
      const active = facts.active.find(item => item.key === key);
      store.setFact({
        characterId, scope, key, value,
        sourceId: input.sourceId ? String(input.sourceId) : undefined,
        tags: Array.isArray(input.tags) ? input.tags : [],
        supersedes: input.supersedes || active?.id,
      });
      return send(res, 200, memoryView(characterId, scope));
    }
    if (url.pathname === '/flavor-memory/api/characters' && req.method === 'POST') {
      const input = await body(req);
      const saved = profiles.put(input);
      syncMemory(saved);
      return send(res, 200, saved);
    }
    const match = /^\/flavor-memory\/api\/characters\/([^/]+)$/.exec(url.pathname);
    if (match && req.method === 'GET') {
      const profile = profiles.find(decodeURIComponent(match[1]));
      return profile ? send(res, 200, profile) : send(res, 404, { error: 'character not found' });
    }
    if (match && req.method === 'PUT') {
      const input = await body(req);
      input.id = decodeURIComponent(match[1]);
      const saved = profiles.put(input);
      syncMemory(saved);
      return send(res, 200, saved);
    }
    if (match && req.method === 'DELETE') {
      return profiles.remove(decodeURIComponent(match[1]))
        ? send(res, 200, { ok: true }) : send(res, 404, { error: 'character not found' });
    }
    if (url.pathname === '/flavor-memory/api/preview' && req.method === 'POST') {
      const input = await body(req);
      const characterId = String(input.characterId || '');
      if (!profiles.find(characterId)) return send(res, 404, { error: 'character not found' });
      const view = profiles.buildPrompt(characterId, String(input.query || ''), {
        maxChars: Number(input.maxChars || 6000), examplesLimit: Number(input.examplesLimit || 3),
      });
      return send(res, 200, { prompt: view.prompt, lore: view.lore, examples: view.examples, chars: view.prompt.length });
    }
    if (url.pathname === '/flavor-memory/api/evolution' && req.method === 'POST') {
      const input = await body(req);
      if (!profiles.find(String(input.characterId || ''))) return send(res, 404, { error: 'character not found' });
      const candidate = profiles.makeCandidate(String(input.characterId || ''), input);
      if (candidate?.applied || candidate?.status === 'applied') {
        const profile = profiles.find(String(input.characterId || ''));
        syncMemory(profile);
        return send(res, 200, { candidate, applied: true, profile });
      }
      return send(res, 200, { candidate });
    }
    if (url.pathname === '/flavor-memory/api/evolution/apply' && req.method === 'POST') {
      const input = await body(req);
      const saved = profiles.updateEvolution(String(input.characterId || ''), input.candidate);
      syncMemory(saved);
      return send(res, 200, saved);
    }
    if (url.pathname === '/flavor-memory/api/evolution/reject' && req.method === 'POST') {
      const input = await body(req);
      return send(res, 200, profiles.rejectCandidate(String(input.characterId || ''), String(input.candidateId || '')));
    }
    if (url.pathname === '/flavor-memory/api/revisions/restore' && req.method === 'POST') {
      const input = await body(req);
      const saved = profiles.restore(String(input.characterId || ''), String(input.revisionId || ''));
      syncMemory(saved);
      return send(res, 200, saved);
    }
    if (url.pathname === '/flavor-memory/api/backup/export' && req.method === 'GET') {
      const memories = [];
      for (const profile of profiles.list()) {
        if (store.getCharacter(profile.id)) {
          memories.push({ characterId: profile.id, ...store.exportAll().characters.find(item => item.id === profile.id)?.memory });
        }
      }
      return send(res, 200, { schema: 'flavor-memory-export', version: 1, exportedAt: new Date().toISOString(), profiles: profiles.list(), memories });
    }
    if (url.pathname === '/flavor-memory/api/backup/import' && req.method === 'POST') {
      const input = await body(req, 64 * 1024 * 1024);
      if (!input || input.schema !== 'flavor-memory-export' || !Array.isArray(input.profiles) || !Array.isArray(input.memories)) {
        return send(res, 400, { error: 'invalid backup format' });
      }
      let profileCount = 0;
      for (const profile of input.profiles) {
        profiles.put(profile); profileCount += 1;
      }
      for (const memory of input.memories) {
        if (!memory || typeof memory.characterId !== 'string') continue;
        if (!store.getCharacter(memory.characterId)) {
          const profile = profiles.find(memory.characterId);
          if (!profile) continue;
          syncMemory(profile);
        }
        store.replaceCharacterMemory(memory.characterId, memory);
      }
      return send(res, 200, { ok: true, profiles: profileCount, memories: input.memories.length });
    }
    if (url.pathname === '/flavor-memory/api/import' && req.method === 'POST') {
      const input = await body(req);
      const saved = profiles.put(importSillyTavernCard(input));
      syncMemory(saved);
      return send(res, 200, saved);
    }
    if (url.pathname === '/flavor-memory/api/export' && req.method === 'GET') {
      const characterId = String(url.searchParams.get('characterId') || '');
      if (characterId) {
        try { return send(res, 200, profiles.exportCharacter(characterId)); }
        catch { return send(res, 404, { error: 'character not found' }); }
      }
      return send(res, 200, { version: 2, characters: profiles.list() });
    }
    return send(res, 404, { error: 'not found' });
  };
}

export function legacyToProfile(input = {}) {
  return normalizeCharacterProfile({
    ...input,
    id: input.id || input.characterId || 'default',
    name: input.name || input.characterName || input.id || input.characterId,
  });
}
















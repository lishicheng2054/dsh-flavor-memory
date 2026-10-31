import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStore, extractText } from './gateway.mjs';
import { createProfileStore, dshHomeDir, resolveProfilesFile } from './character-store.mjs';
import { createHostRoutes } from './host-routes.mjs';

export const name = 'flavor-memory';
export const inject = ['tools', 'systemPrompt'];

function configNumber(value, fallback) {
  const resolved = value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
  const number = Number(resolved);
  return Number.isFinite(number) ? number : fallback;
}
export function resolveDataFile(value) {
  if (!value) return join(dshHomeDir(), 'flavor-memory', 'memory.json');
  if (String(value).startsWith('~')) return join(homedir(), String(value).slice(1).replace(/^[\\/]/, ''));
  return String(value);
}
function textOfEvent(data) {
  if (!data) return '';
  return extractText(data.message?.content ?? data.content ?? data);
}
function sessionScope(session, event) {
  return String(session?.id || event?.sessionId || '').trim().slice(0, 256);
}
function stableEventId(role, session, event, data) {
  const messageId = data?.message?.id ?? data?.id;
  if (messageId != null && String(messageId).trim()) return `dsh:${role}:${String(messageId).trim()}`;
  if ((session?.id || event?.sessionId) && Number.isInteger(event?.seq)) {
    return `dsh:${session?.id || event.sessionId}:${role}:${event.seq}`;
  }
  return null;
}
function hasPersistedText(store, characterId, role, text, scope = '') {
  return store.bookFor(characterId).recent(8, { scope }).some(entry => entry.role === role && entry.text === text);
}
function legacyProfileFromConfig(config, characterId) {
  const soul = String(config.soul || '').trim();
  if (!soul) return null;
  return {
    id: characterId, name: String(config.characterName || characterId), soul,
    voice: Array.isArray(config.voice) ? config.voice : [], relationship: String(config.relationship || ''),
    description: String(config.description || ''), personality: String(config.personality || ''),
    scenario: String(config.scenario || ''), firstMessage: String(config.firstMessage || ''),
  };
}
function syncMemoryProfile(store, profile) {
  if (!store || !profile) return;
  const existing = store.getCharacter(profile.id);
  store.upsertCharacter({
    id: profile.id,
    name: profile.name,
    soul: profile.soul || existing?.soul || '',
    voice: profile.voice,
    relationship: profile.relationship,
  });
}

export function apply(ctx, config = {}) {
  const characterId = String(config.characterId || 'default');
  const store = config.store || createStore({
    root: resolveDataFile(config.dataFile),
    saveDelayMs: configNumber(config.saveDelayMs, 40),
    baseStabilityDays: configNumber(config.baseStabilityDays, 30),
  });
  if (!store.getCharacter(characterId)) {
    const soul = String(config.soul || '').trim();
    if (!soul) throw new Error(`flavor-memory character not configured: ${characterId} (set config.soul, config.voice, config.relationship)`);
    store.upsertCharacter({
      id: characterId, name: String(config.characterName || characterId), soul,
      voice: Array.isArray(config.voice) ? config.voice : [], relationship: String(config.relationship || ''),
    });
  }
  const profileStore = config.profileStore || createProfileStore({
    file: config.profilesFile || resolveProfilesFile(),
    seed: legacyProfileFromConfig(config, characterId),
  });
  const activeProfile = profileStore.find(characterId);
  if (activeProfile) syncMemoryProfile(store, activeProfile);
  const autoCompactEvery = configNumber(config.autoCompactEvery, 20);
  const maxCards = Math.min(Math.max(configNumber(config.maxCards, 6), 1), 20);
  const disposers = [];
  const emit = typeof config.onEvent === 'function' ? config.onEvent : () => {};
  const define = config.defineTool;
  const register = (definition) => {
    const tool = define ? define(definition) : definition;
    if (ctx.tools?.register) disposers.push(ctx.tools.register(tool));
    return tool;
  };
  const executeInScope = (tool, args = {}, runtime = {}) => {
    const scope = String(runtime?.sessionId || runtime?.session?.id || runtime?.context?.sessionId || args?.sessionId || args?.session_id || '').trim().slice(0, 256);
    return tool.execute({ ...args, __scope: scope }, runtime);
  };

  register({
    name: 'flavor_memory_fact',
    description: 'List or update durable key-value facts. Replacing a value keeps the old fact as superseded history; sourceId must point to archived text.',
    parameters: { action: { type: 'string', required: true }, key: { type: 'string' }, value: { type: 'string' }, sourceId: { type: 'string' }, supersedes: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, at: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const scope = args.__scope || '';
      if (args.action === 'list') return JSON.stringify(store.facts(characterId, { scope }));
      if (args.action !== 'set') throw new Error('action must be set or list');
      if (typeof args.key !== 'string' || !args.key.trim()) throw new Error('key is required');
      if (typeof args.value !== 'string' || !args.value.trim()) throw new Error('value is required');
      return JSON.stringify(store.setFact({ characterId, scope, key: args.key, value: args.value, sourceId: args.sourceId, supersedes: args.supersedes, tags: Array.isArray(args.tags) ? args.tags : [], at: args.at }));
    },
  });
  register({
    name: 'flavor_memory_pin',
    description: 'Pin or unpin one archived message. Pinned entries are protected from time decay but remain scoped to the current session.',
    parameters: { id: { type: 'string', required: true }, pinned: { type: 'boolean' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('id is required');
      return JSON.stringify(store.pin(characterId, args.id, args.pinned !== false));
    },
  });
  register({
    name: 'flavor_memory_search',
    description: 'Search memory metadata. Returns ids, time, tags, why and a short snippet. Raw text requires flavor_memory_read.',
    parameters: { query: { type: 'string', required: true }, limit: { type: 'integer' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required');
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
      return JSON.stringify(store.bookFor(characterId).search(args.query, { limit, scope: args.__scope || '' }));
    },
  });
  register({
    name: 'flavor_memory_read',
    description: 'Read one exact archived message by id and reinforce it.',
    parameters: { id: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('id is required');
      const book = store.bookFor(characterId);
      const item = book.get(args.id);
      if (!item || item.scope && args.__scope && item.scope !== args.__scope) throw new Error(`memory not found: ${args.id}`);
      if (book.recall) book.recall(args.id);
      return JSON.stringify(item);
    },
  });
  register({
    name: 'flavor_memory_remember',
    description: 'Archive an exact user or assistant message with optional tags.',
    parameters: { text: { type: 'string', required: true }, role: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, at: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('text is required');
      const role = args.role === 'assistant' || args.role === 'system' ? args.role : 'user';
      return JSON.stringify(store.remember({ characterId, role, text: args.text, at: args.at, tags: Array.isArray(args.tags) ? args.tags : [], scope: args.__scope || '' }));
    },
  });
  register({
    name: 'flavor_memory_compact',
    description: 'Create an incremental scene card over archived messages. Cite source ids; raw text remains available.',
    parameters: { throughSeq: { type: 'integer', required: true }, time: { type: 'string' }, place: { type: 'string' }, event: { type: 'array', items: { type: 'string' } }, relation: { type: 'string' }, state: { type: 'array', items: { type: 'string' } }, open: { type: 'array', items: { type: 'string' } }, quoteIds: { type: 'array', items: { type: 'string' } }, supersedes: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      if (!Number.isInteger(args.throughSeq)) throw new Error('throughSeq is required');
      return JSON.stringify(store.commitScene(characterId, { throughSeq: args.throughSeq, scope: args.__scope || '', card: { scope: args.__scope || '', time: args.time, place: args.place, event: args.event, relation: args.relation, state: args.state, open: args.open, quoteIds: args.quoteIds, supersedes: args.supersedes } }));
    },
  });
  register({
    name: 'flavor_memory_anchor',
    description: 'Return the short personality and relationship receipt for the current character.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const scope = args.__scope || '';
      const book = store.bookFor(characterId);
      return JSON.stringify({ anchor: book.anchor(scope), relationship: book.currentRelationship(scope), stats: book.stats({ scope }) });
    },
  });
  register({
    name: 'flavor_memory_propose_evolution',
    description: 'Propose a controlled change to soul, voice, or relationship. Evidence source ids are mandatory when configured. This only creates a pending candidate.',
    parameters: { target: { type: 'string', required: true }, value: { type: 'string', required: true }, evidence: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      if (!['soul', 'voice', 'relationship'].includes(args.target)) throw new Error('target must be soul, voice or relationship');
      const value = args.target === 'voice' ? String(args.value || '').split(/[,\n，]/).map(item => item.trim()).filter(Boolean) : args.value;
      const candidate = profileStore.makeCandidate(characterId, { target: args.target, value, evidence: args.evidence, reason: args.reason });
      const profile = profileStore.find(characterId);
      if (candidate?.applied) syncMemoryProfile(store, profile);
      return JSON.stringify({ candidate, pending: profile?.pendingEvolutions || [], applied: Boolean(candidate?.applied) });
    },
  });
  register({
    name: 'flavor_memory_list_evolution',
    description: 'List pending, applied and rejected personality evolution candidates.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const profile = profileStore.find(characterId);
      return JSON.stringify({ pending: profile?.pendingEvolutions || [], history: profile?.evolutionHistory || [], revisions: (profile?.revisions || []).map(({ profile: _profile, ...item }) => item) });
    },
  });

  if (ctx.systemPrompt?.context) {
    disposers.push(ctx.systemPrompt.context({
      name: 'flavor-memory', order: 1000,
      text: assembly => {
        const messages = Array.isArray(assembly?.messages) ? assembly.messages : [];
        const scope = String(assembly?.sessionId || assembly?.session?.id || assembly?.context?.sessionId || '').trim().slice(0, 256);
        const lastMessage = [...messages].reverse().find(item => item?.role === 'user');
        const archived = store.bookFor(characterId).recent(20, { scope }).reverse().find(item => item.role === 'user');
        const query = String(assembly?.query || assembly?.userText || (typeof lastMessage?.content === 'string' ? lastMessage.content : '') || archived?.text || '');
        const view = store.promptView(characterId, { query, recent: 8, includeRecent: false, maxCards, scope, voiceSamples: configNumber(config.voiceSamples, 3), maxPromptChars: configNumber(config.maxPromptChars, 4000) });
        if (view.hits.length) store.reinforcePromptHits(characterId, view.hits);
        const profileView = profileStore.buildPrompt(characterId, query, {
          maxChars: Math.min(Math.max(configNumber(config.profileMaxChars, 5000), 500), 12000),
          examplesLimit: Math.min(Math.max(configNumber(config.examplesLimit, 3), 0), 10),
        });
        return [view.prompt, profileView.prompt].filter(Boolean).join('\n\n');
      },
    }));
  }

  if (ctx.on) {
    disposers.push(ctx.on('session/event', (session, event) => {
      const data = event?.data;
      if (event?.type === 'compaction/summary') {
        emit({ type: 'compaction:observed', characterId, shadowedSeqs: data?.shadowedSeqs || [] });
        return;
      }
      if (event?.type !== 'user/message' && event?.type !== 'assistant/message') return;
      if (event.type === 'user/message' && data?.source?.kind !== 'user') return;
      const text = textOfEvent(data);
      if (!text.trim()) return;
      const role = event.type === 'user/message' ? 'user' : 'assistant';
      const scope = sessionScope(session, event);
      const durableId = stableEventId(role, session, event, data);
      if (durableId ? store.getRaw(characterId, durableId) : hasPersistedText(store, characterId, role, text, scope)) return;
      const at = event.time || data.time || data.message?.time || new Date().toISOString();
      if (role === 'user') {
        store.archiveTurn(characterId, { userText: text, assistantText: '', userId: durableId || undefined, at, scope });
      } else {
        store.archiveTurn(characterId, { userText: '', assistantText: text, assistantId: durableId || undefined, at, scope });
        if (autoCompactEvery > 0) {
          const stats = store.bookFor(characterId).stats({ scope });
          const throughSeq = stats.lastSeq ?? stats.messages;
          if (throughSeq - stats.lastCompactedSeq >= autoCompactEvery) store.autoCompact(characterId, { throughSeq, maxEvents: 5, quotes: 2, scope });
        }
      }
    }));
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], child => {
      child.effect(() => child.webServer.register({
        kind: 'prefix', path: '/flavor-memory',
        handler: createHostRoutes({ store, profiles: profileStore, characterId }),
      }), 'flavor-memory: studio routes');
    });
  }

  return {
    store, profileStore, executeInScope,
    dispose() {
      for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose();
      if (!config.store) store.close();
    },
  };
}



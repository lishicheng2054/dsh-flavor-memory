import { randomUUID } from 'node:crypto';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODES = new Set(['locked', 'suggest', 'bounded', 'free']);
const INSERT_MODES = new Set(['before', 'after', 'replace']);

function text(value, fallback = '') {
  return String(value ?? fallback).trim();
}
function list(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(item)).filter(Boolean))];
}
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function finite(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
function id(value, fallback) {
  const next = text(value, fallback);
  if (!ID_PATTERN.test(next)) throw new Error(`invalid id: ${next}`);
  return next;
}

function normalizeUsageEntry(value) {
  const source = object(value);
  return {
    count: Math.max(0, Math.round(Number(source.count) || 0)),
    lastAt: Math.max(0, Number(source.lastAt) || 0),
  };
}

export function emptyCharacterProfile(input = {}) {
  const usage = object(input.loreUsage);
  return {
    version: 3,
    id: id(input.id || 'default', 'default'),
    name: text(input.name) || (input.id ? text(input.id) : '未命名角色'),
    description: text(input.description),
    personality: text(input.personality),
    scenario: text(input.scenario),
    firstMessage: text(input.firstMessage),
    alternateGreetings: list(input.alternateGreetings ?? input.alternate_greetings),
    systemPrompt: text(input.systemPrompt ?? input.system_prompt),
    postHistoryInstructions: text(input.postHistoryInstructions ?? input.post_history_instructions),
    creatorNotes: text(input.creatorNotes ?? input.creator_notes),
    creator: text(input.creator),
    characterVersion: text(input.characterVersion ?? input.character_version),
    tags: list(input.tags),
    soul: text(input.soul),
    voice: list(input.voice),
    relationship: text(input.relationship),
    examples: (Array.isArray(input.examples) ? input.examples : []).map((item, index) => ({
      id: id(item?.id || `example-${index + 1}`, `example-${index + 1}`),
      user: text(item?.user),
      assistant: text(item?.assistant),
      tags: list(item?.tags),
    })).filter(item => item.user || item.assistant),
    worldbook: (Array.isArray(input.worldbook) ? input.worldbook : []).map((item, index) => ({
      id: id(item?.id || `lore-${index + 1}`, `lore-${index + 1}`),
      name: text(item?.name, `条目 ${index + 1}`),
      content: text(item?.content),
      keywords: list(item?.keywords),
      regex: text(item?.regex),
      priority: finite(item?.priority, 50, 0, 100),
      position: INSERT_MODES.has(item?.position) ? item.position : 'before',
      enabled: item?.enabled !== false,
      constant: item?.constant === true,
      probability: finite(item?.probability, 100, 0, 100),
      cooldownMs: finite(item?.cooldownMs, 0, 0, 86400000),
      maxInjections: Math.round(finite(item?.maxInjections, 0, 0, 1000)),
      tags: list(item?.tags),
    })).filter(item => item.content || item.keywords.length || item.regex),
    triggers: (Array.isArray(input.triggers) ? input.triggers : []).map((item, index) => ({
      id: id(item?.id || `trigger-${index + 1}`, `trigger-${index + 1}`),
      name: text(item?.name, `触发 ${index + 1}`),
      keywords: list(item?.keywords),
      regex: text(item?.regex),
      loreIds: list(item?.loreIds),
      prompt: text(item?.prompt),
      priority: finite(item?.priority, 50, 0, 100),
      enabled: item?.enabled !== false,
    })).filter(item => item.keywords.length || item.regex || item.prompt),
    evolution: normalizeEvolution(input.evolution),
    loreUsage: Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, normalizeUsageEntry(value)])),
    pendingEvolutions: (Array.isArray(input.pendingEvolutions) ? input.pendingEvolutions : [])
      .filter(item => item && ['soul', 'voice', 'relationship'].includes(item.target))
      .map(item => ({ ...item, id: id(item.id || randomUUID(), randomUUID()), status: item.status === 'rejected' ? 'rejected' : 'pending' })),
    evolutionHistory: (Array.isArray(input.evolutionHistory) ? input.evolutionHistory : [])
      .filter(item => item && ['soul', 'voice', 'relationship'].includes(item.target))
      .map(item => ({ ...item, id: id(item.id || randomUUID(), randomUUID()) })),
    revisions: (Array.isArray(input.revisions) ? input.revisions : [])
      .filter(item => item && item.profile && typeof item.profile === 'object')
      .map(item => ({ id: id(item.id || randomUUID(), randomUUID()), at: text(item.at) || new Date().toISOString(), kind: text(item.kind, 'manual'), profile: normalizeCharacterProfile(item.profile) }))
      .slice(-100),
  };
}

function normalizeEvolution(value = {}) {
  const source = object(value);
  const legacyMode = MODES.has(source.mode) ? source.mode : null;
  return {
    soulMode: MODES.has(source.soulMode) ? source.soulMode : (legacyMode || 'suggest'),
    voiceMode: MODES.has(source.voiceMode) ? source.voiceMode : (legacyMode || 'bounded'),
    relationshipMode: MODES.has(source.relationshipMode) ? source.relationshipMode : 'bounded',
    maxSoulDelta: finite(source.maxSoulDelta, 0.05, 0, 1),
    maxVoiceDrift: finite(source.maxVoiceDrift, 0.2, 0, 1),
    requireEvidence: source.requireEvidence !== false,
    requireApproval: source.requireApproval !== false,
    keepOriginal: source.keepOriginal !== false,
    historyLimit: Math.round(finite(source.historyLimit, 50, 1, 500)),
  };
}

export function normalizeCharacterProfile(input = {}) {
  return emptyCharacterProfile(input);
}

function tokensFor(value) {
  const clean = text(value).toLowerCase();
  if (!clean) return [];
  const terms = new Set([clean]);
  for (const part of clean.split(/[\s,，。.!！?？;；:：]+/).filter(Boolean)) terms.add(part);
  return [...terms];
}

function regexMatches(pattern, query) {
  if (!pattern) return false;
  try { return new RegExp(pattern, 'iu').test(query); } catch { return false; }
}

export function evaluateLore(profile, { query = '', sessionId = '', at = Date.now(), usage = {} } = {}) {
  const normalized = normalizeCharacterProfile(profile);
  const clean = text(query).toLowerCase();
  const state = object(usage);
  const byId = new Map(normalized.worldbook.map(item => [item.id, item]));
  const selected = new Map();
  const add = (entry, reason, score) => {
    if (!entry || !entry.enabled) return;
    const previous = selected.get(entry.id);
    if (!previous || score > previous.score) selected.set(entry.id, { ...entry, reason, score });
  };
  for (const entry of normalized.worldbook) {
    if (!entry.enabled) continue;
    const usageEntry = object(state[entry.id]);
    const lastAt = Number(usageEntry.lastAt || 0);
    const count = Number(usageEntry.count || 0);
    if (entry.maxInjections > 0 && count >= entry.maxInjections) continue;
    if (entry.cooldownMs > 0 && Number(at) - lastAt < entry.cooldownMs) continue;
    const keywordHit = entry.keywords.some(keyword => clean.includes(keyword.toLowerCase()));
    const regexHit = regexMatches(entry.regex, clean);
    const constant = entry.constant;
    if (!keywordHit && !regexHit && !constant) continue;
    const probability = entry.probability >= 100 ? true : Math.random() * 100 < entry.probability;
    if (!probability) continue;
    const score = entry.priority + (regexHit ? 20 : 0) + (constant ? 5 : 0);
    add(entry, keywordHit ? 'keyword' : regexHit ? 'regex' : 'constant', score);
  }
  for (const trigger of normalized.triggers) {
    if (!trigger.enabled) continue;
    const hit = trigger.keywords.some(keyword => clean.includes(keyword.toLowerCase())) || regexMatches(trigger.regex, clean);
    if (!hit) continue;
    for (const loreId of trigger.loreIds) add(byId.get(loreId), 'trigger', trigger.priority + 10);
    if (trigger.prompt) {
      add({
        id: trigger.id, name: trigger.name, content: trigger.prompt, keywords: trigger.keywords,
        regex: trigger.regex, priority: trigger.priority, position: 'before', enabled: true,
        constant: false, probability: 100, cooldownMs: 0, maxInjections: 0, tags: [],
      }, 'trigger', trigger.priority);
    }
  }
  return [...selected.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function selectExamples(profile, { query = '', limit = 3 } = {}) {
  const normalized = normalizeCharacterProfile(profile);
  const clean = text(query).toLowerCase();
  return normalized.examples
    .map((example, index) => {
      const joined = `${example.user} ${example.assistant} ${example.tags.join(' ')}`.toLowerCase();
      let score = 0;
      if (clean) for (const token of tokensFor(clean)) if (joined.includes(token)) score += token.length >= 2 ? 2 : 0.2;
      return { example, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, Number(limit) || 0))
    .map(item => item.example);
}

export function renderProfilePrompt(profile, { query = '', lore = [], examples = [], maxChars = 6000 } = {}) {
  const normalized = normalizeCharacterProfile(profile);
  const sections = [];
  let length = 0;
  const push = value => {
    const clean = text(value);
    if (!clean || length >= maxChars) return;
    const remaining = maxChars - length - (sections.length ? 2 : 0);
    if (remaining <= 0) return;
    const chunk = clean.slice(0, remaining);
    sections.push(chunk);
    length += chunk.length + (sections.length > 1 ? 2 : 0);
  };
  const before = lore.filter(item => item.position !== 'after');
  const after = lore.filter(item => item.position === 'after');
  const renderLore = items => items.length
    ? `<worldbook>\n${items.map(item => `[${item.name}] ${item.content}`).join('\n')}\n</worldbook>`
    : '';
  push(renderLore(before));
  if (normalized.systemPrompt) push(`角色系统规则：${normalized.systemPrompt}`);
  push(normalized.soul);
  if (normalized.description) push(`角色描述：${normalized.description}`);
  if (normalized.personality) push(`性格：${normalized.personality}`);
  if (normalized.scenario) push(`场景：${normalized.scenario}`);
  if (normalized.relationship) push(`初始关系：${normalized.relationship}`);
  if (normalized.voice.length) push(`说话方式：${normalized.voice.join('；')}`);
  push(renderLore(after));
  if (examples.length) {
    push(`<examples>\n${examples.map(item => `${item.user ? `用户：${item.user}\n` : ''}${item.assistant ? `角色：${item.assistant}` : ''}`).join('\n\n')}\n</examples>`);
  }
  if (normalized.postHistoryInstructions) push(`回复前遵守：${normalized.postHistoryInstructions}`);
  return sections.join('\n\n').slice(0, maxChars);
}

function evolutionField(target) {
  const field = ['soul', 'voice', 'relationship'].includes(target) ? target : null;
  if (!field) throw new Error('target must be soul, voice or relationship');
  return field;
}

function editDistance(left, right) {
  const a = [...String(left ?? '')];
  const b = [...String(right ?? '')];
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function evolutionDistance(field, before, after) {
  if (field === 'voice') {
    const left = new Set(list(before));
    const right = new Set(list(after));
    const union = new Set([...left, ...right]);
    if (!union.size) return { metric: 'set-drift', value: 0 };
    const intersection = [...left].filter(item => right.has(item)).length;
    return { metric: 'set-drift', value: 1 - intersection / union.size };
  }
  const left = text(before);
  const right = text(after);
  const denominator = Math.max([...left].length, [...right].length, 1);
  return { metric: 'edit-distance', value: editDistance(left, right) / denominator };
}

export function createEvolutionCandidate(profile, { target, value, evidence = [], reason = '' } = {}) {
  const normalized = normalizeCharacterProfile(profile);
  const field = evolutionField(target);
  const mode = normalized.evolution[`${field}Mode`];
  if (mode === 'locked') throw new Error(`${field} is locked`);
  const evidenceIds = list(evidence);
  if (normalized.evolution.requireEvidence && evidenceIds.length === 0) throw new Error('evidence is required');
  const before = field === 'voice' ? [...normalized.voice] : normalized[field];
  const after = field === 'voice' ? list(value) : text(value);
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  const change = evolutionDistance(field, before, after);
  const limit = field === 'voice' ? normalized.evolution.maxVoiceDrift : normalized.evolution.maxSoulDelta;
  if (mode === 'bounded' && change.value > limit + 1e-9) {
    throw new Error(`${field} change ${change.value.toFixed(3)} exceeds ${limit} (${change.metric})`);
  }
  const needsApproval = normalized.evolution.requireApproval || mode === 'suggest';
  return {
    id: randomUUID(), createdAt: new Date().toISOString(), target: field, before, after,
    evidence: evidenceIds, reason: text(reason), mode, change, limit,
    status: needsApproval ? 'pending' : 'bounded-auto',
  };
}

export function applyApprovedEvolution(profile, candidate, { at = new Date().toISOString() } = {}) {
  if (!candidate || !['pending', 'applied', 'bounded-auto'].includes(candidate.status)) throw new Error('invalid or already rejected candidate');
  const next = normalizeCharacterProfile(profile);
  const field = evolutionField(candidate.target);
  if (next.evolution.keepOriginal && !next.revisions.length) {
    next.revisions.push({ id: randomUUID(), at, kind: 'original', profile: snapshotProfile(next) });
  }
  const snapshot = snapshotProfile(next);
  next[field] = field === 'voice' ? list(candidate.after) : text(candidate.after);
  next.evolutionHistory.push({ ...candidate, status: 'applied', appliedAt: at });
  next.evolutionHistory = next.evolutionHistory.slice(-next.evolution.historyLimit);
  next.pendingEvolutions = next.pendingEvolutions.filter(item => item.id !== candidate.id);
  if (next.evolution.keepOriginal) {
    next.revisions.push({ id: randomUUID(), at, kind: 'evolution', profile: snapshot });
    next.revisions = next.revisions.slice(-100);
  }
  return normalizeCharacterProfile(next);
}

export function approveEvolution(profile, candidateId, options = {}) {
  const next = normalizeCharacterProfile(profile);
  const candidate = next.pendingEvolutions.find(item => item.id === candidateId);
  if (!candidate) throw new Error('pending evolution not found');
  return applyApprovedEvolution(next, candidate, options);
}

function snapshotProfile(profile) {
  return normalizeCharacterProfile({ ...profile, revisions: [] });
}

export function rejectEvolution(profile, candidateId) {
  const next = normalizeCharacterProfile(profile);
  const candidate = next.pendingEvolutions.find(item => item.id === candidateId);
  if (!candidate) throw new Error('pending evolution not found');
  next.pendingEvolutions = next.pendingEvolutions.filter(item => item.id !== candidateId);
  next.evolutionHistory = next.evolutionHistory.filter(item => item.id !== candidateId);
  next.evolutionHistory.push({ ...candidate, status: 'rejected', rejectedAt: new Date().toISOString() });
  next.evolutionHistory = next.evolutionHistory.slice(-next.evolution.historyLimit);
  return normalizeCharacterProfile(next);
}

export function restoreRevision(profile, revisionId) {
  const next = normalizeCharacterProfile(profile);
  const revision = next.revisions.find(item => item.id === revisionId);
  if (!revision) throw new Error('revision not found');
  return normalizeCharacterProfile({
    ...revision.profile, id: next.id, revisions: next.revisions,
    evolutionHistory: next.evolutionHistory, loreUsage: next.loreUsage,
    pendingEvolutions: next.pendingEvolutions,
  });
}

export function importSillyTavernCard(input = {}) {
  const root = object(input);
  const data = object(root.data);
  const source = Object.keys(data).length ? data : root;
  const extensions = object(source.extensions);
  const flavor = object(extensions['dsh-flavor-memory']);
  const characterBook = object(source.character_book ?? extensions.character_book ?? root.character_book);
  const exampleSource = Array.isArray(source.mes_example) ? source.mes_example.join('\n') : text(source.mes_example);
  const examples = [];
  for (const item of Array.isArray(source.examples) ? source.examples : []) examples.push(item);
  const blocks = exampleSource.split(/\n\s*<START>\s*\n?/i).map(item => item.trim()).filter(Boolean);
  for (const block of blocks) {
    const match = /(?:^|\n)\s*\{\{user\}\}\s*[:：]?\s*([\s\S]*?)(?:\n\s*\{\{char\}\}\s*[:：]?\s*|$)/i.exec(block);
    if (match) {
      const rest = block.slice(match.index + match[0].length);
      examples.push({ user: text(match[1]), assistant: text(rest.replace(/^\s*\{\{char\}\}\s*[:：]?\s*/i, '')) });
    } else if (/\{\{char\}\}/i.test(block)) {
      const [userPart, ...assistantParts] = block.split(/\{\{char\}\}\s*[:：]?/i);
      examples.push({ user: text(userPart.replace(/\{\{user\}\}\s*[:：]?/i, '')), assistant: text(assistantParts.join('{{char}}')) });
    }
  }
  const entries = Array.isArray(characterBook.entries) ? characterBook.entries : [];
  const worldbook = entries.map((item, index) => {
    const entry = object(item);
    const entryExtensions = object(entry.extensions);
    const flavorEntry = object(entryExtensions['dsh-flavor-memory']);
    const triggers = list(entry.keys ?? entry.keywords);
    const secondary = list(entry.secondary_keys);
    return {
      id: flavorEntry.id || `lore-${index + 1}`,
      name: text(entry.comment) || text(entry.name) || (triggers[0] || `条目 ${index + 1}`),
      content: text(entry.content),
      keywords: [...new Set([...triggers, ...secondary])],
      regex: text(flavorEntry.regex),
      priority: finite(entry.insertion_order, 50, 0, 100),
      position: ['before', 'after', 'replace'].includes(entry.position) ? entry.position : 'before',
      enabled: entry.enabled !== false,
      constant: entry.constant === true,
      probability: finite(entry.probability, 100, 0, 100),
      cooldownMs: finite(flavorEntry.cooldownMs, 0, 0, 86400000),
      maxInjections: Math.round(finite(flavorEntry.maxInjections, 0, 0, 1000)),
      tags: list(entry.tags).length ? list(entry.tags) : list(flavorEntry.tags),
    };
  }).filter(item => item.content || item.keywords.length);
  const voice = list(source.voice ?? source.voice_examples ?? []);
  const derivedId = String(source.name || '')
    .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  return normalizeCharacterProfile({
    id: flavor.id || source.characterId || source.id || derivedId || 'imported-character',
    name: source.name || root.name,
    description: source.description,
    personality: source.personality,
    scenario: source.scenario,
    firstMessage: source.first_mes ?? source.firstMessage,
    alternateGreetings: flavor.alternateGreetings || source.alternate_greetings || source.alternateGreetings,
    systemPrompt: flavor.systemPrompt || source.system_prompt || source.systemPrompt,
    postHistoryInstructions: flavor.postHistoryInstructions || source.post_history_instructions || source.postHistoryInstructions,
    creatorNotes: flavor.creatorNotes || source.creator_notes || source.creatorNotes,
    creator: flavor.creator || source.creator,
    characterVersion: flavor.characterVersion || source.character_version || source.characterVersion,
    tags: flavor.tags || source.tags,
    soul: flavor.soul || source.soul || [source.description, source.personality].filter(Boolean).join('\n\n'),
    voice: flavor.voice?.length ? flavor.voice : voice,
    relationship: flavor.relationship || source.relationship || source.creator_notes,
    examples: flavor.examples?.length ? flavor.examples : examples,
    worldbook,
    triggers: flavor.triggers,
    evolution: flavor.evolution || source.evolution,
    evolutionHistory: flavor.evolutionHistory || source.evolutionHistory,
    revisions: flavor.revisions || source.revisions,
    loreUsage: source.loreUsage,
    pendingEvolutions: source.pendingEvolutions,
  });
}

export function profileToLegacy(profile) {
  const normalized = normalizeCharacterProfile(profile);
  return {
    id: normalized.id, name: normalized.name, soul: normalized.soul,
    voice: normalized.voice, relationship: normalized.relationship,
  };
}



















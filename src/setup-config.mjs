import { homedir } from 'node:os';
import { join } from 'node:path';

const MANAGED_START = '# >>> dsh-flavor-memory managed config (rerun setup to replace this block)';
const MANAGED_END = '# <<< dsh-flavor-memory managed config';
const PLUGIN_ID = 'flavor-memory';
const FLAVOR_BLOCK_PATTERN = /^([ \t]*)-[ \t]+id:[ \t]*["']?flavor-memory["']?[ \t]*$/m;

function requiredText(value, field, fallback = '') {
  const text = String(value ?? fallback).trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function identifier(value, field) {
  const text = requiredText(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text)) {
    throw new Error(`${field} must use 1-64 letters, digits, dots, underscores or hyphens`);
  }
  return text;
}

function numberInRange(value, fallback, field, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  return number;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value).trim()).filter(Boolean))];
}

function memoryDir() {
  const raw = String(process.env.DSH_HOME || '').trim();
  if (!raw) return '~/.dsh/flavor-memory';
  const expanded = raw === '~'
    ? homedir()
    : raw.startsWith('~/') || raw.startsWith('~\\') ? join(homedir(), raw.slice(2)) : raw;
  const normalized = expanded.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${normalized}/flavor-memory`;
}

function dataFilePath(value, characterId) {
  const text = String(value || `${memoryDir()}/${characterId}.json`).trim();
  if (!text || /[\u0000\r\n]/.test(text)) throw new Error('dataFile must be a non-empty single-line path');
  return text;
}

export function buildSetupConfig(input = {}) {
  const characterId = identifier(input.characterId || 'ayu', 'characterId');
  const soul = requiredText(input.soul, 'soul');
  return {
    characterId,
    characterName: requiredText(input.characterName, 'characterName', characterId),
    dataFile: dataFilePath(input.dataFile, characterId),
    profilesFile: dataFilePath(input.profilesFile || `${memoryDir()}/characters.json`, characterId),
    maxCards: Math.round(numberInRange(input.maxCards, 6, 'maxCards', 1, 20)),
    voiceSamples: Math.round(numberInRange(input.voiceSamples, 3, 'voiceSamples', 0, 3)),
    maxPromptChars: Math.round(numberInRange(input.maxPromptChars, 4000, 'maxPromptChars', 500, 20000)),
    autoCompactEvery: Math.round(numberInRange(input.autoCompactEvery, 20, 'autoCompactEvery', 0, 1000)),
    baseStabilityDays: numberInRange(input.baseStabilityDays, 30, 'baseStabilityDays', 1, 3650),
    saveDelayMs: Math.round(numberInRange(input.saveDelayMs, 40, 'saveDelayMs', 0, 60000)),
    soul,
    voice: uniqueStrings(input.voice),
    relationship: String(input.relationship ?? '').trim(),
  };
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function renderFlavorBlock(baseConfig) {
  const config = buildSetupConfig(baseConfig);
  const lines = [
    MANAGED_START,
    `- id: ${PLUGIN_ID}`,
    '  config:',
    `    characterId: ${yamlString(config.characterId)}`,
    `    characterName: ${yamlString(config.characterName)}`,
    `    dataFile: ${yamlString(config.dataFile)}`,
    `    profilesFile: ${yamlString(config.profilesFile)}`,
    `    maxCards: ${config.maxCards}`,
    `    voiceSamples: ${config.voiceSamples}`,
    `    maxPromptChars: ${config.maxPromptChars}`,
    `    autoCompactEvery: ${config.autoCompactEvery}`,
    `    baseStabilityDays: ${config.baseStabilityDays}`,
    `    saveDelayMs: ${config.saveDelayMs}`,
    `    soul: ${yamlString(config.soul)}`,
    '    voice:',
  ];
  if (config.voice.length) {
    for (const voice of config.voice) lines.push(`      - ${yamlString(voice)}`);
  } else {
    lines[lines.length - 1] = '    voice: []';
  }
  lines.push(`    relationship: ${yamlString(config.relationship)}`, MANAGED_END);
  return lines.join('\n');
}

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineEnd(text, start) {
  const next = text.indexOf('\n', start);
  return next < 0 ? text.length : next + 1;
}

export function findFlavorBlock(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const managedStart = source.indexOf(MANAGED_START);
  if (managedStart >= 0) {
    const managedEnd = source.indexOf(MANAGED_END, managedStart);
    if (managedEnd < 0) throw new Error('managed flavor-memory block has no end marker');
    return {
      start: managedStart,
      end: managedEnd + MANAGED_END.length,
      text: source.slice(managedStart, managedEnd + MANAGED_END.length),
      managed: true,
    };
  }
  const match = FLAVOR_BLOCK_PATTERN.exec(source);
  if (!match) return null;
  const indent = match[1].length;
  const start = source.lastIndexOf('\n', match.index) + 1;
  const starts = lineStarts(source);
  let end = source.length;
  for (const candidate of starts) {
    if (candidate <= start) continue;
    const line = source.slice(candidate);
    const sibling = /^([ \t]*)-[ \t]+/.exec(line);
    if (sibling && sibling[1].length <= indent) {
      end = candidate;
      break;
    }
  }
  return { start, end, text: source.slice(start, end).trimEnd(), managed: false };
}

export function upsertPatch(content, config) {
  let source = String(content ?? '').replace(/\r\n?/g, '\n');
  const block = renderFlavorBlock(config);
  const existing = findFlavorBlock(source);
  if (existing) {
    source = `${source.slice(0, existing.start)}${block}${source.slice(existing.end)}`;
  } else {
    source = source.replace(/^\s*\[\]\s*$/m, '').trimEnd();
    source = source ? `${source}\n\n${block}` : block;
  }
  return `${source.trimEnd()}\n`;
}

export function extractFlavorConfig(patchText) {
  const block = findFlavorBlock(patchText);
  if (!block) return null;
  const text = block.text;
  const scalar = key => {
    const match = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, 'm').exec(text);
    if (!match) return null;
    const raw = match[1];
    if (raw.startsWith('"')) {
      try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
    return raw;
  };
  const voiceSection = /^\s+voice:[ \t]*(.*)$/m.exec(text);
  const voice = [];
  if (voiceSection && voiceSection[1].trim() && voiceSection[1].trim() !== '[]') {
    const inline = voiceSection[1].trim();
    if (inline.startsWith('[') && inline.endsWith(']')) {
      for (const item of inline.slice(1, -1).split(',')) {
        const raw = item.trim();
        if (raw) voice.push(raw.replace(/^["']|["']$/g, ''));
      }
    }
  } else if (voiceSection) {
    const after = text.slice(voiceSection.index + voiceSection[0].length);
    for (const line of after.split('\n')) {
      const item = /^\s+-\s+(.+?)\s*$/.exec(line);
      if (!item) {
        if (/^\s{2,4}[A-Za-z][\w-]*:\s*/.test(line)) break;
        continue;
      }
      const raw = item[1];
      try { voice.push(raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/^['"]|['"]$/g, '')); } catch { voice.push(raw); }
    }
  }
  return {
    characterId: scalar('characterId'),
    characterName: scalar('characterName'),
    dataFile: scalar('dataFile'),
    profilesFile: scalar('profilesFile'),
    soul: scalar('soul'),
    relationship: scalar('relationship'),
    voice,
    managed: block.managed,
  };
}

export const setupMeta = Object.freeze({ PLUGIN_ID, MANAGED_START, MANAGED_END });



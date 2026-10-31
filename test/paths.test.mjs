import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveProfilesFile, dshHomeDir } from '../src/character-store.mjs';
import { resolveDataFile } from '../src/dsh-plugin.mjs';
import { buildSetupConfig } from '../src/setup-config.mjs';

const CUSTOM = join('C:', 'tmp', 'custom-dsh');

function withDshHome(value, run) {
  const previous = process.env.DSH_HOME;
  if (value === null) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = value;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

test('custom DSH_HOME drives the default character profile path', () => {
  const file = withDshHome(CUSTOM, () => resolveProfilesFile());
  assert.equal(file, join(CUSTOM, 'flavor-memory', 'characters.json'));
});

test('custom DSH_HOME drives the default memory data path', () => {
  const file = withDshHome(CUSTOM, () => resolveDataFile());
  assert.equal(file, join(CUSTOM, 'flavor-memory', 'memory.json'));
});

test('without DSH_HOME the defaults stay under ~/.dsh', () => {
  const home = withDshHome(null, () => dshHomeDir());
  assert.match(home, /[\\/]\.dsh$/);
  const profiles = withDshHome(null, () => resolveProfilesFile());
  assert.match(profiles, /[\\/]\.dsh[\\/]flavor-memory[\\/]characters\.json$/);
});

test('explicit paths still override DSH_HOME', () => {
  const explicit = withDshHome(CUSTOM, () => resolveProfilesFile('~/custom/characters.json'));
  assert.match(explicit, /[\\/]custom[\\/]characters\.json$/);
  assert.ok(!explicit.includes('custom-dsh'));
});

test('setup config defaults follow DSH_HOME and keep explicit values', () => {
  const config = withDshHome(CUSTOM, () => buildSetupConfig({ characterId: 'ayu', characterName: '阿鱼', soul: '嘴硬心软' }));
  assert.equal(config.dataFile, `${CUSTOM.replace(/\\/g, '/')}/flavor-memory/ayu.json`);
  assert.equal(config.profilesFile, `${CUSTOM.replace(/\\/g, '/')}/flavor-memory/characters.json`);
  assert.equal(config.voiceSamples, 3);
  assert.equal(config.maxPromptChars, 4000);

  const pinned = withDshHome(CUSTOM, () => buildSetupConfig({
    characterId: 'ayu', characterName: '阿鱼', soul: '嘴硬心软', dataFile: 'D:/data/ayu.json',
  }));
  assert.equal(pinned.dataFile, 'D:/data/ayu.json');
});

test('voiceSamples is clamped to 0-3 and rendered into the managed block', () => {
  const config = buildSetupConfig({ characterId: 'ayu', characterName: '阿鱼', soul: '嘴硬心软', voiceSamples: 2 });
  assert.equal(config.voiceSamples, 2);
  assert.throws(() => buildSetupConfig({ characterId: 'ayu', characterName: '阿鱼', soul: '嘴硬心软', voiceSamples: 4 }), /voiceSamples/);
  const off = buildSetupConfig({ characterId: 'ayu', characterName: '阿鱼', soul: '嘴硬心软', voiceSamples: 0 });
  assert.equal(off.voiceSamples, 0);
  assert.throws(() => buildSetupConfig({ characterId: 'ayu', characterName: '阿鱼', soul: '嘴硬心软', maxPromptChars: 100 }), /maxPromptChars/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSetupConfig, ensureProfilePackage, upsertPatch, parseArgs, doctor,
} from '../src/setup.mjs';
import { extractFlavorConfig } from '../src/setup-config.mjs';

const sampleConfig = {
  characterId: 'ayu',
  characterName: '阿鱼',
  dataFile: '~/.dsh/flavor-memory/ayu.json',
  maxCards: 6,
  autoCompactEvery: 20,
  baseStabilityDays: 30,
  saveDelayMs: 40,
  soul: '嘴硬心软',
  voice: ['短句'],
  relationship: '刚开始',
};

test('setup config fills safe defaults and validates known fields', () => {
  const config = buildSetupConfig({ characterId: 'ayu', soul: '嘴硬心软' });
  assert.equal(config.characterId, 'ayu');
  assert.equal(config.dataFile, '~/.dsh/flavor-memory/ayu.json');
  assert.equal(config.maxCards, 6);
  assert.deepEqual(config.voice, []);
  assert.throws(() => buildSetupConfig({ characterId: '../bad', soul: 'x' }), /characterId/i);
});

test('setup persists and extracts a custom character store path', () => {
  const config = buildSetupConfig({
    characterId: 'ayu', soul: '嘴硬心软',
    profilesFile: '~/.dsh/flavor-memory/custom-characters.json',
  });
  assert.equal(config.profilesFile, '~/.dsh/flavor-memory/custom-characters.json');
  const patch = upsertPatch('[]', config);
  assert.match(patch, /profilesFile: "~\/\.dsh\/flavor-memory\/custom-characters\.json"/);
  assert.equal(extractFlavorConfig(patch).profilesFile, '~/.dsh/flavor-memory/custom-characters.json');
});

test('doctor reports an invalid custom character store before DSH starts', t => {
  const root = mkdtempSync(join(tmpdir(), 'flavor-doctor-profiles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileDir = join(root, 'profiles', 'test');
  mkdirSync(profileDir, { recursive: true });
  const packageJson = ensureProfilePackage({
    name: 'profile', dependencies: {}, dsh: { profile: { bundles: [] } },
  }, { dependencySpec: 'link:C:/plugin' }).packageJson;
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(packageJson), 'utf8');
  const profilesFile = join(root, 'characters.json');
  writeFileSync(profilesFile, '{broken', 'utf8');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), upsertPatch('[]', {
    ...sampleConfig,
    dataFile: join(root, 'memory.json'),
    profilesFile,
  }), 'utf8');
  const report = doctor({
    dshHome: root,
    profile: 'test',
    packageRoot: process.cwd(),
    dshExecutable: null,
    runDsh: false,
  });
  const check = report.checks.find(item => item.name === 'profiles-writable');
  assert.equal(check.ok, false);
  assert.match(check.detail, /characters\.json/);
});

test('setup patch replaces only the flavor-memory block and preserves other patches', () => {
  const initial = [
    '# user patches',
    '- id: other-plugin',
    '  config:',
    '    keep: true',
    '- id: flavor-memory',
    '  name: dsh-flavor-memory',
    '  config:',
    '    characterId: old',
    '    soul: old soul',
    '- id: another-plugin',
    '  disabled: true',
    '',
  ].join('\n');
  const once = upsertPatch(initial, sampleConfig);
  assert.match(once, /- id: other-plugin/);
  assert.match(once, /- id: another-plugin/);
  assert.match(once, /soul: "嘴硬心软"/);
  assert.doesNotMatch(once, /old soul/);
  const twice = upsertPatch(once, { ...sampleConfig, soul: '新的灵魂' });
  assert.equal((twice.match(/^- id: flavor-memory$/gm) || []).length, 1);
  assert.match(twice, /soul: "新的灵魂"/);
});

test('setup replaces an empty patch list instead of appending invalid YAML', () => {
  const result = upsertPatch('# profile patch\n[]\n', sampleConfig);
  assert.doesNotMatch(result, /^\[\]$/m);
  assert.match(result, /- id: flavor-memory/);
});

test('profile package receives the bundle and dependency without mutating input', () => {
  const input = {
    name: 'profile',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  };
  const result = ensureProfilePackage(input, { dependencySpec: 'link:C:/plugin' });
  assert.deepEqual(input.dependencies, {});
  assert.deepEqual(result.packageJson.dependencies, { 'dsh-flavor-memory': 'link:C:/plugin' });
  assert.deepEqual(result.packageJson.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', 'dsh-flavor-memory',
  ]);
  assert.equal(result.changed, true);
});

test('doctor checks a complete local profile without requiring a live DSH process', t => {
  const root = mkdtempSync(join(tmpdir(), 'flavor-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileDir = join(root, 'profiles', 'test');
  mkdirSync(profileDir, { recursive: true });
  const packageJson = ensureProfilePackage({
    name: 'profile', dependencies: {}, dsh: { profile: { bundles: [] } },
  }, { dependencySpec: 'link:C:/plugin' }).packageJson;
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(packageJson), 'utf8');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), upsertPatch('[]', sampleConfig), 'utf8');
  const report = doctor({
    dshHome: root,
    profile: 'test',
    packageRoot: process.cwd(),
    dshExecutable: null,
    runDsh: false,
  });
  assert.equal(report.errors.length, 0);
  assert.ok(report.checks.some(item => item.name === 'patch' && item.ok));
  assert.ok(report.checks.some(item => item.name === 'data-writable' && item.ok));
  assert.equal(report.checks.find(item => item.name === 'dsh-cli')?.ok, true);
});

test('doctor accepts a package-default config when the profile patch has no block', t => {
  const root = mkdtempSync(join(tmpdir(), 'flavor-doctor-default-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileDir = join(root, 'profiles', 'test');
  const packageDir = join(profileDir, 'node_modules', 'dsh-flavor-memory');
  mkdirSync(packageDir, { recursive: true });
  const packageJson = ensureProfilePackage({
    name: 'profile', dependencies: {}, dsh: { profile: { bundles: [] } },
  }, { dependencySpec: 'https://example.invalid/dsh-flavor-memory-0.4.3.tgz' }).packageJson;
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(packageJson), 'utf8');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]', 'utf8');
  writeFileSync(join(packageDir, 'cordis.patch.yml'), [
    '# dsh-flavor-memory bundle patch.',
    '- insert:',
    '    - id: flavor-memory',
    '      name: dsh-flavor-memory',
    '      config:',
    '        characterId: ayu',
    '        soul: "嘴硬心软"',
    '        dataFile: ~/.dsh/flavor-memory/memory.json',
    '        voice:',
    '          - 短句',
    '',
  ].join('\n'), 'utf8');
  const report = doctor({
    dshHome: root,
    profile: 'test',
    packageRoot: process.cwd(),
    dshExecutable: null,
    runDsh: false,
  });
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  const patch = report.checks.find(item => item.name === 'patch');
  assert.equal(patch.ok, true);
  assert.match(patch.detail, /package default/);
  assert.equal(report.checks.find(item => item.name === 'soul')?.ok, true);
  assert.deepEqual(report.config?.voice, ['短句']);
});

test('doctor forwards a custom DSH_HOME when invoking the DSH CLI', () => {
  const source = fs.readFileSync(new URL('../src/setup.mjs', import.meta.url), 'utf8');
  assert.match(source, /runDshCheck\(cli, profile, dshHome\)/);
  assert.match(source, /DSH_HOME: dshHome/);
});

test('argument parser accepts repeated voice values and mode aliases', () => {
  const args = parseArgs(['doctor', '--profile', 'test', '--voice', '短句', '--voice', '嘴硬', '--json']);
  assert.equal(args.mode, 'doctor');
  assert.equal(args.profile, 'test');
  assert.deepEqual(args.voice, ['短句', '嘴硬']);
  assert.equal(args.json, true);
});


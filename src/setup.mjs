#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildSetupConfig, extractFlavorConfig,
  setupMeta, upsertPatch,
} from './setup-config.mjs';

export { buildSetupConfig, upsertPatch, setupMeta } from './setup-config.mjs';


const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function expandHome(value) {
  const text = String(value ?? '');
  if (text === '~') return homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2));
  return text;
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== null) return fallback;
    throw new Error(`cannot read JSON ${path}: ${error.message}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function dshHomeDefault() {
  return expandHome(process.env.DSH_HOME || '~/.dsh');
}

export function ensureProfilePackage(packageJson, { dependencySpec } = {}) {
  const source = packageJson && typeof packageJson === 'object' ? packageJson : {};
  const next = JSON.parse(JSON.stringify(source));
  next.dependencies = { ...(next.dependencies || {}) };
  const previous = next.dependencies['dsh-flavor-memory'];
  if (dependencySpec) next.dependencies['dsh-flavor-memory'] = dependencySpec;
  next.dsh = { ...(next.dsh || {}) };
  next.dsh.profile = { ...(next.dsh.profile || {}) };
  const bundles = Array.isArray(next.dsh.profile.bundles) ? [...next.dsh.profile.bundles] : [];
  if (!bundles.includes('dsh-flavor-memory')) bundles.push('dsh-flavor-memory');
  next.dsh.profile.bundles = bundles;
  return {
    packageJson: next,
    changed: JSON.stringify(next) !== JSON.stringify(source),
    previousDependency: previous,
  };
}

function profilePath(dshHome, profile) {
  return join(dshHome, 'profiles', profile);
}

function readProfile(dshHome, profile) {
  const dir = profilePath(dshHome, profile);
  if (!existsSync(dir)) throw new Error(`DSH profile not found: ${dir}`);
  const packageFile = join(dir, 'package.json');
  const patchFile = join(dir, 'cordis.patch.yml');
  if (!existsSync(packageFile)) throw new Error(`profile package.json not found: ${packageFile}`);
  return {
    dir,
    packageFile,
    patchFile,
    packageJson: readJson(packageFile),
    patch: existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '',
  };
}

function checkDataFile(dataFile) {
  const resolved = isAbsolute(dataFile) ? resolve(dataFile) : expandHome(dataFile);
  const parent = dirname(resolved);
  try {
    mkdirSync(parent, { recursive: true });
    accessSync(parent, constants.W_OK);
    const existing = existsSync(resolved) ? statSync(resolved) : null;
    if (existing && existing.size > 0) JSON.parse(readFileSync(resolved, 'utf8'));
    return { path: resolved, ok: true, existed: Boolean(existing), bytes: existing?.size || 0 };
  } catch (error) {
    return { path: resolved, ok: false, error: error.message, existed: existsSync(resolved) };
  }
}

function locateDshCli(explicit) {
  if (explicit) return existsSync(expandHome(explicit)) ? expandHome(explicit) : null;
  if (process.env.DSH_CLI && existsSync(expandHome(process.env.DSH_CLI))) return expandHome(process.env.DSH_CLI);
  const local = join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  if (existsSync(local)) return local;
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['dsh'], { encoding: 'utf8' });
  if (probe.status === 0) return probe.stdout.split(/\r?\n/).map(item => item.trim()).find(Boolean) || null;
  return null;
}

function runDshCheck(dshExecutable, profile, dshHome) {
  if (!dshExecutable) return { ok: false, skipped: true, reason: 'DSH CLI not found; set DSH_CLI or pass --dsh-cli' };
  try {
    const command = process.platform === 'win32' ? `"${dshExecutable}"` : dshExecutable;
    const result = spawnSync(command, ['--profile', profile, '--dump-config'], {
      encoding: 'utf8', windowsHide: true, shell: true, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || '').trim().slice(0, 2000) };
    const output = result.stdout || '';
    return { ok: output.includes(`id: ${setupMeta.PLUGIN_ID}`), length: output.length, hasPlugin: output.includes(`id: ${setupMeta.PLUGIN_ID}`) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function doctor({ dshHome = dshHomeDefault(), profile = 'desktop', packageRoot = PACKAGE_ROOT, dshExecutable = null, runDsh = true } = {}) {
  const checks = [];
  const errors = [];
  const warnings = [];
  const add = (name, ok, detail, severity = 'error') => {
    const item = { name, ok: Boolean(ok), detail };
    checks.push(item);
    if (!item.ok) (severity === 'warning' ? warnings : errors).push(item);
    return item;
  };
  let pkg;
  try { pkg = readProfile(dshHome, profile); } catch (error) {
    add('profile', false, error.message);
    return { ok: false, profile, dshHome, checks, errors, warnings, config: null, dsh: null };
  }
  add('profile', true, pkg.dir);
  const dependency = pkg.packageJson?.dependencies?.['dsh-flavor-memory'];
  add('dependency', Boolean(dependency), dependency || 'dsh-flavor-memory is not in profile dependencies');
  const bundles = pkg.packageJson?.dsh?.profile?.bundles || [];
  add('bundle', bundles.includes('dsh-flavor-memory'), bundles.includes('dsh-flavor-memory') ? 'dsh-flavor-memory' : 'dsh-flavor-memory is not in dsh.profile.bundles');
  let config = null;
  try {
    config = extractFlavorConfig(pkg.patch);
    let source = 'profile';
    if (!config) {
      const bundledPatch = join(pkg.dir, 'node_modules', 'dsh-flavor-memory', 'cordis.patch.yml');
      if (existsSync(bundledPatch)) {
        config = extractFlavorConfig(readFileSync(bundledPatch, 'utf8'));
        if (config) source = 'package-default';
      }
    }
    if (config) {
      const label = config.characterId || '(no characterId)';
      add('patch', true, source === 'package-default' ? `${label} (package default; run setup to customize)` : label);
    } else {
      add('patch', false, 'flavor-memory config block not found in profile patch or installed package');
    }
  } catch (error) {
    add('patch', false, error.message);
  }
  if (config) {
    add('characterId', Boolean(config.characterId), config.characterId || 'characterId missing');
    add('soul', Boolean(config.soul && config.soul.trim()), config.soul ? 'configured' : 'soul missing');
    add('voice', Array.isArray(config.voice), `${config.voice?.length || 0} voice rule(s)`, 'warning');
    const data = checkDataFile(config.dataFile || join(dshHome, 'flavor-memory', `${config.characterId || 'default'}.json`));
    add('data-writable', data.ok, data.ok ? `${data.path}${data.existed ? ' (existing JSON is valid)' : ' (will be created)'}` : `${data.path}: ${data.error}`);
    if (data.ok && data.existed && data.bytes > 0) add('data-integrity', true, `${data.bytes} bytes`);
    const profiles = checkDataFile(config.profilesFile || join(dshHome, 'flavor-memory', 'characters.json'));
    add('profiles-writable', profiles.ok, profiles.ok ? `${profiles.path}${profiles.existed ? ' (existing JSON is valid)' : ' (will be created)'}` : `${profiles.path}: ${profiles.error}`);
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 22, `Node ${process.versions.node}`, 'warning');
  const cli = locateDshCli(dshExecutable);
  if (runDsh) {
    const result = runDshCheck(cli, profile, dshHome);
    add('dsh-load', result.ok, result.ok ? 'DSH composed the profile and included flavor-memory' : (result.reason || result.error || 'DSH load check failed'), result.skipped ? 'warning' : 'error');
  } else {
    add('dsh-cli', Boolean(cli), cli || 'DSH CLI not found; package checks still passed', 'warning');
  }
  return {
    ok: errors.length === 0,
    profile,
    dshHome,
    checks,
    errors,
    warnings,
    config,
    dsh: cli ? { executable: cli } : null,
    packageRoot,
  };
}

function applySetup({ dshHome, profile, config, dependencySpec, force = false }) {
  const pkg = readProfile(dshHome, profile);
  const dependency = pkg.packageJson?.dependencies?.['dsh-flavor-memory'];
  if (dependency && !force && !String(dependency).startsWith('link:')) {
    throw new Error(`profile already has dsh-flavor-memory dependency ${dependency}; use --force to relink`);
  }
  const nextPackage = ensureProfilePackage(pkg.packageJson, {
    dependencySpec: dependencySpec || dependency || `link:${PACKAGE_ROOT}`,
  }).packageJson;
  const existingConfig = extractFlavorConfig(pkg.patch);
  if (existingConfig && !force) {
    const same = existingConfig.characterId === config.characterId && existingConfig.soul === config.soul;
    if (!same) {
      throw new Error('flavor-memory is already configured with a different persona; pass --force to replace it');
    }
  }
  const nextPatch = upsertPatch(pkg.patch, config);
  writeJson(pkg.packageFile, nextPackage);
  writeFileSync(pkg.patchFile, nextPatch, 'utf8');
  return pkg;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { mode: 'setup', voice: [], force: false, json: false };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) args.mode = rest.shift();
  while (rest.length) {
    const token = rest.shift();
    if (token === '--profile') args.profile = rest.shift();
    else if (token === '--dsh-home') args.dshHome = rest.shift();
    else if (token === '--dsh-cli') args.dshCli = rest.shift();
    else if (token === '--character-id') args.characterId = rest.shift();
    else if (token === '--character-name') args.characterName = rest.shift();
    else if (token === '--soul') args.soul = rest.shift();
    else if (token === '--relationship') args.relationship = rest.shift();
    else if (token === '--data-file') args.dataFile = rest.shift();
    else if (token === '--profiles-file') args.profilesFile = rest.shift();
    else if (token === '--voice') args.voice.push(rest.shift());
    else if (token === '--character-file') args.characterFile = rest.shift();
    else if (token === '--max-cards') args.maxCards = rest.shift();
    else if (token === '--voice-samples') args.voiceSamples = rest.shift();
    else if (token === '--max-prompt-chars') args.maxPromptChars = rest.shift();
    else if (token === '--auto-compact-every') args.autoCompactEvery = rest.shift();
    else if (token === '--base-stability-days') args.baseStabilityDays = rest.shift();
    else if (token === '--force') args.force = true;
    else if (token === '--json') args.json = true;
    else if (token === '--check') args.mode = 'doctor';
    else if (token === '--help' || token === '-h') args.mode = 'help';
    else throw new Error(`unknown option: ${token}`);
  }
  return args;
}

function configFromArgs(args) {
  let source = {};
  if (args.characterFile) {
    const file = expandHome(args.characterFile);
    source = readJson(file);
  }
  return buildSetupConfig({
    ...source,
    characterId: args.characterId ?? source.characterId ?? source.id,
    characterName: args.characterName ?? source.characterName ?? source.name,
    soul: args.soul ?? source.soul,
    voice: args.voice?.length ? args.voice : source.voice,
    relationship: args.relationship ?? source.relationship,
    dataFile: args.dataFile ?? source.dataFile,
    profilesFile: args.profilesFile ?? source.profilesFile,
    maxCards: args.maxCards ?? source.maxCards,
    voiceSamples: args.voiceSamples ?? source.voiceSamples,
    maxPromptChars: args.maxPromptChars ?? source.maxPromptChars,
    autoCompactEvery: args.autoCompactEvery ?? source.autoCompactEvery,
    baseStabilityDays: args.baseStabilityDays ?? source.baseStabilityDays,
    saveDelayMs: source.saveDelayMs,
  });
}

function textReport(report) {
  const lines = [`flavor-memory 自检：${report.ok ? '通过' : '未通过'}`, `profile：${report.profile}`, `DSH_HOME：${report.dshHome}`, ''];
  for (const check of report.checks) lines.push(`${check.ok ? '[通过]' : '[失败]'} ${check.name}：${check.detail}`);
  if (report.warnings.length) lines.push('', '提醒：', ...report.warnings.map(item => `- ${item.name}: ${item.detail}`));
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  if (args.mode === 'help') {
    console.log(`用法：
  npm run setup -- --profile flavor-test --character-file examples/ayu.character.json
  npm run setup -- --profile flavor-test --character-id ayu --character-name 阿鱼 --soul "嘴硬心软"
  npm run doctor -- --profile flavor-test
选项：--force 覆盖已有同 ID 人格；--data-file；--profiles-file；--voice；--max-cards；--voice-samples（0-3）；--max-prompt-chars；--auto-compact-every；--dsh-cli；--json`);
    return;
  }
  const dshHome = expandHome(args.dshHome || dshHomeDefault());
  if (args.mode === 'doctor') {
    const report = doctor({ dshHome, profile: args.profile || 'desktop', dshExecutable: args.dshCli });
    console.log(args.json ? JSON.stringify(report, null, 2) : textReport(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (args.mode !== 'setup') throw new Error(`unknown mode: ${args.mode}`);
  const profile = args.profile || process.env.DSH_PROFILE || 'desktop';
  let config;
  try {
    config = configFromArgs(args);
  } catch (error) {
    if (!String(error.message).endsWith('soul is required')) throw error;
    throw new Error('缺少人格配置：请用 --character-file 指向角色 JSON，或同时传 --character-id、--character-name、--soul');
  }
  const pkg = applySetup({
    dshHome, profile, config,
    dependencySpec: args.characterFile ? undefined : `link:${PACKAGE_ROOT}`,
    force: args.force,
  });
  const report = doctor({ dshHome, profile, dshExecutable: args.dshCli });
  const result = { ok: report.ok, profile, configFile: pkg.patchFile, dataFile: config.dataFile, profilesFile: config.profilesFile, dataReport: publishableDoctor(report) };
  console.log(args.json ? JSON.stringify(result, null, 2) : `已写入 ${pkg.patchFile}\n人格：${config.characterName}（${config.characterId}）\n数据：${config.dataFile}\n\n${textReport(report)}`);
  if (!report.ok) process.exitCode = 1;
}

function publishableDoctor(report) {
  return { ok: report.ok, checks: report.checks, warnings: report.warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`flavor-memory setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}






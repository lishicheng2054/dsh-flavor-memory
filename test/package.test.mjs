import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as plugin from '../src/dsh-plugin.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('package declares a loadable DSH bundle, client and real main entry', () => {
  assert.equal(pkg.name, 'dsh-flavor-memory');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'src/dsh-plugin.mjs');
  assert.equal(existsSync(join(root, pkg.main)), true);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(existsSync(join(root, 'cordis.patch.yml')), true);
  assert.match(pkg.engines.dsh, /0\.2\./);
  assert.equal(plugin.name, 'flavor-memory');
  assert.equal(pkg.exports['./client'], './src/client.js');
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-slots']);
  assert.equal(pkg.dsh.client.platform, 'web');
});

test('bundle patch inserts the plugin with a sample persona and local data path', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: flavor-memory/);
  assert.match(patch, /name: dsh-flavor-memory/);
  assert.match(patch, /dataFile: ~\/\.dsh\/flavor-memory\/memory\.json/);
  assert.match(patch, /soul:/);
});

test('published package files include studio but exclude local state', () => {
  for (const included of ['src', 'ui', 'cordis.patch.yml', 'examples']) assert.ok(pkg.files.includes(included), included);
  for (const blocked of ['.refs', 'node_modules', '.data', 'memory.json', 'characters.json']) assert.equal(pkg.files.includes(blocked), false, blocked);
});

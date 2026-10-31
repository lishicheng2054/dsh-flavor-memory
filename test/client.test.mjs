import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('DSH client entry registers a real settings section factory', () => {
  assert.equal(pkg.exports['./client'], './src/client.js');
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-slots']);
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.files.includes('ui'));
  let registration;
  const registrations = [];
  const context = {
    window: { __ModuleLoader__: { load(info) { registration = info; } } },
    document: { getElementById() { return null; }, head: { appendChild() {} }, createElement() { return {}; } },
    console, setTimeout, clearTimeout,
  };
  vm.runInNewContext(readFileSync(join(root, 'src/client.js'), 'utf8'), context);
  assert.equal(registration.id, 'dsh-flavor-memory');
  const module = registration.factory(name => {
    if (name === 'react') return { useEffect() {}, useRef() {}, useState() {} };
    if (name === 'react/jsx-runtime') return { jsx() {}, jsxs() {} };
    throw new Error('unexpected module ' + name);
  });
  assert.equal(module.name, 'flavor-memory');
  assert.ok(module.inject.includes('slots'));
  const ctx = {
    slots: {
      inject(slot, generator) {
        assert.equal(slot, 'settings.section');
        const iterator = generator();
        while (!iterator.next().done) {}
      },
      register(meta, component) { registrations.push({ meta, component }); return () => {}; },
    },
  };
  module.apply(ctx);
  assert.equal(registrations[0].meta.id, 'flavor-memory-config');
  assert.equal(registrations[0].meta.label(), '角色记忆');
  assert.equal(typeof registrations[0].component, 'function');
  const clientSource = readFileSync(join(root, 'src/client.js'), 'utf8');
  assert.match(clientSource, /\.fm-setting-frame \{ color-scheme:light/);
  assert.match(clientSource, /background:#0f7a68/);
  assert.match(clientSource, /background:#f5f7f6/);
  assert.doesNotMatch(clientSource, /background:#0b0d10/);
  assert.doesNotMatch(clientSource, /color-scheme:dark/);
});

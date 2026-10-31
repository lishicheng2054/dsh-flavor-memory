import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileRuntime, profilePromptFor } from '../src/profile-runtime.mjs';

test('profile runtime seeds a selected character and resolves query-aware prompt', t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = createProfileRuntime({
    profilesFile: join(dir, 'characters.json'), characterId: 'ayu',
    seed: { id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['短句'] },
  });
  assert.equal(runtime.selected.name, '阿鱼');
  const view = profilePromptFor(runtime.profiles, 'ayu', '你好');
  assert.match(view.prompt, /嘴硬心软/);
  assert.equal(view.profile.id, 'ayu');
});

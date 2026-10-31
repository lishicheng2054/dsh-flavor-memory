import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/gateway.mjs';

test('a restart preserves raw messages, scene quotes and relationship state', t => {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-reload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'memory.json');
  const first = createStore({ root: file, saveDelayMs: 0 });
  first.upsertCharacter({
    id: 'ayu', name: '阿鱼', soul: '嘴硬心软', voice: ['叫她老板'], relationship: '互相试探',
  });
  first.remember({ characterId: 'ayu', id: 'u1', role: 'user', text: '周五给我留票。' });
  first.remember({ characterId: 'ayu', id: 'a1', role: 'assistant', text: '行，老板。' });
  first.commitScene('ayu', {
    throughSeq: 2,
    card: { event: ['约好留票'], relation: '答应帮忙', quoteIds: ['u1', 'a1'] },
  });
  first.close();

  const restored = createStore({ root: file, saveDelayMs: 0 });
  t.after(() => restored.close());
  const memory = restored.exportAll().characters[0].memory;
  assert.deepEqual(memory.entries.map(item => item.text), ['周五给我留票。', '行，老板。']);
  assert.deepEqual(memory.cards[0].quote.map(item => item.text), ['周五给我留票。', '行，老板。']);
  assert.equal(restored.bookFor('ayu').currentRelationship(), '答应帮忙');
});


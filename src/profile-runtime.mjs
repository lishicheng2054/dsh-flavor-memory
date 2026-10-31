import { createProfileStore, legacyToProfile } from './character-store.mjs';

export function createProfileRuntime({ profilesFile = undefined, seed = null, characterId = 'default' } = {}) {
  const profiles = createProfileStore({ file: profilesFile, seed: seed ? legacyToProfile(seed) : null });
  const selected = profiles.find(characterId) || profiles.list()[0] || null;
  return { profiles, selected };
}

export function profilePromptFor(profiles, characterId, query, options = {}) {
  if (!profiles || !characterId) return { prompt: '', profile: null, lore: [], examples: [] };
  return profiles.buildPrompt(characterId, query, options);
}

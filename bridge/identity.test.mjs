import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProfiles, describeProfile, profileMismatch, readIdentity, identityNote,
} from './identity.mjs';

const localState = (cache) => ({ profile: { info_cache: cache } });

// The shape this machine actually has, read off its Local State.
const REAL = localState({
  Default: { name: 'Personal', active_time: 1789030485.5 },
  'Profile 1': { name: 'Work', active_time: 1788935403.3 },
});

test('profiles come back most recently used first', () => {
  assert.deepEqual(parseProfiles(REAL).map((p) => p.name), ['Personal', 'Work']);
});

test('a profile with no name falls back to its directory', () => {
  assert.equal(parseProfiles(localState({ 'Profile 7': {} }))[0].name, 'Profile 7');
});

test('a Local State with nothing to say reads as empty, not as a guess', () => {
  for (const junk of [null, {}, { profile: {} }, { profile: { info_cache: 'no' } }]) {
    assert.deepEqual(parseProfiles(junk), []);
  }
});

test('the description names the directory too, since two profiles can share a name', () => {
  assert.equal(describeProfile(parseProfiles(REAL), 'Profile 1'), 'Work (Profile 1)');
});

test('an account is included when sync has recorded one', () => {
  const p = parseProfiles(localState({ Default: { name: 'Personal', user_name: 'a@b.test' } }));
  assert.equal(describeProfile(p, 'Default'), 'Personal (Default), signed in as a@b.test');
});

test('a profile that is not there described as nothing, never as another one', () => {
  assert.equal(describeProfile(parseProfiles(REAL), 'Profile 9'), null);
});

// --- the mismatch this exists to catch --------------------------------------

test('driving Work while the human is in Personal is reported', () => {
  // The real arrangement here: the launcher pins Profile 1, the human uses
  // Default, and nothing said so until it was found by hand.
  const m = profileMismatch(parseProfiles(REAL), 'Profile 1');
  assert.equal(m.driving, 'Work (Profile 1)');
  assert.equal(m.humanLikelyIn, 'Personal (Default)');
});

test('driving the profile the human is in is not a mismatch', () => {
  assert.equal(profileMismatch(parseProfiles(REAL), 'Default'), null);
});

test('a single-profile browser can never mismatch', () => {
  const one = parseProfiles(localState({ Default: { name: 'Person', active_time: 1 } }));
  assert.equal(profileMismatch(one, 'Default'), null);
});

// --- reading it off disk -----------------------------------------------------

const fakeRead = (json) => async () => JSON.stringify(json);

test('identity is read from the profile the agent is pinned to', async () => {
  const got = await readIdentity({ userDataDir: '/ud', profileDir: 'Profile 1', read: fakeRead(REAL) });
  assert.equal(got.description, 'Work (Profile 1)');
  assert.equal(got.mismatch.humanLikelyIn, 'Personal (Default)');
});

test('no user-data-dir means not known, which is not the same as no mismatch', async () => {
  // The normal case for a browser driven through its own process, Aside on
  // macOS being one. A missing answer must never read as a wrong answer.
  assert.equal(await readIdentity({ profileDir: 'Default' }), null);
  assert.equal(await readIdentity({ userDataDir: '/ud' }), null);
});

test('an unreadable Local State reads as not known', async () => {
  const boom = async () => { throw new Error('ENOENT'); };
  assert.equal(await readIdentity({ userDataDir: '/ud', profileDir: 'Default', read: boom }), null);
});

test('malformed JSON reads as not known rather than throwing', async () => {
  const bad = async () => '{not json';
  assert.equal(await readIdentity({ userDataDir: '/ud', profileDir: 'Default', read: bad }), null);
});

// --- what the agent is told --------------------------------------------------

test('not knowing says nothing at all', () => {
  assert.equal(identityNote(null), '');
});

test('the note names the profile, and the mismatch when there is one', async () => {
  const got = await readIdentity({ userDataDir: '/ud', profileDir: 'Profile 1', read: fakeRead(REAL) });
  const note = identityNote(got);
  assert.match(note, /Work \(Profile 1\)/);
  assert.match(note, /Personal \(Default\)/);
  assert.match(note, /say which account you were looking at/);
});

test('matching profiles get the fact without the caution', async () => {
  const got = await readIdentity({ userDataDir: '/ud', profileDir: 'Default', read: fakeRead(REAL) });
  const note = identityNote(got);
  assert.match(note, /Personal \(Default\)/);
  assert.equal(/not the profile he is using/.test(note), false);
});

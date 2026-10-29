import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asideDigest } from './aside-memory.mjs';

function folder() {
  const d = mkdtempSync(join(tmpdir(), 'aside-mem-'));
  mkdirSync(join(d, 'companies'));
  mkdirSync(join(d, 'episodic'));
  writeFileSync(join(d, 'MEMORY.md'), 'operating rules');
  writeFileSync(join(d, 'USER.md'), 'a profile');
  writeFileSync(join(d, 'companies', 'acme.md'), 'x');
  writeFileSync(join(d, 'episodic', '2026-10-29.md'), 'a day');
  writeFileSync(join(d, 'notes.txt'), 'not markdown');
  return d;
}

test('the briefing files come through whole, and pages are listed by path', async () => {
  const out = await asideDigest(folder());
  assert.match(out, /--- MEMORY\.md ---\noperating rules/);
  assert.match(out, /--- USER\.md ---\na profile/);
  assert.match(out, /companies\/acme\.md/);
});

test('dated logs and non-markdown files are left out of the list', async () => {
  const out = await asideDigest(folder());
  assert.doesNotMatch(out, /2026-10-29/);
  assert.doesNotMatch(out, /notes\.txt/);
});

test('a long briefing file is cut and says so', async () => {
  const d = folder();
  writeFileSync(join(d, 'MEMORY.md'), 'a'.repeat(50));
  const out = await asideDigest(d, 10);
  assert.match(out, /a{10}\n\[cut, 50 characters in all\]/);
});

test('no folder means no digest, not an error', async () => {
  assert.equal(await asideDigest(join(tmpdir(), 'aside-mem-missing-dir')), null);
});

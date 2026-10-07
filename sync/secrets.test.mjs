import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, findSecrets, addedLines } from './secrets.mjs';

// Built at runtime so this file never holds a token-shaped string itself.
const fake = (prefix, n, ch = 'a') => prefix + ch.repeat(n);

test('each pattern fires on a token of its shape', () => {
  const cases = {
    'slack-token': fake('xoxb-', 30),
    'slack-app-token': fake('xapp-1-', 30),
    'anthropic-key': fake('sk-ant-', 40),
    'openai-key': fake('sk-proj-', 40),
    'github-token': fake('ghp_', 36),
    'gitlab-token': fake('glpat-', 20),
    'linear-key': fake('lin_api_', 40),
    'shopify-token': fake('shpat_', 32, 'f'),
    'aws-key': 'AKIA' + 'A'.repeat(16),
    'google-api-key': fake('AIza', 35),
    'private-key': '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----',
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.deepEqual(scanText(`x ${value} y`), [name], name);
  }
});

test('ordinary notes do not fire', () => {
  assert.deepEqual(scanText('Slack bot tokens start with xoxb- and the app token with xapp-.'), []);
  assert.deepEqual(scanText('sk-ant is the prefix; never paste the key.'), []);
});

const diff = (file, added, removed = []) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1 +1 @@',
  ...removed.map((l) => `-${l}`),
  ...added.map((l) => `+${l}`),
  '',
].join('\n');

test('reports file and pattern, never the value', () => {
  const token = fake('xoxb-', 30);
  const hits = findSecrets(diff('sites/app.slack.com.md', [`token: ${token}`]));
  assert.deepEqual(hits, [{ file: 'sites/app.slack.com.md', pattern: 'slack-token' }]);
  assert.ok(!JSON.stringify(hits).includes(token));
});

test('removed lines are not scanned', () => {
  assert.deepEqual(findSecrets(diff('a.md', ['clean'], [fake('xoxb-', 30)])), []);
});

test('paths with spaces and non-ASCII survive', () => {
  const m = addedLines(diff('projects/café notes.md', ['hi']));
  assert.deepEqual([...m.keys()], ['projects/café notes.md']);
});

test('a content line starting with ++ is content, not a header', () => {
  const d = diff('a.md', ['++ not a header', fake('ghp_', 36)]);
  assert.deepEqual(findSecrets(d), [{ file: 'a.md', pattern: 'github-token' }]);
});

test('common token shapes beyond the first list', () => {
  const cases = {
    'stripe-key': fake('sk_live_', 24),
    'slack-webhook': `https://hooks.slack.com/services/T${'0'.repeat(8)}/B${'0'.repeat(8)}/${'a'.repeat(24)}`,
    jwt: `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`,
    'npm-token': fake('npm_', 36),
    'telegram-bot-token': `123456789:${'A'.repeat(35)}`,
    'assigned-secret': `api_key = "${'a1'.repeat(10)}"`,
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.ok(scanText(`x ${value} y`).includes(name), name);
  }
});

test('words after a secret-ish label are not a secret', () => {
  assert.deepEqual(scanText('token: never read it yourself, confidential always'), []);
  assert.deepEqual(scanText('password: ask Proton Pass, do not store passwords here'), []);
});

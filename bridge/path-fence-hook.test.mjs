import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, loadConfig, rewrite } from './path-fence-hook.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'fence-')));
const a1c = join(base, 'A1C');
const ws = join(a1c, 'agent', 'ws');
const hm = join(a1c, 'agent', 'hm');
for (const d of [ws, join(hm, 'memory', 'companies'), join(hm, 'memory', 'users'), join(a1c, 'infra'), join(base, 'private')]) {
  mkdirSync(d, { recursive: true });
}
writeFileSync(join(hm, 'memory', 'companies', 'a1c.md'), 'ok');
writeFileSync(join(hm, 'memory', 'users', 'me.md'), 'personal');
writeFileSync(join(base, 'private', 'diary.md'), 'personal');
writeFileSync(join(a1c, 'app.env'), 'x');
writeFileSync(join(a1c, '.env'), 'x');
symlinkSync(join(base, 'private'), join(ws, 'escape'));

const cfg = loadConfig(JSON.stringify({
  readRoots: [a1c],
  writeRoots: [ws],
  deny: [join(a1c, 'infra'), hm],
  allowInsideDeny: [join(hm, 'memory', 'companies')],
  readOnly: [join(ws, 'CLAUDE.md')],
  denyNames: ['^\\.env(\\..*)?$'],
  denyTools: ['Bash'],
  grepExclude: ['!**/.env*'],
}));
const ev = (tool_name, tool_input) => ({ tool_name, tool_input, cwd: ws });

test('reads inside the root pass, outside are blocked', () => {
  assert.equal(check(ev('Read', { file_path: join(a1c, 'app.env') }), cfg), null);
  assert.match(check(ev('Read', { file_path: join(base, 'private', 'diary.md') }), cfg), /outside/);
  assert.match(check(ev('Read', { file_path: '/etc/hosts' }), cfg), /outside/);
});

test('a symlink cannot carry a read out of the root', () => {
  assert.match(check(ev('Read', { file_path: join(ws, 'escape', 'diary.md') }), cfg), /outside/);
});

test('denied folders are blocked, exceptions read but never write', () => {
  assert.match(check(ev('Read', { file_path: join(hm, 'memory', 'users', 'me.md') }), cfg), /outside what this agent may access/);
  assert.match(check(ev('Read', { file_path: join(a1c, 'infra', 'x') }), cfg), /outside what this agent may access/);
  assert.equal(check(ev('Read', { file_path: join(hm, 'memory', 'companies', 'a1c.md') }), cfg), null);
  assert.match(check(ev('Write', { file_path: join(hm, 'memory', 'companies', 'a1c.md') }), cfg), /outside/);
});

test('case tricks do not slip past a deny', () => {
  assert.match(check(ev('Read', { file_path: join(a1c, 'INFRA', 'x') }), cfg), /outside/);
});

test('secrets file names are blocked', () => {
  assert.match(check(ev('Read', { file_path: join(a1c, '.env') }), cfg), /secrets/);
});

test('writes only inside the write root, and not to read-only files', () => {
  assert.equal(check(ev('Write', { file_path: join(ws, 'notes.md') }), cfg), null);
  assert.match(check(ev('Write', { file_path: join(a1c, 'other.md') }), cfg), /outside/);
  assert.match(check(ev('Write', { file_path: join(ws, 'CLAUDE.md') }), cfg), /read-only/);
});

test('a search may not start above a denied folder', () => {
  assert.match(check(ev('Grep', { pattern: 'x', path: a1c }), cfg), /Narrow/);
  assert.match(check(ev('Grep', { pattern: 'x', path: join(a1c, 'agent') }), cfg), /Narrow/);
  assert.equal(check(ev('Grep', { pattern: 'x', path: ws }), cfg), null);
  assert.equal(check(ev('Grep', { pattern: 'x' }), cfg), null);
});

test('an absolute or climbing Glob pattern is checked like a path', () => {
  assert.match(check(ev('Glob', { pattern: `${join(base, 'private')}/**` }), cfg), /outside/);
  assert.match(check(ev('Glob', { pattern: '../../../../private/*' }), cfg), /outside/);
  assert.equal(check(ev('Glob', { pattern: '**/*.md' }), cfg), null);
});

test('Bash is blocked outright, other tools are left alone', () => {
  assert.match(check(ev('Bash', { command: 'ls' }), cfg), /not available/);
  assert.equal(check(ev('WebFetch', { url: 'https://example.com' }), cfg), null);
});

test('every Grep gains the exclusion globs, after the agent\'s own glob', () => {
  const plain = rewrite(ev('Grep', { pattern: 'x', path: ws }), cfg).hookSpecificOutput.updatedInput;
  assert.equal(plain.glob, '!**/.env*');
  const own = rewrite(ev('Grep', { pattern: 'x', glob: '*.ts' }), cfg).hookSpecificOutput.updatedInput;
  assert.equal(own.glob, '*.ts !**/.env*');
  assert.equal(rewrite(ev('Read', { file_path: 'x' }), cfg), null);
});

// A teammate's turn: the bridge sets AGENT_REQUESTER_ROLE=team. Unset is the operator.
mkdirSync(join(hm, 'memory', 'routines'), { recursive: true });
writeFileSync(join(hm, 'memory', 'routines', 'bixgrow-payouts.md'), 'bank details');
writeFileSync(join(hm, 'memory', 'routines', 'invoice.md'), 'fine');
const teamCfg = loadConfig(JSON.stringify({
  readRoots: [a1c],
  writeRoots: [ws],
  deny: [hm],
  allowInsideDeny: [join(hm, 'memory', 'routines')],
  grepExclude: ['!**/.env*'],
  teamDeny: [join(hm, 'memory', 'routines', 'bixgrow-payouts.md')],
  teamGrepExclude: ['!**/bixgrow-payouts.md'],
}));
const asRole = (role, fn) => {
  const prev = process.env.AGENT_REQUESTER_ROLE;
  if (role === undefined) delete process.env.AGENT_REQUESTER_ROLE;
  else process.env.AGENT_REQUESTER_ROLE = role;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AGENT_REQUESTER_ROLE;
    else process.env.AGENT_REQUESTER_ROLE = prev;
  }
};

test('teammate turns cannot read the team-denied files; the operator can', () => {
  const read = ev('Read', { file_path: join(hm, 'memory', 'routines', 'bixgrow-payouts.md') });
  assert.equal(asRole(undefined, () => check(read, teamCfg)), null);
  assert.equal(asRole('operator', () => check(read, teamCfg)), null);
  assert.match(asRole('team', () => check(read, teamCfg)), /not available for requests from teammates/);
});

test('teammate turns still read the files that are not team-denied', () => {
  const read = ev('Read', { file_path: join(hm, 'memory', 'routines', 'invoice.md') });
  assert.equal(asRole('team', () => check(read, teamCfg)), null);
});

test('a symlink does not carry a teammate past the team deny', () => {
  symlinkSync(join(hm, 'memory', 'routines', 'bixgrow-payouts.md'), join(ws, 'shortcut.md'));
  const read = ev('Read', { file_path: join(ws, 'shortcut.md') });
  assert.match(asRole('team', () => check(read, teamCfg)), /teammates/);
});

test('teammate Greps also exclude the team-denied files, the operator Grep does not', () => {
  const grep = ev('Grep', { pattern: 'bank', path: join(hm, 'memory', 'routines'), glob: '*.md' });
  const op = asRole(undefined, () => rewrite(grep, teamCfg));
  const team = asRole('team', () => rewrite(grep, teamCfg));
  assert.equal(op.hookSpecificOutput.updatedInput.glob, '*.md !**/.env*');
  assert.equal(team.hookSpecificOutput.updatedInput.glob, '*.md !**/.env* !**/bixgrow-payouts.md');
});

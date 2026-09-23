import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgs, runAgent } from './runner.mjs';

const base = { prompt: 'hi', sessionId: 'abc', isNew: true };

test('the run streams, so the supervisor can mirror it', () => {
  const args = buildArgs(base);
  // --verbose is not decoration: the CLI refuses stream-json with --print
  // without it, and every run would die on startup.
  assert.equal(args.join(' ').includes('--output-format stream-json --verbose'), true);
});

test('a new run with an id assigns it', () => {
  assert.deepEqual(buildArgs(base).slice(5, 7), ['--session-id', 'abc']);
});

test('a continuing run resumes it', () => {
  assert.deepEqual(buildArgs({ ...base, isNew: false }).slice(5, 7), ['--resume', 'abc']);
});

test('a new run with no id passes no flag rather than a null argv entry', () => {
  // Routines have no thread to derive an id from. spawn throws on a null
  // argument, which would kill the run before the CLI ever started.
  const args = buildArgs({ ...base, sessionId: null });
  assert.equal(args.includes('--session-id'), false);
  assert.equal(args.every((a) => typeof a === 'string'), true);
});

// --- the mirrored run ------------------------------------------------------

/** A fake `claude` that emits the given stdout chunks, then exits. */
function fakeSpawn(chunks, code = 0) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      for (const c of chunks) child.stdout.emit('data', c);
      child.emit('close', code);
    });
    return child;
  };
}

const line = (o) => `${JSON.stringify(o)}\n`;
const RESULT = { type: 'result', subtype: 'success', result: 'done', session_id: 'abc' };

test('a run writes its own transcript and reports the range it wrote', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'runner-')), 'abc.jsonl');
  const res = await runAgent({
    ...base,
    transcriptPath: path,
    spawnFn: fakeSpawn([
      line({ type: 'system', subtype: 'init', model: 'sonnet' }),
      line({ type: 'system', subtype: 'hook_started' }),
      line({ type: 'assistant', message: { content: 'working' } }),
      line(RESULT),
    ]),
  });

  assert.equal(res.ok, true);
  assert.equal(res.text, 'done');

  const written = await readFile(path, 'utf8');
  assert.equal(written.includes('hook_started'), false, 'hook noise is dropped');
  assert.equal(written.includes('"subtype":"init"'), true);
  assert.equal(written.includes('working'), true);
  assert.equal(res.range.offset, 0);
  assert.equal(res.range.bytes, Buffer.byteLength(written));
});

test('an object split across two chunks still reaches the transcript', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'runner-')), 'abc.jsonl');
  const whole = line({ type: 'assistant', message: { content: 'split' } });
  const res = await runAgent({
    ...base,
    transcriptPath: path,
    spawnFn: fakeSpawn([whole.slice(0, 14), whole.slice(14), line(RESULT)]),
  });

  assert.equal(res.ok, true);
  assert.equal((await readFile(path, 'utf8')).includes('split'), true);
});

test('a run killed before its result keeps what it wrote and reports failure', async () => {
  // What !stop looks like: real output, then a half line and a non-zero exit.
  const path = join(await mkdtemp(join(tmpdir(), 'runner-')), 'abc.jsonl');
  const res = await runAgent({
    ...base,
    transcriptPath: path,
    spawnFn: fakeSpawn([
      line({ type: 'assistant', message: { content: 'partway' } }),
      '{"type":"resu',
    ], 143),
  });

  assert.equal(res.ok, false);
  const written = await readFile(path, 'utf8');
  assert.equal(written.includes('partway'), true);
  assert.equal(written.includes('resu'), false, 'the half line is never written');
  assert.equal(res.range.bytes, Buffer.byteLength(written));
});

test('without a transcript path the run still parses its result', async () => {
  const res = await runAgent({ ...base, spawnFn: fakeSpawn([line(RESULT)]) });
  assert.equal(res.ok, true);
  assert.equal(res.text, 'done');
});

test('the transcript records what was asked, which the stream never echoes', async () => {
  // Its `user` events are tool results, not the prompt. Without this every
  // mirrored session listed as "(no task recorded)" and lost its permalink.
  const path = join(await mkdtemp(join(tmpdir(), 'runner-')), 'abc.jsonl');
  await runAgent({
    ...base,
    prompt: 'check the affiliate queue',
    transcriptPath: path,
    spawnFn: fakeSpawn([line(RESULT)]),
  });
  const first = JSON.parse((await readFile(path, 'utf8')).split('\n')[0]);
  assert.equal(first.type, 'user');
  assert.equal(first.message.content, 'check the affiliate queue');
});

test('a run that dies instantly still records what it was asked', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'runner-')), 'abc.jsonl');
  const res = await runAgent({
    ...base, prompt: 'the ask', transcriptPath: path, spawnFn: fakeSpawn([], 1),
  });
  assert.equal(res.ok, false);
  assert.equal((await readFile(path, 'utf8')).includes('the ask'), true);
});

test('both spellings of the script tool are disallowed on every run', () => {
  // Whatever the caller passes, the module list applies. A machine on the old
  // config name must not be the one that loses the guard.
  const args = buildArgs({ prompt: 'x', sessionId: 'a', isNew: true });
  const denied = args[args.indexOf('--disallowedTools') + 1];
  assert.ok(denied.includes('mcp__brave__browser_run_code_unsafe'));
  assert.ok(denied.includes('mcp__browser__browser_run_code_unsafe'));
  assert.ok(denied.includes('Task'));
});

test('every run carries the fence hook', () => {
  // Page content, documents and other people's messages arrive fenced as
  // data. Applied in buildArgs so no caller can leave it off.
  const args = buildArgs({ prompt: 'x', sessionId: 'a', isNew: true });
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  const hook = settings.hooks.PostToolUse[0];
  assert.equal(hook.matcher, 'mcp__.*');
  assert.match(hook.hooks[0].command, /fence-hook\.mjs"$/);
});

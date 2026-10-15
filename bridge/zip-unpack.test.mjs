import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdtemp, readFile, readdir, stat, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unpackZip, describeUnpack, entrySegments, looksExecutable, LIMITS } from './zip-unpack.mjs';

/**
 * A zip in memory. `files` is [name, content, { store, flags, symlink, host, dir }].
 * Entries are written as a Mac would write them: host 3 (Unix), mode in the top of the external attributes.
 */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content, opts = {}] of files) {
    const data = Buffer.from(content);
    const comp = opts.store || opts.dir ? data : deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(opts.flags || 0, 6);
    lh.writeUInt16LE(opts.store || opts.dir ? 0 : 8, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(((opts.host ?? 3) << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(opts.flags || 0, 8);
    ch.writeUInt16LE(opts.store || opts.dir ? 0 : 8, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    const mode = opts.symlink ? 0o120777 : opts.dir ? 0o040755 : 0o100644;
    ch.writeUInt32LE(((mode << 16) | (opts.dir ? 0x10 : 0)) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const fresh = () => mkdtemp(join(tmpdir(), 'unzip-'));

/** Every file path under a folder, relative, sorted. */
async function tree(root, rel = '') {
  const out = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await tree(root, p)));
    else out.push(p);
  }
  return out.sort();
}

// --- the happy path ---------------------------------------------------------------

test('a zip unpacks to its files, folders kept, contents intact', async () => {
  const dest = await fresh();
  const r = await unpackZip(zip([['art/', '', { dir: true }], ['art/a.txt', 'alpha'], ['art/deep/b.txt', 'beta'], ['top.txt', 'top', { store: true }]]), dest);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['art/a.txt', 'art/deep/b.txt', 'top.txt']);
  assert.equal(await readFile(join(dest, 'art/deep/b.txt'), 'utf8'), 'beta');
  assert.equal(await readFile(join(dest, 'top.txt'), 'utf8'), 'top');
  assert.equal(r.bytes, 'alphabetatop'.length);
  assert.deepEqual(r.skipped, []);
});

test('names with spaces and non-ASCII letters keep their spelling', async () => {
  const dest = await fresh();
  await unpackZip(zip([['0spike – Stiker Label (BPOM).pdf', 'x']]), dest);
  assert.deepEqual(await tree(dest), ['0spike – Stiker Label (BPOM).pdf']);
});

test('Mac metadata is dropped quietly and counted, not written', async () => {
  const dest = await fresh();
  const r = await unpackZip(zip([['a/x.txt', 'x'], ['a/.DS_Store', 'junk'], ['__MACOSX/a/._x.txt', 'junk'], ['a/._y', 'junk']]), dest);
  assert.deepEqual(await tree(dest), ['a/x.txt']);
  assert.equal(r.skipped.filter((s) => s.reason === 'macOS metadata').length, 3);
});

test('files are written without any execute bit, and folders closed to others', async () => {
  const dest = await fresh();
  await unpackZip(zip([['d/run.txt', 'x']]), dest, { sandbox: false });
  assert.equal((await stat(join(dest, 'd/run.txt'))).mode & 0o177, 0);
  assert.equal((await stat(join(dest, 'd'))).mode & 0o077, 0);
});

// --- hostile names -----------------------------------------------------------------

test('a name that climbs out, or starts at the root, is skipped and nothing lands outside', async () => {
  const base = await fresh();
  const dest = join(base, 'out');
  await (await import('node:fs/promises')).mkdir(dest);
  const evil = ['../escaped.txt', 'a/../../escaped2.txt', '/tmp/abs-escape.txt', 'C:/win.txt', '..\\back.txt', 'ok/..\\..\\x.txt', 'nul\0byte.txt'];
  const r = await unpackZip(zip([...evil.map((n) => [n, 'evil']), ['fine.txt', 'fine']]), dest, { sandbox: false });
  assert.deepEqual(await tree(dest), ['fine.txt']);
  assert.deepEqual(await readdir(base), ['out']); // nothing beside the folder
  assert.equal(r.skipped.length, evil.length);
  assert.ok(r.skipped.every((s) => /unsafe path/.test(s.reason)), JSON.stringify(r.skipped));
});

test('a segment that is only dots or slashes cannot make an empty or root name', () => {
  assert.deepEqual(entrySegments('a//b/./c'), { segments: ['a', 'b', 'c'] });
  assert.match(entrySegments('./').reason, /empty/);
  assert.match(entrySegments('x'.repeat(300)).reason, /too long/);
  assert.deepEqual(entrySegments('a\x07b'), { segments: ['a_b'] });
});

// --- links and clashes -------------------------------------------------------------

test('a symlink entry is skipped, so a later file cannot be written through it', async () => {
  const base = await fresh();
  const dest = join(base, 'out');
  await (await import('node:fs/promises')).mkdir(dest);
  const target = join(base, 'secret-target');
  await (await import('node:fs/promises')).mkdir(target);
  const r = await unpackZip(zip([['link', target, { symlink: true }], ['link/pwned.txt', 'pwned']]), dest, { sandbox: false });
  assert.deepEqual(await readdir(target), []);
  assert.equal(r.skipped.find((s) => s.name === 'link').reason, 'symlink');
  // The second entry lands as a plain folder `link/`, inside the unpack folder.
  assert.deepEqual(await tree(dest), ['link/pwned.txt']);
  assert.equal((await lstat(join(dest, 'link'))).isSymbolicLink(), false);
});

test('a name used twice, or twice by case, never overwrites the first file', async () => {
  const dest = await fresh();
  const r = await unpackZip(zip([['a.txt', 'first'], ['A.TXT', 'second'], ['dir', 'a file'], ['dir/inner.txt', 'clash']]), dest, { sandbox: false });
  // On a case-insensitive disk (a Mac's default) the second name is the first; on others it is a new file. Either way the first stays.
  assert.equal(await readFile(join(dest, 'a.txt'), 'utf8'), 'first');
  assert.equal(await readFile(join(dest, 'dir'), 'utf8'), 'a file');
  assert.ok(r.skipped.some((s) => s.name === 'dir/inner.txt' && /clashes/.test(s.reason)));
});

// --- ceilings ----------------------------------------------------------------------

test('too many entries refuses the whole archive', async () => {
  const dest = await fresh();
  const many = Array.from({ length: LIMITS.sandbox.maxEntries + 1 }, (_, i) => [`f${i}.txt`, 'x']);
  const r = await unpackZip(zip(many), dest);
  assert.match(r.error, /entries/);
  assert.deepEqual(await readdir(dest), []);
});

test('a bomb stops at the total ceiling, keeps what it had, and says so', async () => {
  const dest = await fresh();
  // Compresses to almost nothing, inflates to 30 MB apiece: four of them pass the 96 MB sandbox ceiling.
  const chunk = Buffer.alloc(30 * 1024 * 1024, 0);
  const bomb = zip([['a.bin', chunk], ['b.bin', chunk], ['c.bin', chunk], ['d.bin', chunk], ['e.bin', 'after']]);
  assert.ok(bomb.length < 1024 * 1024, 'the archive itself is small');
  const r = await unpackZip(bomb, dest);
  assert.ok(r.stopped);
  assert.equal(r.files.length, 3);
  assert.ok(r.bytes <= LIMITS.sandbox.maxTotalBytes);
  assert.ok(!(await tree(dest)).includes('e.bin'));
});

test('an entry past the per-entry ceiling is skipped and the rest still unpack', async () => {
  const dest = await fresh();
  const big = Buffer.alloc(LIMITS.sandbox.maxEntryBytes + 1024, 1);
  const r = await unpackZip(zip([['big.bin', big], ['small.txt', 'ok']]), dest);
  assert.deepEqual(await tree(dest), ['small.txt']);
  assert.ok(r.skipped.some((s) => s.name === 'big.bin'));
});

test('a password-protected or unsupported entry is skipped by name, not fatal', async () => {
  const dest = await fresh();
  const r = await unpackZip(zip([['locked.txt', 'x', { flags: 1 }], ['plain.txt', 'ok']]), dest);
  assert.deepEqual(await tree(dest), ['plain.txt']);
  assert.match(r.skipped[0].reason, /password/);
});

test('damaged data in one entry skips it and keeps the others', async () => {
  const dest = await fresh();
  const good = zip([['bad.txt', 'hello hello hello hello'], ['good.txt', 'fine']]);
  // Flip bytes inside the first entry's compressed data.
  const at = 30 + 'bad.txt'.length;
  for (let i = 0; i < 6; i++) good[at + i] ^= 0xff;
  const r = await unpackZip(good, dest);
  assert.ok((await tree(dest)).includes('good.txt'));
  assert.ok(r.skipped.some((s) => s.name === 'bad.txt'));
});

test('something that is not a zip is an error, with nothing written', async () => {
  const dest = await fresh();
  const r = await unpackZip(Buffer.from('this is not a zip file at all, not even close'), dest);
  assert.match(r.error, /Not a zip/);
  assert.deepEqual(await readdir(dest), []);
});

// --- the sandbox profile -----------------------------------------------------------

test('the sandbox writes no program, script, installer or hidden file; the full profile does', async () => {
  const files = [
    ['run.sh', '#!/bin/sh\necho hi'], ['setup.EXE', 'x'], ['tool.py', 'x'], ['Installer.pkg', 'x'], ['shortcut.webloc', 'x'],
    ['Thing.app/Contents/Info.plist', 'x'], ['noext-binary', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])],
    ['elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0])], ['script-no-ext', '#!/usr/bin/env node\n'],
    ['.hidden', 'x'], ['d/.env', 'x'], ['art.ai', 'artwork'], ['notes.md', 'notes'],
  ];
  const strict = await fresh();
  const rs = await unpackZip(zip(files), strict, { sandbox: true });
  assert.deepEqual(await tree(strict), ['art.ai', 'notes.md']);
  assert.equal(rs.skipped.length, files.length - 2);

  const loose = await fresh();
  await unpackZip(zip(files), loose, { sandbox: false });
  assert.equal((await tree(loose)).length, files.length);
});

test('program magic is recognised, and ordinary data is not', () => {
  assert.equal(looksExecutable(Buffer.from('MZ\x90\0')), true);
  assert.equal(looksExecutable(Buffer.from('#!/bin/sh')), true);
  assert.equal(looksExecutable(Buffer.from([0xca, 0xfe, 0xba, 0xbe])), true);
  assert.equal(looksExecutable(Buffer.from('%PDF-1.7')), false);
  assert.equal(looksExecutable(Buffer.from('PK\x03\x04')), false);
  assert.equal(looksExecutable(Buffer.from('ab')), false);
});

// --- what the agent is told ---------------------------------------------------------

test('the summary lists files, counts Mac junk without listing it, and says nothing was run', async () => {
  const dest = await fresh();
  const r = await unpackZip(zip([['a.txt', 'a'], ['__MACOSX/._a', 'j'], ['../x', 'e'], ['b.sh', '#!/bin/sh']]), dest);
  const text = describeUnpack(r, dest).join('\n');
  assert.match(text, /Unpacked 1 file /);
  assert.match(text, /a\.txt \(1 B\)/);
  assert.match(text, /Left out, macOS metadata \(1\)\n/);
  assert.match(text, /Left out, unsafe path \(climbs out\) \(1\): \.\.\/x/);
  assert.match(text, /Left out, program or script \(sandbox\) \(1\): b\.sh/);
  assert.match(text, /Nothing in the archive was run/);
});

test('a long list is cut with a count, and an error is a single line', async () => {
  const dest = await fresh();
  const r = await unpackZip(zip(Array.from({ length: 70 }, (_, i) => [`f${i}.txt`, 'x'])), dest);
  const text = describeUnpack(r, dest).join('\n');
  assert.match(text, /\.\.\. and 10 more/);
  assert.deepEqual(describeUnpack({ error: 'Not a zip file (too short).' }, dest), ['Could not unpack it: Not a zip file (too short).']);
});

test('the unpack folder is only ever written under, even for a path of many odd parts', async () => {
  const base = await fresh();
  const dest = join(base, 'out');
  await (await import('node:fs/promises')).mkdir(dest);
  await writeFile(join(base, 'victim.txt'), 'untouched');
  await unpackZip(zip([['a/b/../../../victim.txt', 'overwritten'], ['a/b/c/../../../../victim.txt', 'overwritten']]), dest, { sandbox: false });
  assert.equal(await readFile(join(base, 'victim.txt'), 'utf8'), 'untouched');
});

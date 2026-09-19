import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deepScan, dirSize } from '../lib/scan.js';
import { scanPython, scanNode, scanDocker } from '../lib/devtools.js';
import { trashPaths, emptyDirToTrash, moveToTrash } from '../lib/trash.js';

const HOME = os.homedir();
// Fixtures live inside the home folder because the safety rules — correctly —
// refuse to touch anything outside it.
const ROOT = path.join(HOME, `.macpuffin-tests-${process.pid}`);
const MB = 1024 * 1024;

const trashed = [];

async function writeFile(rel, sizeBytes, mtime) {
  const full = path.join(ROOT, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, Buffer.alloc(sizeBytes, 7));
  if (mtime) await fsp.utimes(full, mtime / 1000, mtime / 1000);
  return full;
}

before(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
  const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;

  await writeFile('media/huge.mov', 12 * MB);
  await writeFile('media/small.txt', 1024);
  await writeFile('docs/report.pdf', 3 * MB);
  await writeFile('archive/old-backup.zip', 11 * MB, ancient);
  await writeFile('archive/old-video.mp4', 14 * MB, ancient);

  // Two byte-identical files in different folders: one duplicate group.
  await writeFile('copies/a/payload.bin', 2 * MB);
  await writeFile('copies/b/payload.bin', 2 * MB);

  // A bundle whose contents must not appear as individual results.
  await writeFile('Thing.app/Contents/MacOS/binary', 5 * MB);
  await writeFile('project/node_modules/dep/index.js', 4 * MB);
});

after(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
  // Remove anything the trash tests moved, so the suite leaves no residue.
  for (const p of trashed) await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
});

// ── dirSize ──────────────────────────────────────────────────────────────────

test('dirSize() totals a tree and counts its files', async () => {
  const { size, files } = await dirSize(path.join(ROOT, 'media'));
  assert.equal(files, 2);
  assert.ok(size >= 12 * MB, `expected at least 12 MB, got ${size}`);
});

test('dirSize() returns zero for a path it cannot read', async () => {
  const { size, files } = await dirSize(path.join(ROOT, 'does-not-exist'));
  assert.equal(size, 0);
  assert.equal(files, 0);
});

// ── deepScan ─────────────────────────────────────────────────────────────────

test('deepScan() finds large files above the threshold', async () => {
  const r = await deepScan(ROOT, { minLarge: 10 * MB, thorough: true });
  const names = r.large.map((f) => f.name);
  assert.ok(names.includes('huge.mov'), names.join(', '));
  assert.ok(names.includes('old-video.mp4'));
  assert.ok(!names.includes('report.pdf'), '3 MB file must be below a 10 MB threshold');
});

test('deepScan() reports stale files by last-used date', async () => {
  const r = await deepScan(ROOT, { oldDays: 180, minOld: 10 * MB, thorough: true });
  const names = r.old.map((f) => f.name).sort();
  assert.deepEqual(names, ['old-backup.zip', 'old-video.mp4']);
  assert.equal(r.oldCount, 2);
  assert.ok(r.oldBytes >= 25 * MB);
});

test('deepScan() detects byte-identical duplicates and the space they waste', async () => {
  const r = await deepScan(ROOT, { minDup: MB, thorough: true });
  const group = r.duplicates.find((g) => g.name === 'payload.bin');
  assert.ok(group, 'duplicate group should exist');
  assert.equal(group.count, 2);
  assert.ok(group.wasted >= 2 * MB);
  assert.equal(group.paths.length, 2);
  assert.equal(group.mtimes.length, 2);
});

test('deepScan() breaks the tree down by category and folder', async () => {
  const r = await deepScan(ROOT, { thorough: true });
  const cats = Object.fromEntries(r.categories.map((c) => [c.name, c.size]));
  assert.ok(cats.Video > 0, 'video files should be categorised');
  assert.ok(cats.Archives > 0);
  assert.ok(cats.Documents > 0);
  assert.ok(r.folders.some((f) => f.name === 'media'));
  assert.ok(r.totalBytes > 0);
  assert.ok(r.files >= 9);
});

test('deepScan() treats app bundles as one item, not a pile of files', async () => {
  const r = await deepScan(ROOT, { minLarge: MB, thorough: true });
  assert.ok(r.bundles.some((b) => b.name === 'Thing.app'), 'bundle should be listed');
  assert.ok(
    !r.large.some((f) => f.path.includes('Thing.app')),
    'files inside a bundle must not be listed individually',
  );
});

test('deepScan() in fast mode skips dependency folders and says so', async () => {
  const fast = await deepScan(ROOT, { thorough: false });
  assert.ok(fast.skippedCount > 0, 'node_modules should have been skipped');
  assert.ok(fast.skipped.some((p) => p.endsWith('node_modules')));
  assert.equal(fast.thorough, false);

  const full = await deepScan(ROOT, { thorough: true });
  assert.ok(full.files > fast.files, 'a thorough scan must see more files');
});

test('deepScan() stops early when asked to', async () => {
  const r = await deepScan(ROOT, { shouldStop: () => true, thorough: true });
  assert.equal(r.files, 0);
});

test('deepScan() reports progress while it walks', async () => {
  let ticks = 0;
  await deepScan(ROOT, { thorough: true, onProgress: () => { ticks += 1; } });
  assert.ok(ticks >= 1, 'at least one progress tick expected');
});

// ── Trash ────────────────────────────────────────────────────────────────────

test('moveToTrash() moves a real file and leaves the source gone', async () => {
  const victim = await writeFile('trash-me/file.txt', 32);
  const res = await moveToTrash(victim);
  assert.equal(res.ok, true, res.error);
  assert.ok(res.dest, 'a destination inside the Trash is expected');
  trashed.push(res.dest);
  assert.equal(fs.existsSync(victim), false, 'source must be gone');
  assert.equal(fs.existsSync(res.dest), true, 'item must be in the Trash');
});

test('moveToTrash() reports a missing path instead of throwing', async () => {
  const res = await moveToTrash(path.join(ROOT, 'never-existed'));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not found');
});

test('moveToTrash() refuses a protected path', async () => {
  const res = await moveToTrash(path.join(HOME, 'Documents'));
  assert.equal(res.ok, false);
  assert.match(res.error, /protected/);
});

test('trashPaths() returns one result per input, in order', async () => {
  const a = await writeFile('batch/one.txt', 16);
  const b = await writeFile('batch/two.txt', 16);
  const results = await trashPaths([a, path.join(HOME, 'Desktop'), b]);
  assert.equal(results.length, 3);
  assert.equal(results[0].path, a);
  assert.equal(results[1].ok, false, 'the protected path must fail');
  assert.equal(results[2].path, b);
  results.filter((r) => r.ok).forEach((r) => trashed.push(r.dest));
});

test('trashPaths() records file sizes but leaves directories unmeasured', async () => {
  const file = await writeFile('sized/file.bin', 4096);
  await writeFile('sized-dir/inner.bin', 4096);
  const [fileRes, dirRes] = await trashPaths([file, path.join(ROOT, 'sized-dir')]);
  assert.equal(fileRes.size, 4096);
  assert.equal(fileRes.isDir, false);
  assert.equal(dirRes.size, null, 'directory size is deliberately not walked');
  assert.equal(dirRes.isDir, true);
  [fileRes, dirRes].filter((r) => r.ok).forEach((r) => trashed.push(r.dest));
});

test('emptyDirToTrash() clears the contents and keeps the folder', async () => {
  await writeFile('to-empty/one.txt', 64);
  await writeFile('to-empty/two.txt', 64);
  await writeFile('to-empty/nested/three.txt', 64);
  const dir = path.join(ROOT, 'to-empty');

  const res = await emptyDirToTrash(dir);
  assert.equal(res.errorCount, 0, JSON.stringify(res.errors));
  assert.equal(res.moved, 3);
  assert.equal(res.unsized, 1, 'the nested folder counts as unsized');
  assert.equal(res.freed, 128, 'only loose files contribute bytes');
  assert.equal(fs.existsSync(dir), true, 'the folder itself must survive');
  assert.deepEqual(await fsp.readdir(dir), [], 'the folder must be empty');
});

test('emptyDirToTrash() refuses a directory outside the home folder', async () => {
  const res = await emptyDirToTrash('/tmp');
  assert.equal(res.ok, false);
  assert.match(res.error, /outside home/);
});

test('emptyDirToTrash() reports a directory that does not exist', async () => {
  const res = await emptyDirToTrash(path.join(ROOT, 'nope'));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'ENOENT');
});

// ── Developer tools ──────────────────────────────────────────────────────────

test('scanPython finds virtualenvs and reads their interpreter version', async () => {
  await writeFile('dev/projA/.venv/lib/python3.12/site-packages/x.py', 2048);
  await fsp.writeFile(path.join(ROOT, 'dev/projA/.venv/pyvenv.cfg'),
    'home = /opt/homebrew/bin\nversion = 3.12.9\n');
  await writeFile('dev/projB/venv/lib/mod.py', 1024);
  await fsp.writeFile(path.join(ROOT, 'dev/projB/venv/pyvenv.cfg'), 'version = 3.11.4\n');

  const r = await scanPython(null, null, ROOT);
  const names = r.envs.map((e) => e.name).sort();
  assert.deepEqual(names, ['projA', 'projB']);
  assert.equal(r.count, 2);
  assert.ok(r.total > 0, 'environments should be measured');
  assert.equal(r.envs.find((e) => e.name === 'projA').version, '3.12.9');
  assert.equal(r.envs.find((e) => e.name === 'projB').kind, 'venv');
});

test('scanPython does not descend into an environment it already found', async () => {
  // A nested marker inside a venv must not appear as a second environment.
  await fsp.mkdir(path.join(ROOT, 'dev/projA/.venv/inner'), { recursive: true });
  await fsp.writeFile(path.join(ROOT, 'dev/projA/.venv/inner/pyvenv.cfg'), 'version = 3.9.0\n');
  const r = await scanPython(null, null, ROOT);
  assert.equal(r.envs.filter((e) => e.path.includes('inner')).length, 0);
});

test('scanNode finds node_modules and counts packages, scopes included', async () => {
  await writeFile('dev/web/node_modules/left-pad/index.js', 512);
  await writeFile('dev/web/node_modules/react/index.js', 4096);
  await writeFile('dev/web/node_modules/@scope/pkg-a/index.js', 256);
  await writeFile('dev/web/node_modules/@scope/pkg-b/index.js', 256);
  await writeFile('dev/web/node_modules/.bin/thing', 32);

  const r = await scanNode(null, null, ROOT);
  const web = r.modules.find((m) => m.project === 'web');
  assert.ok(web, 'the project should be found');
  assert.equal(web.packages, 4, 'two plain packages plus two scoped ones');
  assert.ok(web.size > 0);
});

test('a stopped developer scan returns nothing rather than hanging', async () => {
  const r = await scanNode(null, () => true, ROOT);
  assert.deepEqual(r.modules, []);
  assert.equal(r.total, 0);
});

test('scanDocker degrades gracefully when Docker is absent', async () => {
  const r = await scanDocker();
  assert.equal(typeof r.available, 'boolean');
  assert.ok(Array.isArray(r.images));
  if (!r.available) assert.match(r.reason, /Docker/);
  else assert.ok(r.total >= 0);
});

// ── Application removal ──────────────────────────────────────────────────────

test('an application bundle we own is trashed directly', async (t) => {
  const probe = '/Applications/MacPuffinTestProbe.app';
  try {
    await fsp.mkdir(path.join(probe, 'Contents/MacOS'), { recursive: true });
  } catch {
    return t.skip('/Applications is not writable here');
  }
  await fsp.writeFile(path.join(probe, 'Contents/Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict>'
    + '<key>CFBundleName</key><string>MacPuffinTestProbe</string></dict></plist>');

  const res = await moveToTrash(probe);
  assert.equal(res.ok, true, res.error);
  trashed.push(res.dest);
  assert.equal(fs.existsSync(probe), false, 'the bundle must leave /Applications');
});

test('a missing application reports "not found" rather than reaching for Finder', async () => {
  const res = await moveToTrash('/Applications/DefinitelyNotInstalled.app');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not found');
});

test('bundles nested inside an application are still refused', async () => {
  const res = await moveToTrash('/Applications/Safari.app/Contents/Frameworks/Some.app');
  assert.equal(res.ok, false);
  assert.match(res.error, /protected|not found/);
});

test('a name already taken in the Trash does not overwrite the earlier item', async () => {
  const first = await writeFile('collide/same-name.txt', 8);
  const a = await moveToTrash(first);
  assert.equal(a.ok, true, a.error);
  trashed.push(a.dest);

  const second = await writeFile('collide/same-name.txt', 8);
  const b = await moveToTrash(second);
  assert.equal(b.ok, true, b.error);
  trashed.push(b.dest);

  assert.notEqual(a.dest, b.dest, 'the second item must get its own name');
  assert.equal(fs.existsSync(a.dest), true, 'the first item must still be there');
});

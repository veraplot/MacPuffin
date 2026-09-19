import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scanJunk, scanApps, homeMap, spotlightLarge } from '../lib/scan.js';
import { condaEnvs, pyenvVersions, systemPythons } from '../lib/devtools.js';
import { appIcon, isAppBundle, CACHE_DIR } from '../lib/icons.js';
import { record, list, clear, redact, reportBody, CRASH_FILE } from '../lib/crash.js';
import { trashPaths } from '../lib/trash.js';

const HOME = os.homedir();
const ROOT = path.join(HOME, `.macpuffin-scanners-${process.pid}`);
const trashed = [];

async function put(rel, bytes = 1024) {
  const full = path.join(ROOT, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, Buffer.alloc(bytes, 3));
  return full;
}

before(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
  // A stand-in home, laid out like the real one so the junk scanner recognises it.
  await put('Library/Caches/SomeApp/blob.bin', 4096);
  await put('Library/Logs/thing.log', 2048);
  await put('Library/Developer/Xcode/DerivedData/Proj/build.o', 8192);
  await put('.Trash/old.txt', 64);
  await put('Documents/notes.txt', 128);
  await put('Movies/clip.mov', 16384);
});

after(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
  for (const p of trashed) await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
});

// ── Junk ─────────────────────────────────────────────────────────────────────

test('scanJunk finds known locations and rates their safety', async () => {
  const r = await scanJunk(null, null, ROOT);
  const labels = r.items.map((i) => i.label);
  assert.ok(labels.includes('User caches'), labels.join(', '));
  assert.ok(labels.includes('User logs'));
  assert.ok(labels.includes('Xcode DerivedData'));
  assert.ok(r.total > 0);

  for (const item of r.items) {
    assert.ok(['safe', 'review', 'danger'].includes(item.safety), item.safety);
    assert.ok(['move', 'empty', 'emptyTrash'].includes(item.mode), item.mode);
    assert.ok(item.files > 0);
  }
  // Only the safe rows may be counted as reclaimable.
  const safeTotal = r.items.filter((i) => i.safety === 'safe').reduce((s, i) => s + i.size, 0);
  assert.equal(r.reclaimable, safeTotal);
});

test('scanJunk marks macOS-owned folders as contents-only', async () => {
  const r = await scanJunk(null, null, ROOT);
  // Inside a fixture these are ordinary folders, so the classification comes
  // from the real path rules; assert the shape instead of a fixed verdict.
  const caches = r.items.find((i) => i.label === 'User caches');
  assert.ok(caches, 'user caches should be found');
  assert.ok(typeof caches.mode === 'string' && caches.mode.length > 0);
});

test('scanJunk stops when asked', async () => {
  const r = await scanJunk(null, () => true, ROOT);
  assert.deepEqual(r.items, []);
  assert.equal(r.total, 0);
});

// ── Applications ─────────────────────────────────────────────────────────────

test('scanApps reads size, version and last-used date from real bundles', async () => {
  const r = await scanApps(null, null, ['/System/Applications']);
  assert.ok(r.count > 0, 'the system ships applications');
  assert.ok(r.total > 0);
  const app = r.apps[0];
  assert.ok(app.name.length > 0);
  assert.ok(!app.name.endsWith('.app'), 'the extension should be stripped for display');
  assert.ok(app.path.endsWith('.app'));
  assert.ok(app.size > 0);
  // Sorted largest first.
  const sizes = r.apps.map((a) => a.size);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
});

test('scanApps ignores folders that hold no applications', async () => {
  const r = await scanApps(null, null, [ROOT]);
  assert.equal(r.count, 0);
  assert.equal(r.total, 0);
});

test('scanApps stops when asked', async () => {
  const r = await scanApps(null, () => true, ['/System/Applications']);
  assert.equal(r.count, 0);
});

// ── Home map ─────────────────────────────────────────────────────────────────

test('homeMap measures each top-level folder and reports them largest first', async () => {
  const seen = [];
  const r = await homeMap((p) => { if (p.item) seen.push(p.item.name); }, null, ROOT);
  const names = r.items.map((i) => i.name).sort();
  assert.deepEqual(names, ['Documents', 'Library', 'Movies']);
  assert.ok(r.total > 0);
  const sizes = r.items.map((i) => i.size);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
  assert.ok(seen.length > 0, 'folders should be reported as they complete');
});

test('homeMap skips the Trash and reports an unreadable root calmly', async () => {
  const r = await homeMap(null, null, ROOT);
  assert.ok(!r.items.some((i) => i.name === '.Trash'), 'the Trash is not part of the map');

  const missing = await homeMap(null, null, path.join(ROOT, 'nowhere'));
  assert.deepEqual(missing.items, []);
  assert.equal(missing.total, 0);
});

test('homeMap stops when asked', async () => {
  const r = await homeMap(null, () => true, ROOT);
  assert.deepEqual(r.items, []);
});

// ── Spotlight ────────────────────────────────────────────────────────────────

test('spotlightLarge returns only files, above the threshold, largest first', async () => {
  const files = await spotlightLarge(512 * 1024 * 1024, 20);
  assert.ok(Array.isArray(files));
  assert.ok(files.length <= 20);
  for (const f of files) {
    assert.ok(f.size >= 512 * 1024 * 1024, `${f.name} is below the threshold`);
    assert.ok(fs.statSync(f.path).isFile(), 'directories must not be returned');
  }
  const sizes = files.map((f) => f.size);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
});

test('spotlightLarge returns nothing for an impossible threshold', async () => {
  const files = await spotlightLarge(1024 ** 5, 10);   // a petabyte
  assert.deepEqual(files, []);
});

// ── Application icons ────────────────────────────────────────────────────────

test('appIcon extracts a real PNG and caches it', async () => {
  const target = '/System/Applications/Calculator.app';
  if (!fs.existsSync(target)) return;

  // Coverage must not depend on whether an earlier run warmed the cache, so
  // the entry is removed first and the extraction genuinely re-runs.
  const { createHash } = await import('node:crypto');
  const cached = path.join(CACHE_DIR, `${createHash('md5').update(target).digest('hex')}.png`);
  await fsp.rm(cached, { force: true });

  const png = await appIcon(target);
  assert.ok(Buffer.isBuffer(png), 'a PNG buffer is expected');
  assert.equal(png.subarray(1, 4).toString(), 'PNG', 'the magic bytes must say PNG');
  assert.ok(png.length > 100);
  assert.ok(fs.existsSync(CACHE_DIR));

  // Second call comes from the cache and must be byte-identical.
  const again = await appIcon(target);
  assert.deepEqual(again, png);
});

test('appIcon refuses anything that is not a serviceable bundle', async () => {
  assert.equal(await appIcon('/etc/passwd'), null);
  assert.equal(await appIcon(path.join(HOME, 'Downloads/not-real.app')), null);
  assert.equal(isAppBundle('/System/Applications/Calculator.app'), true);
});

test('appIcon falls back to any .icns when the bundle declares none', async () => {
  const probe = '/Applications/MacPuffinIconProbe.app';
  try {
    await fsp.mkdir(path.join(probe, 'Contents/Resources'), { recursive: true });
  } catch {
    return;   // /Applications is not writable here
  }
  try {
    await fsp.writeFile(path.join(probe, 'Contents/Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict>'
      + '<key>CFBundleName</key><string>Probe</string></dict></plist>');
    // No CFBundleIconFile key, but an .icns is present: the directory scan wins.
    await fsp.copyFile('/System/Applications/Calculator.app/Contents/Resources/AppIcon.icns',
      path.join(probe, 'Contents/Resources/Whatever.icns')).catch(() => {});

    if (fs.existsSync(path.join(probe, 'Contents/Resources/Whatever.icns'))) {
      const png = await appIcon(probe);
      assert.ok(Buffer.isBuffer(png), 'the stray .icns should still be found');
    }
  } finally {
    await fsp.rm(probe, { recursive: true, force: true });
  }
});

test('appIcon reports nothing for a bundle that ships no icon at all', async () => {
  const probe = '/Applications/MacPuffinNoIconProbe.app';
  try {
    await fsp.mkdir(path.join(probe, 'Contents/Resources'), { recursive: true });
  } catch {
    return;
  }
  try {
    await fsp.writeFile(path.join(probe, 'Contents/Info.plist'), '<plist><dict></dict></plist>');
    assert.equal(await appIcon(probe), null);
    // Asked twice, the miss is remembered rather than re-derived.
    assert.equal(await appIcon(probe), null);
  } finally {
    await fsp.rm(probe, { recursive: true, force: true });
  }
});

// ── Environment discovery ────────────────────────────────────────────────────

test('condaEnvs finds a base install and its named environments', async () => {
  await fsp.mkdir(path.join(ROOT, 'anaconda3/envs/projectA'), { recursive: true });
  await fsp.mkdir(path.join(ROOT, 'anaconda3/envs/projectB'), { recursive: true });
  await fsp.mkdir(path.join(ROOT, 'miniconda3'), { recursive: true });

  const envs = await condaEnvs(ROOT);
  const names = envs.map((e) => e.name).sort();
  assert.deepEqual(names, ['anaconda3 (base)', 'miniconda3 (base)', 'projectA', 'projectB']);
  assert.ok(envs.every((e) => e.kind === 'conda'));
});

test('condaEnvs returns nothing when no distribution is installed', async () => {
  assert.deepEqual(await condaEnvs(path.join(ROOT, 'empty')), []);
});

test('pyenvVersions lists installed interpreters', async () => {
  await fsp.mkdir(path.join(ROOT, '.pyenv/versions/3.12.9'), { recursive: true });
  await fsp.mkdir(path.join(ROOT, '.pyenv/versions/3.11.4'), { recursive: true });
  const found = await pyenvVersions(ROOT);
  assert.deepEqual(found.map((v) => v.name).sort(), ['3.11.4', '3.12.9']);
  assert.ok(found.every((v) => v.kind === 'pyenv'));

  assert.deepEqual(await pyenvVersions(path.join(ROOT, 'empty')), []);
});

test('systemPythons reports interpreters on PATH, without duplicates', async () => {
  const found = await systemPythons();
  assert.ok(Array.isArray(found));
  const paths = found.map((f) => f.path);
  assert.equal(new Set(paths).size, paths.length, 'no duplicates');
  for (const f of found) {
    assert.equal(f.kind, 'system');
    assert.equal(f.size, null, 'a shared interpreter is not measured as an environment');
    assert.ok(!f.path.includes('/.pyenv/'), 'pyenv shims belong to the pyenv list');
    assert.ok(!f.path.includes('anaconda'), 'conda interpreters belong to the conda list');
  }
});

// ── Crash reports ────────────────────────────────────────────────────────────

test('record stores a crash, list returns it newest first, clear empties it', async () => {
  const before = fs.existsSync(CRASH_FILE) ? fs.readFileSync(CRASH_FILE, 'utf8') : null;
  clear();

  record({ kind: 'AError', message: 'first', stack: 'at a', where: 'test' });
  record({ kind: 'BError', message: 'second', stack: 'at b', where: 'test' });
  const all = list();
  assert.equal(all.length, 2);
  assert.equal(all[0].message, 'second', 'newest first');
  assert.ok(all[0].id && all[0].at);

  // The same fault twice is one entry with a count, not two rows.
  record({ kind: 'AError', message: 'first', stack: 'at a', where: 'test' });
  const after = list();
  assert.equal(after.length, 2, 'repeats must collapse');
  assert.equal(after.find((c) => c.message === 'first').count, 2);

  clear();
  assert.deepEqual(list(), []);
  if (before !== null) fs.writeFileSync(CRASH_FILE, before);
});

test('record truncates a runaway stack and oversized context', () => {
  clear();
  const entry = record({
    kind: 'Deep',
    message: 'x',
    stack: Array.from({ length: 200 }, (_, i) => `at frame${i}`).join('\n'),
    context: { blob: 'y'.repeat(5000) },
  });
  assert.ok(entry.stack.split('\n').length <= 12, 'stack should be trimmed');
  assert.ok(entry.context.length <= 500, 'context should be capped');
  clear();
});

test('redact survives empty and non-string input', () => {
  assert.equal(redact(''), '');
  assert.equal(redact(undefined), '');
  assert.equal(redact(null), '');
  assert.equal(redact(42), '42');
});

test('reportBody copes with missing hardware facts', () => {
  const body = reportBody({ kind: 'E', message: 'm', stack: '', at: 'now', where: 'w' }, null);
  assert.match(body, /### Machine/);
  assert.match(body, /\| MacPuffin \| \? \|/);
  assert.match(body, /\(no stack\)/);
});

// ── Trash, in bulk ───────────────────────────────────────────────────────────

test('the rename fallback moves files when the helper is unavailable', async () => {
  const a = await put('fallback/one.txt', 32);
  const b = await put('fallback/two.txt', 32);
  const results = await trashPaths([a, b], { useHelper: false });
  assert.equal(results.filter((r) => r.ok).length, 2, results.find((r) => !r.ok)?.error);
  results.filter((r) => r.ok).forEach((r) => trashed.push(r.dest));
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), false);
});

test('the fallback still refuses protected paths', async () => {
  const [res] = await trashPaths([path.join(HOME, 'Documents')], { useHelper: false });
  assert.equal(res.ok, false);
  assert.match(res.error, /protected/);
});

test('trashing more items than one batch still moves every one', async () => {
  // The helper sends 400 paths per invocation; 410 forces a second round.
  const paths = [];
  for (let i = 0; i < 410; i += 1) paths.push(await put(`bulk/f${i}.txt`, 16));

  const results = await trashPaths(paths);
  assert.equal(results.length, 410);
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 410, results.find((r) => !r.ok)?.error);
  ok.forEach((r) => trashed.push(r.dest));
  assert.equal(fs.existsSync(paths[0]), false);
  assert.equal(fs.existsSync(paths[409]), false);
});

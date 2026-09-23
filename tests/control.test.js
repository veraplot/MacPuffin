import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createControl } from '../lib/control.js';
import { deepScan, scanJunk, homeMap, dirSize } from '../lib/scan.js';

/** Let every already-queued microtask and timer callback run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// ── The control itself ───────────────────────────────────────────────────────

test('a fresh control is running and stops nothing', async () => {
  const c = createControl();
  assert.equal(c.state, 'running');
  assert.equal(c.paused, false);
  assert.equal(c.stopped, false);
  assert.equal(await c.checkpoint(), false);
});

test('pause parks a checkpoint instead of resolving it', async () => {
  const c = createControl();
  assert.equal(c.pause(), true);
  assert.equal(c.state, 'paused');

  let settled = false;
  const waiting = c.checkpoint().then((v) => { settled = true; return v; });

  await settle();
  // This is the actual bug being fixed: the old gate returned a boolean
  // immediately, so a "pause" could only ever abort or be ignored.
  assert.equal(settled, false, 'the checkpoint resolved while paused');
  assert.equal(c.parked, 1);

  assert.equal(c.resume(), true);
  assert.equal(await waiting, false, 'resuming must continue, not abandon');
  assert.equal(c.parked, 0);
});

test('resume releases every parked loop at once', async () => {
  const c = createControl();
  c.pause();
  const all = [c.checkpoint(), c.checkpoint(), c.checkpoint()];
  await settle();
  assert.equal(c.parked, 3);

  c.resume();
  assert.deepEqual(await Promise.all(all), [false, false, false]);
  assert.equal(c.parked, 0);
});

test('a checkpoint reached after the pause parks too', async () => {
  const c = createControl();
  c.pause();
  await settle();
  // A walk that was mid-`readdir` when the pause landed reaches its gate later;
  // it must still be held.
  let settled = false;
  c.checkpoint().then(() => { settled = true; });
  await settle();
  assert.equal(settled, false);
  c.stop();
  await settle();
  assert.equal(settled, true);
});

test('stop while paused wakes the walk and abandons it', async () => {
  const c = createControl();
  c.pause();
  const waiting = c.checkpoint();
  await settle();
  assert.equal(c.parked, 1);

  assert.equal(c.stop(), true);
  assert.equal(await waiting, true, 'Stop must work on a paused scan');
  assert.equal(c.state, 'stopped');
});

test('stopped is terminal: pause and resume cannot revive it', async () => {
  const c = createControl();
  c.stop();
  assert.equal(c.pause(), false);
  assert.equal(c.resume(), false);
  assert.equal(c.stop(), false, 'a second stop changes nothing');
  assert.equal(c.state, 'stopped');
  assert.equal(await c.checkpoint(), true);
});

test('repeated pause or resume reports that nothing changed', () => {
  const c = createControl();
  assert.equal(c.resume(), false, 'resuming a running scan is a no-op');
  assert.equal(c.pause(), true);
  assert.equal(c.pause(), false, 'a double click must not double-pause');
  assert.equal(c.resume(), true);
  assert.equal(c.resume(), false);
});

test('pause then resume then pause again holds a second time', async () => {
  const c = createControl();
  c.pause();
  const first = c.checkpoint();
  await settle();
  c.resume();
  assert.equal(await first, false);

  c.pause();
  let settled = false;
  c.checkpoint().then(() => { settled = true; });
  await settle();
  assert.equal(settled, false, 'the control must be reusable');
  c.resume();
});

// ── Snapshots ────────────────────────────────────────────────────────────────

test('a control with no snapshot provider returns null', () => {
  assert.equal(createControl().snapshot(), null);
});

test('snapshot reads the live value each time it is taken', () => {
  const c = createControl();
  let files = 0;
  c.provide(() => ({ files }));
  assert.deepEqual(c.snapshot(), { files: 0 });
  files = 42;
  assert.deepEqual(c.snapshot(), { files: 42 });
});

test('a snapshot that throws does not take the scan down', () => {
  const c = createControl();
  c.provide(() => { throw new Error('half-built state'); });
  assert.equal(c.snapshot(), null);
});

// ── Real scans ───────────────────────────────────────────────────────────────

let tmp;
test('build a tree to walk', async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mp-pause-'));
  for (let d = 0; d < 6; d += 1) {
    const dir = path.join(tmp, `dir${d}`);
    await fsp.mkdir(dir, { recursive: true });
    for (let f = 0; f < 12; f += 1) {
      await fsp.writeFile(path.join(dir, `f${f}.bin`), Buffer.alloc(2048, d));
    }
  }
});

test('deepScan holds while paused and keeps counting after resume', async () => {
  const c = createControl();
  // The walk consults the gate once per directory, so counting gate calls pauses
  // at a known point in the tree — no sleeping, and no dependence on the
  // 120 ms progress throttle, which a small tree never trips twice.
  let gates = 0;
  const gate = async () => {
    gates += 1;
    if (gates === 4) c.pause();
    return c.checkpoint();
  };

  const run = deepScan(tmp, {
    minLarge: 1,
    minOld: 1,
    minDup: 1,
    shouldStop: gate,
    onSnapshot: c.provide,
  });

  for (let i = 0; i < 500 && !c.parked; i += 1) await settle();
  assert.equal(c.paused, true, 'the walk never paused');
  assert.ok(c.parked > 0, 'the walk did not park at a checkpoint');

  // The promise must still be pending: a pause is not a finish.
  const raced = await Promise.race([run.then(() => 'finished'), settle().then(() => 'pending')]);
  assert.equal(raced, 'pending', 'a paused scan must not resolve');

  // What the user sees on the paused screen.
  const snap = c.snapshot();
  assert.ok(snap, 'a paused scan offered no results');
  const filesAtPause = snap.files;
  assert.ok(filesAtPause > 0, 'the paused snapshot was empty');
  assert.ok(filesAtPause < 72, 'the walk had already finished, so nothing was held');
  assert.ok(snap.large.length > 0, 'the paused snapshot listed no large files');
  assert.ok(snap.categories.length > 0, 'the paused snapshot had no breakdown');
  assert.deepEqual(snap.duplicates, [], 'duplicates need the whole walk, so a pause reports none');

  // Holding it must not advance the count.
  for (let i = 0; i < 20; i += 1) await settle();
  assert.equal(c.snapshot().files, filesAtPause, 'the walk kept reading while paused');
  assert.equal(gates, 4, 'the walk consulted the gate again while paused');

  c.resume();
  const final = await run;
  assert.equal(c.state, 'running');
  assert.equal(final.files, 72, 'resuming must finish the walk, not restart it');
  assert.ok(final.files > filesAtPause, 'the resumed walk found nothing new');
  assert.ok(final.duplicates.length > 0, 'the completed walk should find the identical files');
});

test('stopping a paused deepScan returns exactly what the pause was showing', async () => {
  const c = createControl();
  let gates = 0;
  const run = deepScan(tmp, {
    minLarge: 1,
    shouldStop: async () => {
      gates += 1;
      if (gates === 3) c.pause();
      return c.checkpoint();
    },
    onSnapshot: c.provide,
  });

  for (let i = 0; i < 500 && !c.parked; i += 1) await settle();
  assert.equal(c.paused, true);
  const held = c.snapshot().files;

  c.stop();
  const result = await run;
  assert.equal(c.stopped, true);
  assert.equal(result.files, held, 'Stop must keep exactly what the pause was showing');
  assert.ok(result.files < 72, 'a stopped walk should not have read everything');
  assert.equal(typeof result.root, 'string', 'a stopped walk still returns a usable shape');
});

test('a sync boolean gate still works, so stop-only callers are unaffected', async () => {
  const done = await deepScan(tmp, { shouldStop: () => true });
  assert.equal(done.files, 0, 'an always-stop predicate must abort immediately');

  const full = await deepScan(tmp, { shouldStop: () => false });
  assert.equal(full.files, 72);
});

test('dirSize honours the gate mid-tree', async () => {
  const c = createControl();
  c.stop();
  const cut = await dirSize(tmp, c.checkpoint);
  assert.equal(cut.partial, true);
  assert.equal(cut.size, 0);

  const whole = await dirSize(tmp);
  assert.equal(whole.files, 72);
  assert.equal(whole.partial, undefined);
});

test('scanJunk and homeMap expose a snapshot before they finish', async () => {
  for (const run of [
    (c) => scanJunk(undefined, c.checkpoint, tmp, c.provide),
    (c) => homeMap(undefined, c.checkpoint, tmp, c.provide),
  ]) {
    const c = createControl();
    let taken = null;
    const p = run(c);
    // The provider is registered before any measuring happens, so a pause on
    // the very first tick still has something to show.
    taken = c.snapshot();
    assert.ok(taken, 'no snapshot was offered');
    assert.equal(taken.total, 0, 'the first snapshot should be empty, not absent');
    assert.ok(Array.isArray(taken.items));
    await p;
  }
});

test('homeMap resumes into a complete map', async () => {
  const c = createControl();
  let gates = 0;
  const p = homeMap(
    undefined,
    async () => {
      gates += 1;
      if (gates === 2) c.pause();
      return c.checkpoint();
    },
    tmp,
    c.provide,
  );

  for (let i = 0; i < 500 && !c.parked; i += 1) await settle();
  assert.equal(c.paused, true, 'the map never paused');
  const mid = c.snapshot();
  assert.ok(mid.items.length < 6, 'the map had already finished, so nothing was held');

  c.resume();
  const final = await p;
  assert.equal(final.items.length, 6, 'every folder must be measured after a resume');
  assert.equal(final.total, 6 * 12 * 2048);
});

test('clean up the tree', async () => {
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  assert.equal(fs.existsSync(tmp), false);
});

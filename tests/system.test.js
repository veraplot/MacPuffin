import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import {
  hardware, memory, cpu, processes, volumes, startupDisk, power, snapshot,
} from '../lib/system.js';

/**
 * These read the real machine. Every assertion is therefore a range or an
 * invariant rather than a fixed value — the point is that the parsing produces
 * something coherent, on whatever Mac happens to run the suite.
 */

test('hardware() reports this machine, and caches the answer', async () => {
  const hw = await hardware();
  assert.ok(hw.memTotal > 1024 ** 3, 'at least a gigabyte of RAM');
  assert.ok(hw.cores >= 1);
  assert.match(hw.osName, /macOS|Mac OS/);
  assert.match(hw.osVersion, /^\d+/);
  assert.ok(hw.model.length > 0);
  assert.equal(hw.home, os.homedir());
  assert.ok(['arm64', 'x64'].includes(hw.arch));
  assert.equal(hw.native, !hw.translated);
  assert.match(hw.version, /^\d+\.\d+\.\d+$/);

  // The second call must be the identical object, not a fresh probe.
  assert.strictEqual(await hardware(), hw);
});

test('memory() splits the total into parts that add up sensibly', async () => {
  const m = await memory();
  assert.ok(m.total > 0);
  for (const k of ['app', 'wired', 'compressed', 'cached', 'free']) {
    assert.ok(m[k] >= 0, `${k} must not be negative`);
    assert.ok(m[k] <= m.total, `${k} cannot exceed total memory`);
  }
  assert.equal(m.used, m.app + m.wired + m.compressed);
  assert.ok(m.used > 0 && m.used <= m.total);
  assert.ok(m.pressure > 0 && m.pressure <= 1);
  assert.ok(m.swapUsed >= 0 && m.swapTotal >= 0);
});

test('memory() reads the page size rather than assuming it', async () => {
  // A wrong page size is the classic Intel/Apple Silicon bug: 4 KB vs 16 KB.
  // If it were hard-coded, the total in use would be out by a factor of four.
  const m = await memory();
  assert.ok(m.used / m.total > 0.02, 'usage implausibly low — page size likely wrong');
  assert.ok(m.used / m.total <= 1, 'usage above 100% — page size likely wrong');
});

test('cpu() reports load, utilisation and uptime', async () => {
  const c = await cpu();
  assert.ok(c.cores >= 1);
  assert.ok(c.load1 >= 0 && c.load5 >= 0 && c.load15 >= 0);
  assert.ok(c.busy >= 0 && c.busy <= 100);
  assert.ok(c.uptime > 0);
  if (c.idle !== null) {
    assert.ok(c.user >= 0 && c.sys >= 0);
    assert.ok(Math.abs(c.busy - (100 - c.idle)) < 0.001);
  }
});

test('processes() aggregates per application bundle', async () => {
  const p = await processes();
  assert.ok(p.procCount > 10, 'a running Mac has plenty of processes');
  assert.ok(p.byMem.length > 0 && p.byCpu.length > 0);

  for (const row of p.byMem) {
    assert.ok(row.name.length > 0);
    assert.ok(row.mem >= 0);
    assert.ok(row.count >= 1);
    assert.ok(!row.name.includes('/'), 'a path leaked into the display name');
    if (row.app) assert.ok(row.app.endsWith('.app'), row.app);
  }
  // Sorted, descending, by the metric each list is named for.
  const mems = p.byMem.map((r) => r.mem);
  assert.deepEqual(mems, [...mems].sort((a, b) => b - a));
  const cpus = p.byCpu.map((r) => r.cpu);
  assert.deepEqual(cpus, [...cpus].sort((a, b) => b - a));
});

test('processes() honours its limit', async () => {
  const p = await processes(5);
  assert.ok(p.byMem.length <= 5);
  assert.ok(p.byCpu.length <= 5);
});

test('volumes() returns real mounted filesystems', async () => {
  const v = await volumes();
  assert.ok(v.length > 0);
  for (const vol of v) {
    assert.ok(vol.device.startsWith('/dev/'), vol.device);
    assert.ok(vol.total > 0);
    assert.ok(vol.free >= 0 && vol.free <= vol.total);
    assert.ok(vol.percent >= 0 && vol.percent <= 1);
    assert.doesNotMatch(vol.mount, /^\/System\/Volumes\/(VM|Preboot|Update)/, 'system helper volumes should be filtered out');
  }
});

test('startupDisk() picks the volume the user actually stores things on', async () => {
  const d = await startupDisk();
  assert.ok(d, 'a startup volume must be identified');
  assert.ok(['/System/Volumes/Data', '/'].includes(d.mount), d.mount);
  assert.ok(d.total > 0 && d.free >= 0);
});

test('power() answers whether a battery exists without failing on desktops', async () => {
  const p = await power();
  assert.equal(typeof p.hasBattery, 'boolean');
  assert.equal(typeof p.charging, 'boolean');
  assert.ok(p.cpuSpeedLimit >= 0 && p.cpuSpeedLimit <= 100);
  if (p.hasBattery) assert.ok(p.percent >= 0 && p.percent <= 100);
});

test('snapshot() gathers every panel in one object', async () => {
  const s = await snapshot();
  for (const key of ['hw', 'mem', 'cpu', 'procs', 'disk', 'volumes', 'power', 'ts']) {
    assert.ok(s[key] !== undefined, `snapshot is missing ${key}`);
  }
  assert.ok(Array.isArray(s.volumes));
  assert.ok(s.ts <= Date.now() && s.ts > Date.now() - 60000);
});

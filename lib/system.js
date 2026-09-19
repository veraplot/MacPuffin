import os from 'node:os';
import path from 'node:path';
import { sh } from './util.js';
import { VERSION } from './version.js';
import { isAppBundle } from './icons.js';

const HOME = os.homedir();

let hwCache = null;

/** Static hardware facts - read once. */
export async function hardware() {
  if (hwCache) return hwCache;
  const [brand, memsize, model, serialBlock] = await Promise.all([
    sh('sysctl', ['-n', 'machdep.cpu.brand_string']),
    sh('sysctl', ['-n', 'hw.memsize']),
    sh('sysctl', ['-n', 'hw.model']),
    sh('sw_vers', []),
  ]);
  const vers = Object.fromEntries(
    serialBlock
      .trim()
      .split('\n')
      .map((l) => l.split(/:\s+/))
      .filter((p) => p.length === 2),
  );
  // Rosetta translation is reported per-process; 1 means this very process is
  // running under it, which on an Apple Silicon Mac would mean an Intel build.
  const translated = (await sh('sysctl', ['-n', 'sysctl.proc_translated'])).trim() === '1';

  hwCache = {
    version: VERSION,
    arch: process.arch,
    translated,
    native: !translated,
    cpu: brand.trim() || 'Unknown CPU',
    cores: os.cpus().length,
    memTotal: Number(memsize.trim()) || os.totalmem(),
    model: model.trim(),
    osName: vers.ProductName || 'macOS',
    osVersion: vers.ProductVersion || '',
    osBuild: vers.BuildVersion || '',
    hostname: os.hostname().replace(/\.local$/, ''),
    user: os.userInfo().username,
    home: HOME,
  };
  return hwCache;
}

/** Parse `vm_stat` into an Activity-Monitor-shaped memory breakdown. */
export async function memory() {
  const hw = await hardware();
  const raw = await sh('vm_stat', []);
  const pageSize = Number(raw.match(/page size of (\d+) bytes/)?.[1] || 16384);
  const pages = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(.+?):\s+(\d+)\./);
    if (m) pages[m[1].trim().toLowerCase()] = Number(m[2]);
  }
  const p = (k) => (pages[k] || 0) * pageSize;

  const wired = p('pages wired down');
  const compressed = p('pages occupied by compressor');
  const anonymous = p('anonymous pages');
  const purgeable = p('pages purgeable');
  const app = Math.max(anonymous - purgeable, 0);
  const cached = p('file-backed pages');
  const free = p('pages free') + p('pages speculative');
  const used = app + wired + compressed;

  const swapRaw = await sh('sysctl', ['-n', 'vm.swapusage']);
  const swapUsed = Number(swapRaw.match(/used\s*=\s*([\d.]+)M/)?.[1] || 0) * 1024 * 1024;
  const swapTotal = Number(swapRaw.match(/total\s*=\s*([\d.]+)M/)?.[1] || 0) * 1024 * 1024;

  return {
    total: hw.memTotal,
    used,
    app,
    wired,
    compressed,
    cached,
    free,
    swapUsed,
    swapTotal,
    pressure: Math.min(used / hw.memTotal, 1),
  };
}

/** CPU load + uptime. */
export async function cpu() {
  const hw = await hardware();
  const [l1, l5, l15] = os.loadavg();
  const top = await sh('top', ['-l', '1', '-n', '0', '-stats', 'cpu'], { timeout: 6000 });
  const m = top.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/);
  const user = m ? Number(m[1]) : null;
  const sys = m ? Number(m[2]) : null;
  const idle = m ? Number(m[3]) : null;
  return {
    load1: l1,
    load5: l5,
    load15: l15,
    cores: hw.cores,
    user,
    sys,
    idle,
    busy: idle === null ? Math.min((l1 / hw.cores) * 100, 100) : 100 - idle,
    uptime: os.uptime(),
  };
}

const APP_RE = /\/([^/]+)\.app\/Contents\/MacOS\//;
/**
 * The outermost .app in a path: "/Applications/Arc.app", not the helper bundle
 * buried in its Frameworks folder, which ships no icon of its own.
 *
 * Only bundles the icon service will actually serve are reported, so the
 * interface never requests an icon that is certain to 404.
 */
function outerBundle(comm) {
  const i = comm.indexOf('.app/');
  if (i <= 0) return null;
  const bundle = comm.slice(0, i + 4);
  return isAppBundle(bundle) ? bundle : null;
}

function prettyProcName(comm) {
  const app = comm.match(APP_RE);
  if (app) return app[1];
  const xpc = comm.match(/\/([^/]+)\.xpc\/Contents\/MacOS\//);
  if (xpc) return xpc[1];
  return path.basename(comm);
}

/** Running processes, aggregated per app bundle (like Activity Monitor rows). */
export async function processes(limit = 24) {
  const raw = await sh('ps', ['-A', '-o', 'pid=,ppid=,%cpu=,rss=,comm=']);
  const map = new Map();
  let procCount = 0;

  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    procCount += 1;
    const [, pid, , pcpu, rss, comm] = m;
    const name = prettyProcName(comm);
    const key = name.replace(/ (Helper|Helper \(.+\)|Renderer|GPU|Web Content)$/i, '').trim() || name;
    const entry = map.get(key) || { name: key, cpu: 0, mem: 0, count: 0, pid: Number(pid), app: null };
    entry.cpu += Number(pcpu);
    entry.mem += Number(rss) * 1024;
    entry.count += 1;
    // Keep the owning bundle so the UI can show the real application icon.
    if (!entry.app) entry.app = outerBundle(comm);
    map.set(key, entry);
  }

  const all = [...map.values()];
  return {
    procCount,
    byCpu: [...all].sort((a, b) => b.cpu - a.cpu).slice(0, limit),
    byMem: [...all].sort((a, b) => b.mem - a.mem).slice(0, limit),
  };
}

/** Mounted volumes with real capacity numbers (df -k, 1024-byte blocks). */
export async function volumes() {
  const raw = await sh('df', ['-k']);
  const out = [];
  const seen = new Set();
  for (const line of raw.split('\n').slice(1)) {
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+\d+\s+\d+\s+\S+\s+(.+)$/);
    if (!m) continue;
    const [, device, total, used, avail, , mount] = m;
    if (!device.startsWith('/dev/')) continue;
    if (/^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware|Recovery)/.test(mount)) continue;
    const key = `${device}:${mount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      device,
      mount,
      total: Number(total) * 1024,
      used: Number(used) * 1024,
      free: Number(avail) * 1024,
      percent: Number(used) / (Number(used) + Number(avail)) || 0,
      isStartup: mount === '/System/Volumes/Data' || mount === '/',
    });
  }
  return out;
}

/** The volume the user's data actually lives on. */
export async function startupDisk() {
  const vols = await volumes();
  return (
    vols.find((v) => v.mount === '/System/Volumes/Data') ||
    vols.find((v) => v.mount === '/') ||
    vols[0] ||
    null
  );
}

/** Battery + thermal, when present. */
export async function power() {
  const raw = await sh('pmset', ['-g', 'batt'], { timeout: 5000 });
  const pct = raw.match(/(\d+)%/);
  const state = raw.match(/;\s*([a-z ]+);/);
  const hasBattery = /InternalBattery/.test(raw);
  const thermal = await sh('pmset', ['-g', 'therm'], { timeout: 5000 });
  const speedLimit = thermal.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  return {
    hasBattery,
    percent: pct ? Number(pct[1]) : null,
    state: state ? state[1].trim() : null,
    charging: /AC Power/.test(raw),
    cpuSpeedLimit: speedLimit ? Number(speedLimit[1]) : 100,
  };
}

export async function snapshot() {
  const [hw, mem, cpuInfo, procs, disk, vols, pwr] = await Promise.all([
    hardware(),
    memory(),
    cpu(),
    processes(),
    startupDisk(),
    volumes(),
    power(),
  ]);
  return { hw, mem, cpu: cpuInfo, procs, disk, volumes: vols, power: pwr, ts: Date.now() };
}

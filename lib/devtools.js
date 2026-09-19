import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sh, pool } from './util.js';
import { dirSize } from './scan.js';

const HOME = os.homedir();

/** Where developer clutter never hides, and where walking is expensive. */
const SKIP = new Set(
  [
    'Library/Caches', 'Library/Containers', 'Library/Group Containers',
    'Library/Mobile Documents', 'Library/CloudStorage', 'Library/Developer',
    '.Trash', '.git', 'Applications',
  ].map((d) => path.join(HOME, d)),
);

/**
 * Walk the home folder looking for marker directories, without descending into
 * anything already identified. Bounded in depth because a Python environment or
 * a node_modules folder sits near the top of a project, never twenty levels in.
 */
async function findMarkers(root, { maxDepth = 7, isMatch, onProgress, shouldStop }) {
  const found = [];
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length) {
    if (shouldStop?.()) break;
    const { dir, depth } = stack.pop();
    if (depth > maxDepth || SKIP.has(dir)) continue;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    onProgress?.({ current: dir });

    const names = new Set(entries.map((e) => e.name));
    const hit = isMatch(dir, names, entries);
    if (hit) {
      found.push(hit);
      continue; // do not descend into what we just identified
    }

    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') && !['.venv', '.virtualenvs'].includes(e.name)) continue;
      stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return found;
}

// ── Python ───────────────────────────────────────────────────────────────────

/** The interpreter version recorded in a venv's own config. */
async function venvVersion(dir) {
  try {
    const cfg = await fsp.readFile(path.join(dir, 'pyvenv.cfg'), 'utf8');
    return cfg.match(/^version(?:_info)?\s*=\s*(.+)$/m)?.[1].trim() || '';
  } catch {
    return '';
  }
}

export async function condaEnvs(home = HOME) {
  const roots = ['anaconda3', 'miniconda3', 'miniforge3', 'opt/anaconda3', 'opt/miniconda3']
    .map((r) => path.join(home, r));
  const out = [];
  for (const root of roots) {
    try {
      await fsp.access(root);
    } catch {
      continue;
    }
    out.push({ path: root, name: `${path.basename(root)} (base)`, kind: 'conda' });
    try {
      const envs = await fsp.readdir(path.join(root, 'envs'), { withFileTypes: true });
      for (const e of envs) {
        if (e.isDirectory()) out.push({ path: path.join(root, 'envs', e.name), name: e.name, kind: 'conda' });
      }
    } catch {
      /* no envs folder */
    }
  }
  return out;
}

export async function pyenvVersions(home = HOME) {
  const root = path.join(home, '.pyenv/versions');
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ path: path.join(root, e.name), name: e.name, kind: 'pyenv' }));
  } catch {
    return [];
  }
}

/** Interpreters on PATH that are not part of an environment we already list. */
export async function systemPythons() {
  const out = await sh('/bin/zsh', ['-lc', 'which -a python3 python3.11 python3.12 python3.13 2>/dev/null']);
  const seen = new Set();
  const found = [];
  for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line.includes('/.pyenv/') || line.includes('/anaconda') || line.includes('/miniconda')) continue;
    const real = await fsp.realpath(line).catch(() => line);
    if (seen.has(real)) continue;
    seen.add(real);
    const version = (await sh(line, ['--version'], { timeout: 4000 })).trim();
    found.push({ path: line, name: version || path.basename(line), kind: 'system', version, size: null });
  }
  return found;
}

export async function scanPython(onProgress, shouldStop, root = HOME) {
  const venvs = await findMarkers(root, {
    shouldStop,
    onProgress,
    isMatch: (dir, names) =>
      names.has('pyvenv.cfg') ? { path: dir, name: path.basename(path.dirname(dir)) || path.basename(dir), kind: 'venv' } : null,
  });

  // Only the real home carries conda and pyenv installs; a fixture root is
  // scanned for virtualenvs alone, which keeps the tests hermetic.
  const managed = root === HOME ? [...(await condaEnvs()), ...(await pyenvVersions())] : [];
  const sized = await pool([...venvs, ...managed], 4, async (env) => {
    if (shouldStop?.()) return null;
    onProgress?.({ current: env.path });
    const { size } = await dirSize(env.path);
    let used = 0;
    try {
      used = (await fsp.stat(env.path)).mtimeMs;
    } catch { /* unreadable */ }
    return { ...env, size, lastUsed: used, version: env.kind === 'venv' ? await venvVersion(env.path) : '' };
  });

  const envs = sized.filter(Boolean);
  if (root === HOME) envs.push(...(await systemPythons()));
  envs.sort((a, b) => (b.size || 0) - (a.size || 0));
  return { envs, total: envs.reduce((s, e) => s + (e.size || 0), 0), count: envs.length };
}

// ── Node ─────────────────────────────────────────────────────────────────────

export async function scanNode(onProgress, shouldStop, root = HOME) {
  const dirs = await findMarkers(root, {
    shouldStop,
    onProgress,
    isMatch: (dir, names) =>
      names.has('node_modules')
        ? { path: path.join(dir, 'node_modules'), project: path.basename(dir), projectPath: dir }
        : null,
  });

  const sized = await pool(dirs, 4, async (d) => {
    if (shouldStop?.()) return null;
    onProgress?.({ current: d.path });
    const { size, files } = await dirSize(d.path);
    let packages = 0;
    try {
      const entries = await fsp.readdir(d.path, { withFileTypes: true });
      // Scoped packages live one level deeper, so @scope counts as its contents.
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('@')) {
          packages += (await fsp.readdir(path.join(d.path, e.name)).catch(() => [])).length;
        } else if (!e.name.startsWith('.')) {
          packages += 1;
        }
      }
    } catch { /* unreadable */ }
    let lastUsed = 0;
    try {
      lastUsed = (await fsp.stat(d.path)).mtimeMs;
    } catch { /* unreadable */ }
    return { ...d, size, files, packages, lastUsed };
  });

  const modules = sized.filter(Boolean);
  modules.sort((a, b) => b.size - a.size);

  // The shared stores are separate from per-project folders and often larger.
  const stores = [];
  for (const [label, rel] of root !== HOME ? [] : [
    ['pnpm store', 'Library/pnpm/store'],
    ['npm cache', '.npm/_cacache'],
    ['yarn cache', 'Library/Caches/Yarn'],
  ]) {
    const full = path.join(HOME, rel);
    try {
      await fsp.access(full);
    } catch {
      continue;
    }
    if (shouldStop?.()) break;
    onProgress?.({ current: full });
    const { size } = await dirSize(full);
    if (size > 0) stores.push({ label, path: full, size });
  }

  return {
    modules,
    stores,
    total: modules.reduce((s, m) => s + m.size, 0),
    count: modules.length,
    storeTotal: stores.reduce((s, m) => s + m.size, 0),
  };
}

// ── Docker ───────────────────────────────────────────────────────────────────

const DOCKER_PATHS = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'];

async function dockerBin() {
  for (const p of DOCKER_PATHS) {
    try {
      await fsp.access(p);
      return p;
    } catch { /* next */ }
  }
  return null;
}

export async function scanDocker(onProgress) {
  const bin = await dockerBin();
  if (!bin) return { available: false, reason: 'Docker is not installed', images: [], total: 0 };

  onProgress?.({ current: 'docker images' });
  const raw = await sh(bin, ['image', 'ls', '--all', '--format', '{{json .}}'], { timeout: 25000 });
  if (!raw.trim()) {
    // Either the daemon is down or there genuinely are no images; ask it.
    const info = await sh(bin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 12000 });
    if (!info.trim()) {
      return { available: false, reason: 'Docker is installed but the daemon is not running', images: [], total: 0 };
    }
    return { available: true, images: [], total: 0, reclaimable: 0 };
  }

  const images = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    images.push({
      id: j.ID,
      repository: j.Repository,
      tag: j.Tag,
      name: j.Repository === '<none>' ? `<untagged> ${String(j.ID).slice(0, 12)}` : `${j.Repository}:${j.Tag}`,
      size: parseDockerSize(j.Size),
      sizeText: j.Size,
      created: j.CreatedSince,
      dangling: j.Repository === '<none>' || j.Tag === '<none>',
    });
  }
  images.sort((a, b) => b.size - a.size);

  const df = await sh(bin, ['system', 'df', '--format', '{{json .}}'], { timeout: 15000 });
  let reclaimable = 0;
  for (const line of df.split('\n').filter(Boolean)) {
    try {
      const j = JSON.parse(line);
      if (j.Type === 'Images' && j.Reclaimable) reclaimable = parseDockerSize(j.Reclaimable);
    } catch { /* not the line we want */ }
  }

  return {
    available: true,
    images,
    total: images.reduce((s, i) => s + i.size, 0),
    reclaimable,
    dangling: images.filter((i) => i.dangling).length,
  };
}

/** Docker prints sizes as "1.24GB" / "512MB" / "0B"; turn that into bytes. */
export function parseDockerSize(text) {
  const m = String(text || '').match(/^([\d.]+)\s*([KMGT]?)i?B/i);
  if (!m) return 0;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(Number(m[1]) * (mult[m[2].toUpperCase()] ?? 1));
}

export async function scanDevTools(onProgress, shouldStop) {
  const [python, node, docker] = await Promise.all([
    scanPython(onProgress, shouldStop),
    scanNode(onProgress, shouldStop),
    scanDocker(onProgress),
  ]);
  return { python, node, docker, scannedAt: Date.now() };
}

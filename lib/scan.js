import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TopN, pool, DAY, sh } from './util.js';
import { isContainerOnly, TRASH } from './trash.js';

const HOME = os.homedir();

/** Never descend into these - system-owned, virtual, or hostile to walking. */
const SKIP_ABS = new Set([
  '/System',
  '/private/var/db',
  '/private/var/folders',
  '/private/var/vm',
  '/dev',
  '/net',
  '/Network',
  '/.vol',
  '/.Spotlight-V100',
  '/.fseventsd',
  '/.DocumentRevisions-V100',
  path.join(HOME, 'Library/Mobile Documents'),
  path.join(HOME, 'Library/CloudStorage'),
  path.join(HOME, '.Trash'),
]);

const SKIP_NAMES = new Set([
  '.Spotlight-V100',
  '.fseventsd',
  '.DocumentRevisions-V100',
  '.TemporaryItems',
  '.DS_Store',
]);

/** Directories treated as one opaque item: size is summed, contents are not listed. */
const BUNDLE_EXT = new Set([
  '.app',
  '.framework',
  '.bundle',
  '.photoslibrary',
  '.photolibrary',
  '.fcpbundle',
  '.imovielibrary',
  '.tvlibrary',
  '.aplibrary',
  '.logicx',
  '.sparsebundle',
  '.xcarchive',
  '.dSYM',
  '.pkg',
  '.plugin',
  '.kext',
  '.appex',
  '.docset',
]);

const BUNDLE_NAMES = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'Pods']);

const CATEGORIES = [
  ['Applications', /\.(app|pkg|dmg|ipa)$/i],
  ['Developer', /\.(xcarchive|dsym|framework|a|o|so|dylib|jar|war|whl|gem|deb|rpm)$/i],
  ['Video', /\.(mp4|mov|avi|mkv|m4v|webm|mpg|mpeg|wmv|flv|prproj|fcpbundle)$/i],
  ['Audio', /\.(mp3|wav|aiff|aac|flac|m4a|logicx|band|caf|ogg)$/i],
  ['Photos', /\.(jpg|jpeg|png|gif|heic|raw|cr2|nef|arw|dng|tiff|bmp|webp|psd|ai|sketch|fig)$/i],
  ['Documents', /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|pages|numbers|key|txt|md|csv|json|xml|epub)$/i],
  ['Archives', /\.(zip|tar|gz|bz2|xz|7z|rar|iso|sit|tgz)$/i],
  ['Code', /\.(js|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|swift|kt|php|sh|sql|html|css|scss|vue)$/i],
  ['Virtual machines', /\.(vmdk|vdi|qcow2|img|sparseimage|utm|pvm|bundle)$/i],
];

export function categorize(name) {
  for (const [label, re] of CATEGORIES) if (re.test(name)) return label;
  return 'Other';
}

export function isBundle(name) {
  if (BUNDLE_NAMES.has(name)) return true;
  const ext = path.extname(name).toLowerCase();
  return ext !== '' && BUNDLE_EXT.has(ext);
}

/**
 * Walk a tree iteratively. Calls onFile for every regular file and onBundle for
 * each opaque bundle directory (with its total size). Returns nothing; all the
 * accumulation happens in the callbacks so a single pass feeds every analyzer.
 */
async function walk(root, { onFile, onBundle, onDir, onSkip, shouldStop, skipDirs, skipNames, maxDepth = 24 }) {
  const stack = [{ dir: root, depth: 0, bundle: null }];
  const extraDirs = skipDirs || new Set();
  const extraNames = skipNames || new Set();

  while (stack.length) {
    if (shouldStop?.()) return;
    const { dir, depth, bundle } = stack.pop();
    if (depth > maxDepth) continue;
    if (!bundle && SKIP_ABS.has(dir)) continue;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    onDir?.(dir);

    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (!bundle && SKIP_ABS.has(full)) continue;
        if (extraDirs.has(full) || extraNames.has(entry.name)) {
          onSkip?.(full);
          continue;
        }
        if (!bundle && isBundle(entry.name)) {
          const node = { path: full, name: entry.name, size: 0, mtime: 0, files: 0 };
          onBundle?.(node);
          stack.push({ dir: full, depth: depth + 1, bundle: node });
          continue;
        }
        stack.push({ dir: full, depth: depth + 1, bundle });
        continue;
      }

      if (!entry.isFile()) continue;

      let st;
      try {
        st = await fsp.lstat(full);
      } catch {
        continue;
      }
      // Only count blocks actually on disk: keeps sparse/cloud files honest.
      const size = Math.min(st.size, st.blocks * 512 || st.size);

      if (bundle) {
        bundle.size += size;
        bundle.files += 1;
        if (st.mtimeMs > bundle.mtime) bundle.mtime = st.mtimeMs;
        onFile?.({ path: full, name: entry.name, size, mtime: st.mtimeMs, atime: st.atimeMs, inBundle: true });
        continue;
      }

      onFile?.({ path: full, name: entry.name, size, mtime: st.mtimeMs, atime: st.atimeMs, inBundle: false });
    }
  }
}

/**
 * One pass over `root` that produces every deep-scan panel at once:
 * large files, stale files, category + folder breakdown, duplicate candidates.
 */
export async function deepScan(root, opts = {}) {
  const {
    oldDays = 180,
    minLarge = 100 * 1024 * 1024,
    minOld = 10 * 1024 * 1024,
    minDup = 1024 * 1024,
    topLimit = 150,
    thorough = false,
    onProgress,
    shouldStop,
  } = opts;

  // Fast mode leaves out the churn directories the Cleanup tab already owns.
  // They hold millions of tiny regenerable files and dominate walk time.
  const skipDirs = thorough
    ? new Set()
    : new Set(
        [
          'Library/Caches',
          'Library/Developer',
          'Library/Containers',
          'Library/Group Containers',
          'Library/Application Support/Steam',
          '.cache',
          '.npm',
          '.gradle',
          '.cargo',
          '.rustup',
          'go/pkg',
          'Library/pnpm',
        ].map((d) => path.join(HOME, d)),
      );
  const skipNames = thorough ? new Set() : new Set(['node_modules', '.git', '__pycache__', 'Pods', '.venv']);
  const skipped = [];
  let skippedCount = 0;

  const now = Date.now();
  const oldCutoff = now - oldDays * DAY;

  const large = new TopN(topLimit, (f) => f.size);
  const old = new TopN(topLimit, (f) => f.size);
  const bundles = new TopN(60, (b) => b.size);
  const byCategory = new Map();
  const byFolder = new Map();
  const bySize = new Map();

  let files = 0;
  let totalBytes = 0;
  let oldBytes = 0;
  let oldCount = 0;
  let lastTick = 0;
  let current = root;

  const rootDepth = root.split(path.sep).length;
  const folderOf = (p) => {
    const parts = p.split(path.sep);
    return parts.length > rootDepth ? parts.slice(0, rootDepth + 1).join(path.sep) : root;
  };

  await walk(root, {
    shouldStop,
    skipDirs,
    skipNames,
    onSkip: (d) => { skippedCount += 1; if (skipped.length < 40) skipped.push(d); },
    onDir: (d) => {
      current = d;
      const now2 = Date.now();
      if (onProgress && now2 - lastTick > 120) {
        lastTick = now2;
        onProgress({ files, bytes: totalBytes, current: d });
      }
    },
    onBundle: (b) => bundles.push(b),
    onFile: (f) => {
      files += 1;
      totalBytes += f.size;

      const cat = categorize(f.name);
      byCategory.set(cat, (byCategory.get(cat) || 0) + f.size);
      const folder = folderOf(f.path);
      byFolder.set(folder, (byFolder.get(folder) || 0) + f.size);

      if (f.inBundle) return;

      if (f.size >= minLarge) large.push(f);

      const lastUsed = Math.max(f.mtime, f.atime);
      if (lastUsed < oldCutoff && f.size >= minOld) {
        oldCount += 1;
        oldBytes += f.size;
        old.push({ ...f, lastUsed });
      }

      if (f.size >= minDup) {
        const entry = { path: f.path, mtime: f.mtime };
        const list = bySize.get(f.size);
        if (list) list.push(entry);
        else bySize.set(f.size, [entry]);
      }
    },
  });

  const duplicates = await findDuplicates(bySize, shouldStop);

  return {
    root,
    files,
    totalBytes,
    scannedAt: now,
    oldDays,
    thorough,
    skippedCount,
    skipped,
    large: large.values(),
    old: old.values(),
    oldCount,
    oldBytes,
    bundles: bundles.values(),
    categories: [...byCategory.entries()]
      .map(([name, size]) => ({ name, size }))
      .sort((a, b) => b.size - a.size),
    folders: [...byFolder.entries()]
      .map(([p, size]) => ({ path: p, name: path.basename(p) || p, size }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 30),
    duplicates,
    current,
  };
}

/** Cheap content fingerprint: size + first and last 64 KB. */
async function fingerprint(file) {
  const CHUNK = 64 * 1024;
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const st = await fh.stat();
    const hash = crypto.createHash('md5');
    hash.update(String(st.size));
    const head = Buffer.alloc(Math.min(CHUNK, st.size));
    await fh.read(head, 0, head.length, 0);
    hash.update(head);
    if (st.size > CHUNK * 2) {
      const tail = Buffer.alloc(CHUNK);
      await fh.read(tail, 0, CHUNK, st.size - CHUNK);
      hash.update(tail);
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function findDuplicates(bySize, shouldStop, maxHash = 4000) {
  const groups = [...bySize.entries()]
    .filter(([, entries]) => entries.length > 1)
    .sort((a, b) => b[0] * (b[1].length - 1) - a[0] * (a[1].length - 1));

  const targets = [];
  for (const [size, entries] of groups) {
    if (targets.length >= maxHash) break;
    for (const e of entries) targets.push({ size, path: e.path, mtime: e.mtime });
  }
  const hashes = await pool(targets, 12, async (t) => ({ ...t, hash: await fingerprint(t.path) }));

  const byHash = new Map();
  for (const h of hashes) {
    if (!h?.hash) continue;
    const list = byHash.get(h.hash);
    if (list) list.push(h);
    else byHash.set(h.hash, [h]);
  }

  return [...byHash.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      // Newest first, so the UI can offer "keep the newest, select the rest".
      const sorted = [...g].sort((a, b) => b.mtime - a.mtime);
      return {
        size: sorted[0].size,
        count: sorted.length,
        wasted: sorted[0].size * (sorted.length - 1),
        name: path.basename(sorted[0].path),
        paths: sorted.map((x) => x.path),
        mtimes: sorted.map((x) => x.mtime),
      };
    })
    .sort((a, b) => b.wasted - a.wasted)
    .slice(0, 120);
}

/** Recursive size of one directory, tolerant of permission errors. */
export async function dirSize(dir) {
  let total = 0;
  let files = 0;
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = await fsp.lstat(full);
        total += Math.min(st.size, st.blocks * 512 || st.size);
        files += 1;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* unreadable file - skip */
      }
    }
  }
  return { size: total, files, newest };
}

/**
 * Known-safe reclaimable locations. Each entry is a real directory whose
 * contents macOS or the tool that owns it will rebuild on demand.
 */
const JUNK_TARGETS = [
  { label: 'User caches', dir: 'Library/Caches', group: 'System junk', safety: 'safe' },
  { label: 'User logs', dir: 'Library/Logs', group: 'System junk', safety: 'safe' },
  { label: 'Saved application state', dir: 'Library/Saved Application State', group: 'System junk', safety: 'safe' },
  { label: 'Crash reports', dir: 'Library/Application Support/CrashReporter', group: 'System junk', safety: 'safe' },
  { label: 'Mail downloads', dir: 'Library/Containers/com.apple.mail/Data/Library/Mail Downloads', group: 'Mail', safety: 'review' },
  { label: 'Xcode DerivedData', dir: 'Library/Developer/Xcode/DerivedData', group: 'Developer', safety: 'safe' },
  { label: 'Xcode archives', dir: 'Library/Developer/Xcode/Archives', group: 'Developer', safety: 'review' },
  { label: 'iOS device support', dir: 'Library/Developer/Xcode/iOS DeviceSupport', group: 'Developer', safety: 'safe' },
  { label: 'watchOS device support', dir: 'Library/Developer/Xcode/watchOS DeviceSupport', group: 'Developer', safety: 'safe' },
  { label: 'CoreSimulator caches', dir: 'Library/Developer/CoreSimulator/Caches', group: 'Developer', safety: 'safe' },
  { label: 'Simulator devices', dir: 'Library/Developer/CoreSimulator/Devices', group: 'Developer', safety: 'review' },
  { label: 'Xcode previews', dir: 'Library/Developer/Xcode/UserData/Previews', group: 'Developer', safety: 'safe' },
  { label: 'npm cache', dir: '.npm/_cacache', group: 'Developer', safety: 'safe' },
  { label: 'pnpm store', dir: 'Library/pnpm/store', group: 'Developer', safety: 'review' },
  { label: 'yarn cache', dir: 'Library/Caches/Yarn', group: 'Developer', safety: 'safe' },
  { label: 'Homebrew cache', dir: 'Library/Caches/Homebrew', group: 'Developer', safety: 'safe' },
  { label: 'pip cache', dir: 'Library/Caches/pip', group: 'Developer', safety: 'safe' },
  { label: 'Go module cache', dir: 'go/pkg/mod/cache', group: 'Developer', safety: 'safe' },
  { label: 'Cargo registry cache', dir: '.cargo/registry/cache', group: 'Developer', safety: 'safe' },
  { label: 'Gradle caches', dir: '.gradle/caches', group: 'Developer', safety: 'safe' },
  { label: 'Docker data', dir: 'Library/Containers/com.docker.docker/Data/vms', group: 'Developer', safety: 'danger' },
  { label: 'Generic dot-cache', dir: '.cache', group: 'Developer', safety: 'safe' },
  { label: 'Trash', dir: '.Trash', group: 'Trash', safety: 'safe' },
];

export async function scanJunk(onProgress, shouldStop) {
  const items = [];
  await pool(JUNK_TARGETS, 6, async (t) => {
    if (shouldStop?.()) return;
    const full = path.join(HOME, t.dir);
    try {
      const st = await fsp.stat(full);
      if (!st.isDirectory()) return;
    } catch {
      return;
    }
    onProgress?.({ current: full });
    const { size, files, newest } = await dirSize(full);
    // How this location must be cleaned: the Trash needs Finder, macOS-owned
    // folders can only have their contents emptied, the rest can just move.
    const mode = full === TRASH ? 'emptyTrash' : isContainerOnly(full) ? 'empty' : 'move';
    if (size > 0) items.push({ ...t, path: full, size, files, newest, mode });
  });
  items.sort((a, b) => b.size - a.size);
  const total = items.reduce((s, i) => s + i.size, 0);
  const reclaimable = items.filter((i) => i.safety === 'safe').reduce((s, i) => s + i.size, 0);
  return { items, total, reclaimable, scannedAt: Date.now() };
}

const APP_DIRS = ['/Applications', '/Applications/Utilities', path.join(HOME, 'Applications')];

/**
 * Batch Spotlight lookup: one `mdls` call returns two lines per path, in the
 * same order they were passed.
 */
async function spotlightAppMeta(paths) {
  if (!paths.length) return [];
  const out = await sh('mdls', ['-name', 'kMDItemLastUsedDate', '-name', 'kMDItemVersion', ...paths], {
    timeout: 30000,
  });
  const lines = out.split('\n').filter((l) => /^kMDItem/.test(l));
  const meta = [];
  for (let i = 0; i < lines.length; i += 2) {
    const used = lines[i]?.split('=')[1]?.trim() ?? '(null)';
    const ver = lines[i + 1]?.split('=')[1]?.trim() ?? '(null)';
    const t = used === '(null)' ? 0 : Date.parse(used.replace(' +0000', 'Z').replace(' ', 'T'));
    meta.push({
      lastUsed: Number.isFinite(t) ? t : 0,
      version: ver === '(null)' ? '' : ver.replace(/^"|"$/g, ''),
    });
  }
  return meta;
}

/** Installed apps with size and last-used date. */
export async function scanApps(onProgress, shouldStop) {
  const found = [];
  for (const dir of APP_DIRS) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.name.endsWith('.app')) continue;
      found.push({ name: e.name.replace(/\.app$/, ''), path: path.join(dir, e.name) });
    }
  }

  // One Spotlight call for every app: real "last opened" dates and versions,
  // which beats atime and works with binary Info.plist files.
  const meta = await spotlightAppMeta(found.map((a) => a.path));

  const apps = await pool(found, 6, async (app, i) => {
    if (shouldStop?.()) return null;
    onProgress?.({ current: app.path });
    const { size, files } = await dirSize(app.path);
    let installed = 0;
    let lastUsed = 0;
    try {
      const st = await fsp.stat(app.path);
      installed = st.birthtimeMs || st.ctimeMs;
      lastUsed = Math.max(st.atimeMs, st.mtimeMs);
    } catch {
      /* unreadable bundle - fall back to Spotlight values only */
    }
    const m = meta[i] || {};
    return {
      ...app,
      size,
      files,
      lastUsed: m.lastUsed || lastUsed,
      installed,
      version: m.version || '',
    };
  });

  const done = apps.filter(Boolean);
  done.sort((a, b) => b.size - a.size);
  return {
    apps: done,
    total: done.reduce((s, a) => s + a.size, 0),
    count: done.length,
    scannedAt: Date.now(),
  };
}

/** Top-level storage map of the home folder, one level deep. */
export async function homeMap(onProgress, shouldStop) {
  let entries;
  try {
    entries = await fsp.readdir(HOME, { withFileTypes: true });
  } catch {
    return { items: [], total: 0 };
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && e.name !== '.Trash')
    .map((e) => path.join(HOME, e.name));

  // Folders report as they finish: the map fills in instead of sitting blank
  // for the minutes a full home walk takes.
  const items = await pool(dirs, 4, async (d) => {
    if (shouldStop?.()) return null;
    onProgress?.({ current: d });
    const { size, files } = await dirSize(d);
    const item = { path: d, name: path.basename(d), size, files };
    onProgress?.({ current: d, item });
    return item;
  });

  const measured = items.filter(Boolean);
  measured.sort((a, b) => b.size - a.size);
  return { items: measured, total: measured.reduce((s, i) => s + i.size, 0), scannedAt: Date.now() };
}

/** Very large files anywhere, using Spotlight - near-instant when indexed. */
export async function spotlightLarge(minBytes = 1024 * 1024 * 1024, limit = 200) {
  const out = await sh(
    'mdfind',
    ['-onlyin', HOME, `kMDItemFSSize > ${minBytes}`],
    { timeout: 25000 },
  );
  const paths = out.split('\n').filter(Boolean).slice(0, limit * 2);
  const stats = await pool(paths, 16, async (p) => {
    try {
      const st = await fsp.lstat(p);
      if (!st.isFile()) return null;
      return {
        path: p,
        name: path.basename(p),
        size: Math.min(st.size, st.blocks * 512 || st.size),
        mtime: st.mtimeMs,
        atime: st.atimeMs,
      };
    } catch {
      return null;
    }
  });
  return stats.filter(Boolean).sort((a, b) => b.size - a.size).slice(0, limit);
}

export function pathExists(p) {
  return fs.existsSync(p);
}

export { HOME };

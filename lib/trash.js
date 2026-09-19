import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './util.js';
import { logInfo, logWarn, logError } from './log.js';

const HOME = os.homedir();
const TRASH = path.join(HOME, '.Trash');
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Paths this tool refuses to touch, ever. Deleting any of these breaks the
 * account or the OS, so they are rejected before any filesystem call happens.
 */
const PROTECTED = new Set(
  [
    '/',
    '/System',
    '/Library',
    '/Applications',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/var',
    '/private',
    '/Users',
    '/Volumes',
    HOME,
    path.join(HOME, 'Library'),
    path.join(HOME, 'Documents'),
    path.join(HOME, 'Desktop'),
    path.join(HOME, 'Downloads'),
    path.join(HOME, 'Pictures'),
    path.join(HOME, 'Movies'),
    path.join(HOME, 'Music'),
    path.join(HOME, 'Applications'),
  ].map((p) => path.resolve(p)),
);

/**
 * Standard folders macOS will not let ANY process move or delete — `mv` and
 * Finder fail on them too. Their contents are fair game; the folder itself is
 * not. Asking to move one is answered with a pointer to the right operation
 * rather than a bare EPERM.
 */
const CONTAINER_ONLY = new Set(
  [
    'Library/Caches',
    'Library/Logs',
    'Library/Saved Application State',
    'Library/Preferences',
    'Library/Application Support',
    'Library/Containers',
    'Library/Group Containers',
    'Library/Developer',
    'Library/Mail',
    'Library/Messages',
    'Library/Safari',
  ].map((d) => path.join(HOME, d)),
);

export function isContainerOnly(target) {
  const p = path.resolve(target);
  return CONTAINER_ONLY.has(p) || p === TRASH;
}

/** A user-installed app bundle sitting directly in /Applications. */
function isUserApp(p) {
  return /^\/Applications\/[^/]+\.app$/.test(p);
}

export function isProtected(target) {
  const p = path.resolve(target);
  if (PROTECTED.has(p)) return true;
  if (p === TRASH) return true;
  // Uninstalling an app is the one thing allowed outside home. System apps live
  // in /System/Applications, which stays blocked by the rule below.
  if (isUserApp(p)) return false;
  // Anything else outside the home folder is off-limits: no system-wide deletes.
  if (!p.startsWith(`${HOME}${path.sep}`)) return true;
  return false;
}

// ── The trashItem helper ─────────────────────────────────────────────────────

/**
 * Locate the `mptrash` helper: next to the bundled server inside MacPuffin.app,
 * or in native/build when running from the repo. Without it we fall back to
 * rename(2), which works but produces Trash items with no "Put Back".
 */
function findHelper() {
  const candidates = [
    path.resolve(LIB_DIR, '../../mptrash'), // MacPuffin.app/Contents/Resources/mptrash
    path.resolve(LIB_DIR, '../native/build/mptrash'), // repo checkout
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

const HELPER = findHelper();
logInfo('trash.helper', { path: HELPER, mode: HELPER ? 'FileManager.trashItem' : 'rename fallback' });

/** argv has a hard size limit; move in batches well under it. */
const BATCH = 400;

async function helperTrash(paths) {
  const out = [];
  for (let i = 0; i < paths.length; i += BATCH) {
    const chunk = paths.slice(i, i + BATCH);
    const stdout = await sh(HELPER, chunk, { timeout: 120000 });
    try {
      out.push(...JSON.parse(stdout));
    } catch {
      // Helper produced nothing usable — report the whole chunk as failed so
      // the caller can fall back rather than silently losing results.
      out.push(...chunk.map((p) => ({ path: p, ok: false, error: 'helper returned no result' })));
    }
  }
  return out;
}

async function uniqueTrashName(base) {
  let candidate = path.join(TRASH, base);
  let n = 1;
  for (;;) {
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    candidate = path.join(TRASH, `${stem} ${n}${ext}`);
    n += 1;
  }
}

/**
 * Ask Finder to trash a path.
 *
 * macOS protects signed application bundles: since Ventura, deleting one
 * requires the "App Management" privilege, which an ad-hoc signed tool does not
 * hold — the attempt comes back as EACCES no matter who owns the files. Finder
 * always holds that privilege and prompts for an administrator password when
 * the bundle needs one, so app removal is delegated to it.
 *
 * The path is already constrained to `/Applications/<name>.app` by isProtected;
 * quotes and backslashes are escaped so the name cannot break out of the
 * AppleScript string.
 */
async function finderTrash(target) {
  const p = path.resolve(target);
  const literal = p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await sh('osascript', ['-e', `tell application "Finder" to delete POSIX file "${literal}"`], {
    timeout: 120000,
  });
  // Finder reports success in its own dialect; the filesystem is the honest
  // answer, so check whether the item actually left.
  try {
    await fsp.lstat(p);
    return { path: p, ok: false, error: 'blocked by macOS App Management' };
  } catch {
    logInfo('trash.finder', { path: p });
    return { path: p, ok: true, dest: path.join(TRASH, path.basename(p)), viaFinder: true };
  }
}

/** Fallback path: plain rename into ~/.Trash. No "Put Back" metadata. */
async function renameToTrash(p) {
  await fsp.mkdir(TRASH, { recursive: true });
  const dest = await uniqueTrashName(path.basename(p));
  try {
    await fsp.rename(p, dest);
    return { path: p, ok: true, dest };
  } catch (err) {
    if (err.code !== 'EXDEV') return { path: p, ok: false, error: err.code || String(err) };
  }
  try {
    await fsp.cp(p, dest, { recursive: true, force: true, preserveTimestamps: true });
    await fsp.rm(p, { recursive: true, force: true });
    return { path: p, ok: true, dest };
  } catch (err) {
    return { path: p, ok: false, error: err.code || String(err) };
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Move a batch of paths to the Trash. Nothing is ever unlinked outright, so
 * every action here stays recoverable until the Trash is emptied.
 */
/**
 * @param targets paths to move
 * @param opts.useHelper set false to force the rename(2) fallback, which is the
 *        path taken when the bundled helper is missing — worth being able to
 *        exercise deliberately rather than only by accident.
 */
export async function trashPaths(targets, opts = {}) {
  const useHelper = opts.useHelper !== false && Boolean(HELPER);
  const resolved = targets.map((t) => path.resolve(t));
  const results = new Map();
  const movable = [];

  for (const p of resolved) {
    if (isContainerOnly(p)) {
      results.set(p, {
        path: p,
        ok: false,
        error: 'macOS protects this folder itself — empty its contents instead',
      });
      logWarn('trash.refused', { path: p, reason: 'container-only folder' });
      continue;
    }
    if (isProtected(p)) {
      results.set(p, { path: p, ok: false, error: 'protected path' });
      logWarn('trash.refused', { path: p, reason: 'protected path' });
      continue;
    }
    movable.push(p);
  }

  // Sizes are read before the move; directories stay unmeasured on purpose,
  // since walking a multi-million-file cache costs more than the move itself.
  const sizes = new Map();
  const dirs = new Set();
  const present = [];
  for (const p of movable) {
    try {
      const st = await fsp.lstat(p);
      if (st.isDirectory()) dirs.add(p);
      else sizes.set(p, Math.min(st.size, st.blocks * 512 || st.size));
      present.push(p);
    } catch (err) {
      results.set(p, { path: p, ok: false, error: 'not found' });
      logWarn('trash.missing', { path: p, code: err.code });
    }
  }

  let raw = [];
  if (present.length) {
    raw = useHelper ? await helperTrash(present) : [];
    // Anything the helper could not do gets one attempt via rename.
    const retry = useHelper ? raw.filter((r) => !r.ok).map((r) => r.path) : present;
    if (retry.length) {
      const fallback = await Promise.all(retry.map(renameToTrash));
      const byPath = new Map(fallback.map((f) => [f.path, f]));
      raw = useHelper ? raw.map((r) => (r.ok ? r : byPath.get(r.path) || r)) : fallback;
    }

    // Application bundles that both routes refused are almost always blocked by
    // App Management rather than by ownership. Finder can do what we cannot.
    const blockedApps = raw.filter((r) => !r.ok && isUserApp(r.path));
    if (blockedApps.length) {
      logWarn('trash.appBlocked', { paths: blockedApps.map((r) => r.path), retryVia: 'Finder' });
      const viaFinder = new Map();
      for (const r of blockedApps) viaFinder.set(r.path, await finderTrash(r.path));
      raw = raw.map((r) => viaFinder.get(r.path) || r);
    }
  }

  for (const r of raw) {
    const isDir = dirs.has(r.path);
    const entry = {
      path: r.path,
      ok: r.ok,
      dest: r.dest,
      error: r.ok ? undefined : r.error,
      isDir,
      size: isDir ? null : sizes.get(r.path) ?? null,
    };
    results.set(r.path, entry);
    if (r.ok) logInfo('trash.moved', { path: r.path, dest: r.dest, isDir, size: entry.size });
    else logError('trash.failed', { path: r.path, error: r.error });
  }

  return resolved.map((p) => results.get(p) || { path: p, ok: false, error: 'unknown' });
}

export async function moveToTrash(target) {
  const [res] = await trashPaths([target]);
  return res;
}

/**
 * Empty a directory's contents but keep the directory itself — the correct
 * operation for cache folders, which macOS protects and apps expect to exist.
 */
export async function emptyDirToTrash(dir) {
  const p = path.resolve(dir);
  if (!p.startsWith(`${HOME}${path.sep}`) && p !== TRASH) {
    return { path: p, ok: false, error: 'outside home' };
  }
  let entries;
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch (err) {
    logError('empty.failed', { dir: p, code: err.code });
    return { path: p, ok: false, error: err.code || String(err), moved: 0, errorCount: 1, errors: [] };
  }

  const children = entries.map((e) => path.join(p, e.name));
  const results = await trashPaths(children);
  const okResults = results.filter((r) => r.ok);
  const errors = results.filter((r) => !r.ok).map((r) => ({ path: r.path, error: r.error }));

  const out = {
    path: p,
    ok: errors.length < results.length || results.length === 0,
    moved: okResults.length,
    freed: okResults.reduce((s, r) => s + (r.size || 0), 0),
    unsized: okResults.filter((r) => r.size === null).length,
    errors: errors.slice(0, 20),
    errorCount: errors.length,
  };
  logInfo('empty.done', { dir: p, entries: children.length, moved: out.moved, failed: out.errorCount });
  return out;
}

export async function trashMany(paths) {
  const results = await trashPaths(paths);
  const failed = results.filter((r) => !r.ok).map((r) => ({ path: r.path, error: r.error }));
  const out = {
    ok: results.filter((r) => r.ok).length,
    failed,
    // Only files carry a byte count; directories report `unsized` instead.
    freed: results.reduce((s, r) => s + (r.ok && r.size ? r.size : 0), 0),
    unsized: results.filter((r) => r.ok && r.size === null).length,
    results,
  };
  logInfo('trash.batch', { requested: paths.length, ok: out.ok, failed: failed.length });
  return out;
}

/**
 * Empty the Trash through Finder. Done via AppleScript on purpose: Finder holds
 * the privileges for it, so this works without granting Full Disk Access, and
 * it is the same operation as the Finder menu item. It is irreversible.
 */
export async function emptyTrash() {
  logWarn('trash.empty.requested', {});
  const out = await sh('osascript', ['-e', 'tell application "Finder" to empty the trash'], {
    timeout: 120000,
  });
  const error = /error|not authorized|Not authorized/.test(out) ? out.trim() : null;
  if (error) logError('trash.empty.failed', { output: error });
  else logInfo('trash.empty.done', {});
  return { ok: !error, error };
}

/** Reveal a path in Finder — or open the Trash itself, which has no enclosing
 *  folder worth revealing. */
export async function reveal(target) {
  const p = path.resolve(target);
  await sh('open', p === TRASH ? [p] : ['-R', p]);
  return { ok: true };
}

export { TRASH, HELPER };

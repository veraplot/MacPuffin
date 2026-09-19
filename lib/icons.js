import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sh } from './util.js';

const CACHE_DIR = path.join(os.homedir(), 'Library/Caches/MacPuffin/icons');
const SIZE = 64;

/** Bundles already known to have no usable icon - asked once, not every tick. */
const misses = new Set();

try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch {
  /* icons are cosmetic - never let this break a scan */
}

/** Only real app bundles, and only where apps actually live. */
export function isAppBundle(target) {
  const p = path.resolve(target);
  if (!p.endsWith('.app')) return false;
  const roots = ['/Applications', '/System/Applications', '/System/Library', '/Library',
    path.join(os.homedir(), 'Applications')];
  if (!roots.some((r) => p === r || p.startsWith(`${r}/`))) return false;
  // Simulator runtimes ship bundles whose icons are not extractable; asking
  // for them only produces noise.
  if (p.includes('/CoreSimulator/')) return false;
  return fs.existsSync(path.join(p, 'Contents'));
}

/** The .icns a bundle declares, or the first one it ships. */
async function findIcns(appPath) {
  const resources = path.join(appPath, 'Contents/Resources');
  const declared = (await sh('plutil', ['-extract', 'CFBundleIconFile', 'raw', path.join(appPath, 'Contents/Info.plist')], { timeout: 4000 })).trim();
  if (declared && !declared.startsWith('<')) {
    const name = declared.endsWith('.icns') ? declared : `${declared}.icns`;
    const candidate = path.join(resources, name);
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      /* declared but missing - fall through to the directory scan */
    }
  }
  try {
    const entries = await fsp.readdir(resources);
    const icns = entries.find((e) => e.toLowerCase().endsWith('.icns'));
    if (icns) return path.join(resources, icns);
  } catch {
    /* unreadable Resources */
  }
  return null;
}

/**
 * PNG bytes for an app's icon, cached on disk. Returns null when the bundle has
 * no icon, which the UI renders as a blank slot rather than a broken image.
 */
export async function appIcon(appPath) {
  const p = path.resolve(appPath);
  if (!isAppBundle(p)) return null;

  if (misses.has(p)) return null;

  const key = crypto.createHash('md5').update(p).digest('hex');
  const cached = path.join(CACHE_DIR, `${key}.png`);
  try {
    return await fsp.readFile(cached);
  } catch {
    /* not cached yet */
  }

  const icns = await findIcns(p);
  if (!icns) {
    misses.add(p);
    return null;
  }

  await sh('sips', ['-s', 'format', 'png', '--resampleWidth', String(SIZE), icns, '--out', cached], {
    timeout: 8000,
  });
  try {
    return await fsp.readFile(cached);
  } catch {
    misses.add(p);
    return null;
  }
}

export { CACHE_DIR };

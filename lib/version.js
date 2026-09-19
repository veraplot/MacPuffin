import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one place the version is defined is package.json. Everything else — the
 * app bundle's Info.plist, the disk image name, the sidebar, the About panel —
 * reads it from here, so a release never ships two different numbers.
 */
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');

let version = '0.0.0';
try {
  version = JSON.parse(fs.readFileSync(PKG, 'utf8')).version || version;
} catch {
  // Running from somewhere without the manifest: report a placeholder rather
  // than crashing the server over a cosmetic field.
}

export const VERSION = version;

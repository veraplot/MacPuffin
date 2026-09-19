import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), 'Library/Logs/MacPuffin');
const FILE = path.join(DIR, 'macpuffin.log');

try {
  fs.mkdirSync(DIR, { recursive: true });
} catch {
  /* logging must never break the app */
}

/**
 * Append one structured line to ~/Library/Logs/MacPuffin/macpuffin.log and echo
 * it to stdout. Every destructive action goes through here so failures are
 * always diagnosable after the fact.
 */
export function log(level, event, detail = {}) {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${event} ${JSON.stringify(detail)}`;
  process.stdout.write(`${line}\n`);
  try {
    fs.appendFileSync(FILE, `${line}\n`);
  } catch {
    /* disk full or no permission - keep serving */
  }
}

export const logInfo = (event, detail) => log('info', event, detail);
export const logWarn = (event, detail) => log('warn', event, detail);
export const logError = (event, detail) => log('error', event, detail);

/** Last `n` lines of the log, for the in-app log viewer. */
export function tail(n = 300) {
  try {
    const text = fs.readFileSync(FILE, 'utf8');
    return text.trimEnd().split('\n').slice(-n);
  } catch {
    return [];
  }
}

export const LOG_FILE = FILE;

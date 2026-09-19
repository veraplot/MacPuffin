import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logError } from './log.js';

const DIR = path.join(os.homedir(), 'Library/Logs/MacPuffin');
const FILE = path.join(DIR, 'crashes.json');
const KEEP = 20;
const HOME = os.homedir();

/**
 * Paths are the one part of a crash report that can carry personal detail — a
 * client name in a folder, a project under NDA. The home folder is collapsed to
 * `~` and the account name is removed before a report is ever shown, let alone
 * shared.
 */
export function redact(text) {
  return String(text ?? '')
    .split(HOME).join('~')
    .split(os.userInfo().username).join('user');
}

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list.slice(-KEEP), null, 2));
  } catch {
    /* a crash report that cannot be saved must not itself crash anything */
  }
}

/** Record a critical error. Returns the stored entry. */
export function record({ kind, message, stack, where, context }) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    kind: kind || 'error',
    where: where || 'server',
    message: redact(message || 'Unknown error'),
    stack: redact(stack || '').split('\n').slice(0, 12).join('\n'),
    context: context ? redact(JSON.stringify(context)).slice(0, 500) : '',
  };
  const list = read();
  // Do not let the same fault fill the file: collapse repeats of one message.
  const twin = list.find((c) => c.message === entry.message && c.where === entry.where);
  if (twin) {
    twin.count = (twin.count || 1) + 1;
    twin.at = entry.at;
    write(list);
    return twin;
  }
  entry.count = 1;
  list.push(entry);
  write(list);
  logError('crash.recorded', { where: entry.where, message: entry.message });
  return entry;
}

export function list() {
  return read().slice().reverse();
}

export function clear() {
  write([]);
}

/**
 * The text of a shareable report: what broke, plus the machine facts needed to
 * reproduce it. No file names, no paths beyond the redacted stack, nothing
 * about what was scanned.
 */
export function reportBody(crash, hw) {
  const lines = [
    '### What happened',
    '',
    '<!-- Anything you were doing when this appeared is useful here. -->',
    '',
    '### Error',
    '',
    '```',
    `${crash.kind}: ${crash.message}`,
    crash.stack || '(no stack)',
    '```',
    '',
    `Occurrences: ${crash.count || 1}`,
    `First seen: ${crash.at}`,
    `Where: ${crash.where}`,
    '',
    '### Machine',
    '',
    '| | |',
    '|---|---|',
    `| MacPuffin | ${hw?.version || '?'} |`,
    `| Model | ${hw?.model || '?'} |`,
    `| Chip | ${hw?.cpu || '?'} (${hw?.cores || '?'} cores) |`,
    `| Architecture | ${hw?.arch || '?'}${hw?.translated ? ' (running under Rosetta)' : ' (native)'} |`,
    `| Memory | ${hw?.memTotal ? `${Math.round(hw.memTotal / 1024 ** 3)} GB` : '?'} |`,
    `| macOS | ${hw?.osName || '?'} ${hw?.osVersion || ''} (${hw?.osBuild || '?'}) |`,
    `| Node | ${process.version} |`,
    '',
    '<sub>Reported from MacPuffin. Paths were replaced with `~` before this was shown.</sub>',
  ];
  return lines.join('\n');
}

export { FILE as CRASH_FILE };

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Run a shell binary, never throw. Returns stdout ('' on failure). */
export async function sh(cmd, args = [], opts = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeout ?? 20000,
      ...opts,
    });
    return stdout;
  } catch (err) {
    return err.stdout || '';
  }
}

export function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Fixed-size min-heap keeping the N largest items by `score`. */
export class TopN {
  constructor(limit, score) {
    this.limit = limit;
    this.score = score;
    this.heap = [];
  }

  push(item) {
    const h = this.heap;
    if (h.length < this.limit) {
      h.push(item);
      this.#up(h.length - 1);
      return;
    }
    if (this.score(item) <= this.score(h[0])) return;
    h[0] = item;
    this.#down(0);
  }

  values() {
    return [...this.heap].sort((a, b) => this.score(b) - this.score(a));
  }

  #up(i) {
    const h = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.score(h[i]) >= this.score(h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  #down(i) {
    const h = this.heap;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let s = i;
      if (l < h.length && this.score(h[l]) < this.score(h[s])) s = l;
      if (r < h.length && this.score(h[r]) < this.score(h[s])) s = r;
      if (s === i) break;
      [h[i], h[s]] = [h[s], h[i]];
      i = s;
    }
  }
}

/** Run async tasks with a concurrency ceiling. */
export async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

export const DAY = 86400000;

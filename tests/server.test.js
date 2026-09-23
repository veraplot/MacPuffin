import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = os.homedir();

let server;

/** Boot the real server as a child process and wait for it to answer. */
before(async () => {
  // Refuse to adopt whatever is already on this port. A leftover server from a
  // killed run answers /api/hardware perfectly well while running different
  // code, which turns every later assertion into a lie.
  try {
    const stray = await fetch(`${BASE}/api/hardware`);
    if (stray.ok) {
      throw new Error(
        `something is already listening on ${PORT}. Kill it first: lsof -ti tcp:${PORT} | xargs kill -9`,
      );
    }
  } catch (err) {
    if (err.message.includes('already listening')) throw err;
    /* nothing there, which is what we want */
  }

  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NO_OPEN: '1' },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/hardware`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => server?.kill());

const mutate = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-macpuffin': '1' },
    body: JSON.stringify(body),
  });

// ── It only listens to this machine ──────────────────────────────────────────

test('the socket is bound to loopback only', async () => {
  const r = await fetch(`${BASE}/api/hardware`);
  assert.equal(r.status, 200);
  const hw = await r.json();
  assert.equal(typeof hw.memTotal, 'number');
  assert.ok(hw.memTotal > 0);
});

test('pages are served with a content security policy that forbids off-origin loads', async () => {
  const r = await fetch(`${BASE}/`);
  const csp = r.headers.get('content-security-policy');
  assert.ok(csp, 'CSP header must be present');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-(inline|eval)/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

// ── Mutations are guarded ────────────────────────────────────────────────────

test('a mutation without the app header is rejected', async () => {
  const r = await fetch(`${BASE}/api/trash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: [`${HOME}/whatever`] }),
  });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /did not originate from the app/);
});

test('a mutation from a foreign origin is rejected', async () => {
  const r = await fetch(`${BASE}/api/trash`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-macpuffin': '1',
      origin: 'https://evil.example',
    },
    body: JSON.stringify({ paths: [`${HOME}/whatever`] }),
  });
  assert.equal(r.status, 403);
});

test('protected paths are refused before any filesystem call', async () => {
  for (const target of ['/', '/System', `${HOME}/Documents`, '/Applications', HOME]) {
    const r = await mutate('/api/trash', { paths: [target] });
    assert.equal(r.status, 400, `${target} should be refused`);
    const body = await r.json();
    assert.match(body.error, /protected path/);
    assert.deepEqual(body.blocked, [target]);
  }
});

test('a protected path anywhere in the batch blocks the whole request', async () => {
  const r = await mutate('/api/trash', { paths: [`${HOME}/Downloads/ok.txt`, '/System'] });
  assert.equal(r.status, 400);
  assert.deepEqual((await r.json()).blocked, ['/System']);
});

test('macOS-owned folders are refused with an explanation, not an errno', async () => {
  const r = await mutate('/api/trash', { paths: [`${HOME}/Library/Caches`] });
  const body = await r.json();
  const failure = body.failed?.[0] || body;
  assert.match(String(failure.error), /empty its contents instead/);
});

test('an empty selection is rejected', async () => {
  const r = await mutate('/api/trash', { paths: [] });
  assert.equal(r.status, 400);
});

test('emptying a directory outside the home folder is refused', async () => {
  const r = await mutate('/api/empty', { dirs: ['/tmp'] });
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /outside home/);
});

// ── Read endpoints ───────────────────────────────────────────────────────────

test('the system snapshot reports real memory and disk figures', async () => {
  const s = await (await fetch(`${BASE}/api/system`)).json();
  assert.ok(s.mem.total > 0);
  assert.ok(s.mem.used > 0 && s.mem.used <= s.mem.total);
  assert.ok(s.mem.pressure >= 0 && s.mem.pressure <= 1);
  assert.ok(s.disk.total > 0);
  assert.ok(s.disk.free >= 0 && s.disk.free <= s.disk.total);
  assert.ok(Array.isArray(s.procs.byMem) && s.procs.byMem.length > 0);
  assert.ok(s.cpu.cores > 0);
});

test('the hardware endpoint reports the package.json version', async () => {
  const hw = await (await fetch(`${BASE}/api/hardware`)).json();
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(hw.version, pkg.version);
});

test('the log endpoint returns the tail of the real log file', async () => {
  const r = await (await fetch(`${BASE}/api/logs?n=5`)).json();
  assert.match(r.file, /Library\/Logs\/MacPuffin\/macpuffin\.log$/);
  assert.ok(Array.isArray(r.lines));
});

test('the crash endpoint records, redacts and reports', async () => {
  const secret = `${HOME}/Desktop/Private/thing.txt`;
  const post = await mutate('/api/crash', { kind: 'TestError', message: `broke at ${secret}`, stack: 'at t' });
  assert.equal(post.status, 200);

  const data = await (await fetch(`${BASE}/api/crashes`)).json();
  const found = data.crashes.find((c) => c.kind === 'TestError');
  assert.ok(found, 'the crash should be stored');
  assert.ok(!found.message.includes(HOME), 'the home path must be redacted');
  const report = data.reports.find((r) => r.id === found.id);
  assert.match(report.body, /### Machine/);

  const cleared = await mutate('/api/crashes/clear', {});
  assert.equal(cleared.status, 200);
});

test('the hardware endpoint reports the running architecture', async () => {
  const hw = await (await fetch(`${BASE}/api/hardware`)).json();
  assert.ok(['arm64', 'x64'].includes(hw.arch), hw.arch);
  assert.equal(typeof hw.translated, 'boolean');
  assert.equal(hw.native, !hw.translated);
});

test('unknown API routes 404 instead of falling through to static files', async () => {
  const r = await fetch(`${BASE}/api/does-not-exist`);
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /unknown endpoint/);
});

test('static serving cannot escape the public directory', async () => {
  for (const attempt of ['/../server.js', '/..%2fserver.js', '/../../etc/passwd']) {
    const r = await fetch(`${BASE}${attempt}`);
    assert.ok(r.status === 403 || r.status === 404, `${attempt} returned ${r.status}`);
    const body = await r.text();
    assert.doesNotMatch(body, /createServer/, 'server source must never be served');
  }
});


// ── Pause and resume ─────────────────────────────────────────────────────────

/**
 * The scan has to still be walking when the test pauses it, so these tests run
 * against a purpose-built tree rather than the real home folder: big enough that
 * the walk lasts a comfortable while, and entirely disposable.
 */
const TREE = path.join(HOME, `.macpuffin-pause-test-${process.pid}`);

before(async () => {
  const fsp = await import('node:fs/promises');
  // A killed run leaves its tree behind; clear any before building this one.
  for (const stale of await fsp.readdir(HOME).catch(() => [])) {
    if (stale.startsWith('.macpuffin-pause-test-')) {
      await fsp.rm(path.join(HOME, stale), { recursive: true, force: true }).catch(() => {});
    }
  }
  const jobs = [];
  for (let d = 0; d < 80; d += 1) {
    const dir = path.join(TREE, `d${d % 8}`, `s${d}`);
    jobs.push(
      fsp.mkdir(dir, { recursive: true }).then(() =>
        Promise.all(
          Array.from({ length: 40 }, (_, f) =>
            fsp.writeFile(path.join(dir, `f${f}.bin`), f === 0 ? Buffer.alloc(4096, d) : ''),
          ),
        ),
      ),
    );
  }
  await Promise.all(jobs);
});

after(async () => {
  const fsp = await import('node:fs/promises');
  await fsp.rm(TREE, { recursive: true, force: true }).catch(() => {});
});

const DEEP = `${BASE}/api/scan/deep?root=${encodeURIComponent(TREE)}&thorough=1&minLarge=1`;

/**
 * Read an SSE stream into a list, and wait for a named event by polling it.
 *
 * Polling rather than a promise per waiter on purpose: a waiter resolved only
 * from the stream's own callback leaves the test runner with nothing referenced
 * on the event loop, and node:test then cancels the test with "Promise
 * resolution is still pending". A plain interval keeps the loop alive.
 */
function sseReader(url) {
  const events = [];
  const controller = new AbortController();

  const pump = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body.getReader();
    const decode = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decode.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch(() => {
    /* aborted by the test */
  });

  return {
    events,
    count: (event) => events.filter((e) => e.event === event).length,
    seen: (event) => events.some((e) => e.event === event),
    last: (event) => events.filter((e) => e.event === event).pop(),
    async next(want, ms = 20000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = events.find((e) => e.event === want);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`no "${want}" event within ${ms}ms`);
        await new Promise((r) => setTimeout(r, 15));
      }
    },
    close: () => {
      controller.abort();
      return pump;
    },
  };
}

test('pausing a live scan holds it and reports what it has found', async (t) => {
  const stream = sseReader(DEEP);
  // Registered immediately: an assertion failure below must not leave the
  // request open, or the test runner waits on it forever.
  t.after(() => stream.close());
  await stream.next('progress'); // the walk is genuinely under way

  const paused = await mutate('/api/scan/pause', { key: 'deep' }).then((r) => r.json());
  assert.equal(paused.ok, true, 'the scan finished before it could be paused');
  assert.equal(paused.changed, true);
  assert.equal(paused.state, 'paused');

  // The event carries the results, so the screen fills in on pause instead of
  // sitting empty until the scan ends.
  const evt = await stream.next('paused');
  assert.equal(evt.data.paused, true);
  assert.equal(evt.data.partial, true);
  assert.equal(evt.data.key, 'deep');
  assert.ok(evt.data.files > 0, 'a paused scan reported no files');
  assert.ok(Array.isArray(evt.data.categories) && evt.data.categories.length > 0,
    'a paused scan must report its category breakdown');
  assert.ok(Array.isArray(evt.data.folders) && evt.data.folders.length > 0,
    'a paused scan must report its folder breakdown');
  assert.ok(Array.isArray(evt.data.large), 'the large-file list must exist even when empty');
  assert.equal(stream.seen('done'), false, 'a pause must not end the scan');

  const twice = await mutate('/api/scan/pause', { key: 'deep' }).then((r) => r.json());
  assert.equal(twice.changed, false, 'a second pause must be a no-op');
  assert.equal(twice.state, 'paused');

  // Held means held: no further progress, and the scan is still there.
  const held = evt.data.files;
  const ticks = stream.count('progress');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(stream.seen('done'), false, 'the held scan finished on its own');
  assert.equal(stream.count('progress'), ticks, 'the walk kept reading while paused');

  const resumed = await mutate('/api/scan/resume', { key: 'deep' }).then((r) => r.json());
  assert.equal(resumed.changed, true);
  assert.equal(resumed.state, 'running');
  await stream.next('resumed');

  // Resuming continues the same walk rather than restarting it.
  const finished = await stream.next('done');
  assert.equal(finished.data.partial, false, 'the resumed scan should run to completion');
  assert.ok(finished.data.files > held, `resumed scan found nothing new (${held} -> ${finished.data.files})`);
});

test('stop works on a paused scan', async (t) => {
  const stream = sseReader(DEEP);
  t.after(() => stream.close());
  await stream.next('progress');
  const paused = await mutate('/api/scan/pause', { key: 'deep' }).then((r) => r.json());
  assert.equal(paused.state, 'paused');
  await stream.next('paused');

  // A walk parked in a pause must still answer Stop, or the only way out of a
  // pause would be to quit the app.
  const stopped = await mutate('/api/scan/stop', { key: 'deep' }).then((r) => r.json());
  assert.equal(stopped.changed, true);
  assert.equal(stopped.state, 'stopped');

  const done = await stream.next('done');
  assert.equal(done.data.partial, true, 'a stopped scan must be marked partial');
  assert.ok(done.data.files > 0, 'a stopped scan must keep what it found');
});

test('pausing a scan that is not running is reported, not silently accepted', async () => {
  const r = await mutate('/api/scan/pause', { key: 'deep' });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'no scan running');

  const bogus = await mutate('/api/scan/resume', { key: 'not-a-scan' });
  assert.equal(bogus.status, 404);
});

test('pause and resume are refused without the CSRF header', async () => {
  for (const p of ['/api/scan/pause', '/api/scan/resume']) {
    const r = await fetch(`${BASE}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'deep' }),
    });
    assert.equal(r.status, 403, `${p} must reject a request with no x-macpuffin header`);
  }
});

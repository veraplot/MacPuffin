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

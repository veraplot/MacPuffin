import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { bytes, TopN, pool, DAY } from '../lib/util.js';
import { isProtected, isContainerOnly } from '../lib/trash.js';
import { categorize, isBundle } from '../lib/scan.js';

const HOME = os.homedir();

test('bytes() scales units and keeps small values readable', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1024), '1.0 KB');
  assert.equal(bytes(1024 ** 3 * 2.5), '2.5 GB');
  assert.equal(bytes(1024 ** 4), '1.0 TB');
});

test('bytes() refuses to invent a number from bad input', () => {
  assert.equal(bytes(-1), '0 B');
  assert.equal(bytes(NaN), '0 B');
  assert.equal(bytes(Infinity), '0 B');
});

test('TopN keeps exactly the N largest items, in order', () => {
  const top = new TopN(3, (x) => x.size);
  [5, 1, 9, 3, 7, 2].forEach((size) => top.push({ size }));
  assert.deepEqual(
    top.values().map((x) => x.size),
    [9, 7, 5],
  );
});

test('TopN holds fewer than N when fewer were pushed', () => {
  const top = new TopN(10, (x) => x);
  top.push(4);
  top.push(8);
  assert.deepEqual(top.values(), [8, 4]);
});

test('pool() preserves input order despite concurrent completion', async () => {
  const delays = [30, 5, 20, 1, 15];
  const out = await pool(delays, 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
});

test('pool() respects its concurrency ceiling', async () => {
  let running = 0;
  let peak = 0;
  await pool([...Array(12).keys()], 3, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
  });
  assert.ok(peak <= 3, `peak concurrency was ${peak}, expected <= 3`);
});

test('DAY is a day in milliseconds', () => {
  assert.equal(DAY, 24 * 60 * 60 * 1000);
});

// ── Safety rules: the part that decides what may be deleted ──────────────────

test('isProtected() blocks the account and system roots', () => {
  for (const p of ['/', '/System', '/Library', '/usr', '/etc', '/Users', HOME]) {
    assert.equal(isProtected(p), true, `${p} must be protected`);
  }
});

test('isProtected() blocks the standard home folders themselves', () => {
  for (const name of ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music', 'Library']) {
    assert.equal(isProtected(path.join(HOME, name)), true, `~/${name} must be protected`);
  }
});

test('isProtected() blocks anything outside the home folder', () => {
  assert.equal(isProtected('/tmp/whatever'), true);
  assert.equal(isProtected('/Volumes/External/file.txt'), true);
  assert.equal(isProtected('/System/Applications/Calculator.app'), true);
});

test('isProtected() allows ordinary files inside the home folder', () => {
  assert.equal(isProtected(path.join(HOME, 'Downloads/big.dmg')), false);
  assert.equal(isProtected(path.join(HOME, 'Documents/report.pdf')), false);
});

test('isProtected() allows uninstalling a user app but not its innards', () => {
  assert.equal(isProtected('/Applications/Some App.app'), false);
  assert.equal(isProtected('/Applications'), true);
  assert.equal(isProtected('/Applications/Some App.app/Contents'), true);
});

test('isProtected() is not fooled by traversal in the path', () => {
  assert.equal(isProtected(`${HOME}/Downloads/../../../etc/passwd`), true);
  assert.equal(isProtected(`${HOME}/../`), true);
});

test('isContainerOnly() marks the folders macOS refuses to move', () => {
  assert.equal(isContainerOnly(path.join(HOME, 'Library/Caches')), true);
  assert.equal(isContainerOnly(path.join(HOME, 'Library/Logs')), true);
  assert.equal(isContainerOnly(path.join(HOME, 'Library/Containers')), true);
  assert.equal(isContainerOnly(path.join(HOME, '.Trash')), true);
});

test('isContainerOnly() leaves ordinary cache folders movable', () => {
  assert.equal(isContainerOnly(path.join(HOME, 'Library/Caches/Homebrew')), false);
  assert.equal(isContainerOnly(path.join(HOME, 'Library/Developer/Xcode/DerivedData')), false);
  assert.equal(isContainerOnly(path.join(HOME, 'Downloads')), false);
});

// ── Classification ───────────────────────────────────────────────────────────

test('categorize() sorts files by extension', () => {
  assert.equal(categorize('Keynote.app'), 'Applications');
  assert.equal(categorize('holiday.mov'), 'Video');
  assert.equal(categorize('track.flac'), 'Audio');
  assert.equal(categorize('shot.heic'), 'Photos');
  assert.equal(categorize('contract.pdf'), 'Documents');
  assert.equal(categorize('backup.tar.gz'), 'Archives');
  assert.equal(categorize('server.js'), 'Code');
  assert.equal(categorize('disk.qcow2'), 'Virtual machines');
});

test('categorize() falls back to Other for unknown extensions', () => {
  assert.equal(categorize('mystery.zzz'), 'Other');
  assert.equal(categorize('LICENSE'), 'Other');
});

test('categorize() ignores case', () => {
  assert.equal(categorize('PHOTO.JPG'), 'Photos');
  assert.equal(categorize('Movie.MP4'), 'Video');
});

test('isBundle() recognises opaque macOS bundles and dependency folders', () => {
  assert.equal(isBundle('Safari.app'), true);
  assert.equal(isBundle('Photos.photoslibrary'), true);
  assert.equal(isBundle('node_modules'), true);
  assert.equal(isBundle('.git'), true);
  assert.equal(isBundle('Pods'), true);
});

test('isBundle() leaves ordinary folders alone', () => {
  assert.equal(isBundle('Documents'), false);
  assert.equal(isBundle('my.project'), false);
  assert.equal(isBundle('src'), false);
});

// ── Version: one source of truth ─────────────────────────────────────────────

test('the version is read from package.json and nowhere else', async () => {
  const { VERSION } = await import('../lib/version.js');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('the release notes document the current version', async () => {
  const { VERSION } = await import('../lib/version.js');
  const notes = fs.readFileSync(new URL('../RELEASE_NOTES.md', import.meta.url), 'utf8');
  assert.ok(
    notes.includes(`## v${VERSION}`),
    `RELEASE_NOTES.md has no section for v${VERSION} — bump the notes with the version`,
  );
});

test('the build script takes the bundle version from package.json', () => {
  const build = fs.readFileSync(new URL('../build-app.sh', import.meta.url), 'utf8');
  assert.match(build, /VERSION="\$\(node -p "require\(.*package\.json.*\)\.version"\)"/);
  assert.match(build, /CFBundleShortVersionString<\/key><string>\$VERSION</);
  assert.doesNotMatch(build, /CFBundleShortVersionString<\/key><string>\d/, 'version must not be hard-coded');
});

// ── Developer tools ──────────────────────────────────────────────────────────

test('Docker size strings are parsed into bytes', async () => {
  const { parseDockerSize } = await import('../lib/devtools.js');
  assert.equal(parseDockerSize('0B'), 0);
  assert.equal(parseDockerSize('512MB'), 512 * 1024 ** 2);
  assert.equal(parseDockerSize('1.24GB'), Math.round(1.24 * 1024 ** 3));
  assert.equal(parseDockerSize('2GiB'), 2 * 1024 ** 3);
  assert.equal(parseDockerSize('nonsense'), 0);
  assert.equal(parseDockerSize(undefined), 0);
});

test('only serviceable application bundles are offered an icon', async () => {
  const { isAppBundle } = await import('../lib/icons.js');
  assert.equal(isAppBundle('/etc/passwd'), false);
  assert.equal(isAppBundle(path.join(HOME, 'Downloads/evil.app')), false);
  assert.equal(
    isAppBundle('/Library/Developer/CoreSimulator/Volumes/x/Runtimes/y/SpringBoard.app'),
    false,
    'simulator runtimes ship no extractable icon',
  );
});

// ── Crash reports ────────────────────────────────────────────────────────────

test('crash reports replace the home folder and the account name', async () => {
  const { redact } = await import('../lib/crash.js');
  const secret = path.join(HOME, 'Desktop/Client Name/contract.pdf');
  const out = redact(`failed reading ${secret}`);
  assert.ok(out.includes('~/Desktop/'), out);
  assert.ok(!out.includes(HOME), 'the home path must not survive');
  assert.ok(!out.includes(os.userInfo().username), 'the account name must not survive');
});

test('a crash report carries the machine facts and nothing about the scan', async () => {
  const { reportBody } = await import('../lib/crash.js');
  const body = reportBody(
    { kind: 'TypeError', message: 'boom', stack: 'at x', at: '2026-01-01T00:00:00Z', where: 'server', count: 2 },
    { version: '1.0.0', model: 'Mac16,8', cpu: 'Apple M4 Pro', cores: 12, arch: 'arm64', translated: false, memTotal: 25769803776, osName: 'macOS', osVersion: '26.5', osBuild: '25F71' },
  );
  assert.match(body, /TypeError: boom/);
  assert.match(body, /Apple M4 Pro/);
  assert.match(body, /arm64 \(native\)/);
  assert.match(body, /macOS 26\.5/);
  assert.match(body, /Occurrences: 2/);
});

// ── Logging ──────────────────────────────────────────────────────────────────

test('the log file lives under ~/Library/Logs and stays append-only', async () => {
  const { LOG_FILE, logInfo, tail } = await import('../lib/log.js');
  assert.ok(LOG_FILE.startsWith(path.join(HOME, 'Library/Logs')), LOG_FILE);

  const marker = `selftest-${process.pid}-${process.hrtime.bigint()}`;
  const before = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  logInfo('test.marker', { marker });
  const after = fs.statSync(LOG_FILE).size;

  assert.ok(after > before, 'log file should have grown');
  assert.ok(tail(5).some((line) => line.includes(marker)), 'marker should be in the tail');
});

test('log lines carry a timestamp, a level and structured detail', async () => {
  const { logWarn, tail } = await import('../lib/log.js');
  logWarn('test.shape', { n: 1 });
  const line = tail(1)[0];
  assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z WARN {2}test\.shape \{"n":1\}$/);
});

// ── Published assets ─────────────────────────────────────────────────────────

test('no shipped file mentions a client, project or person from the author machine', () => {
  // Screenshots and docs go out publicly. Real folder names from a working Mac
  // carry client and project names, so they must never reach the repository.
  const forbidden = /HIP-DATALAKE|ARKEMA|MyCareer|Safety_Obs|OPENCLASSROOMS|SNPDM|NASPROJECTS|jems-group/i;
  const root = new URL('..', import.meta.url).pathname;
  const check = (rel) => {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) return;
    const text = fs.readFileSync(full, 'utf8');
    assert.ok(!forbidden.test(text), `${rel} names something private`);
  };
  for (const f of ['README.md', 'RELEASE_NOTES.md', 'SECURITY.md', 'CONTRIBUTING.md', 'DESIGN.md']) check(f);
});

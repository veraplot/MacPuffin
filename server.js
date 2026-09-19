import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, hardware } from './lib/system.js';
import { deepScan, scanJunk, scanApps, homeMap, spotlightLarge, HOME } from './lib/scan.js';
import { trashMany, emptyDirToTrash, emptyTrash, reveal, isProtected } from './lib/trash.js';
import { sh } from './lib/util.js';
import { appIcon, isAppBundle } from './lib/icons.js';
import { scanDevTools } from './lib/devtools.js';
import { record as recordCrash, list as listCrashes, clear as clearCrashes, reportBody } from './lib/crash.js';
import { logInfo, logWarn, logError, tail, LOG_FILE } from './lib/log.js';
import { VERSION } from './lib/version.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4780);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** A 1x1 fully transparent PNG, served when a bundle ships no icon. */
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** Results live in memory so switching tabs never re-runs a scan. */
const cache = new Map();
const running = new Map();

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sseOpen(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': open\n\n');
}

function sseSend(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Wrap a long scan in an SSE stream: progress ticks while it walks, one `done`
 * payload at the end. Aborting the request stops the walk.
 */
async function streamScan(req, res, key, runner) {
  sseOpen(res);
  let disconnected = false;
  let cancelled = false;
  req.on('close', () => {
    disconnected = true;
  });
  // Registered so POST /api/scan/stop can ask this walk to finish early.
  running.set(key, () => { cancelled = true; });

  const started = Date.now();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  try {
    const payload = await runner({
      onProgress: (p) => sseSend(res, 'progress', { ...p, elapsed: Date.now() - started }),
      shouldStop: () => disconnected || cancelled,
    });
    // Nobody is listening any more - drop it.
    if (disconnected) return;
    const result = { ...payload, elapsed: Date.now() - started, partial: cancelled };
    cache.set(key, result);
    if (cancelled) logInfo('scan.stopped', { key, elapsed: result.elapsed });
    sseSend(res, 'done', result);
  } catch (err) {
    sseSend(res, 'error', { message: err?.message || String(err) });
  } finally {
    clearInterval(heartbeat);
    running.delete(key);
    if (!res.writableEnded) res.end();
  }
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

/**
 * Localhost-only CSRF guard: a mutating call must come from our own page, and
 * must carry a header a cross-origin form cannot set.
 */
function mutationAllowed(req) {
  if (req.headers['x-macpuffin'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      // The UI is fully self-contained: no remote script, style, image or
      // connection is ever needed, so everything off-origin is forbidden.
      // 'unsafe-inline' is needed for style only: the bars and gauges set
      // width/height through style attributes. Scripts stay strict, which is
      // the half that turns an injection into code execution.
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = url.pathname;

  try {
    if (p === '/api/system') {
      json(res, 200, await snapshot());
      return;
    }

    if (p === '/api/hardware') {
      json(res, 200, await hardware());
      return;
    }

    if (p === '/api/cache') {
      json(res, 200, Object.fromEntries(cache));
      return;
    }

    if (p === '/api/appicon') {
      const target = url.searchParams.get('path') || '';
      if (!isAppBundle(target)) {
        json(res, 404, { error: 'not an application bundle' });
        return;
      }
      // A bundle with no extractable icon answers with a transparent pixel
      // rather than a 404: the slot renders empty either way, and the console
      // stays free of errors that are not errors.
      const png = (await appIcon(target)) || BLANK_PNG;
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': png.length,
        // Icons never change between launches; let the view cache them.
        'cache-control': 'private, max-age=86400',
      });
      res.end(png);
      return;
    }

    if (p === '/api/crashes') {
      const hw = await hardware();
      const crashes = listCrashes();
      json(res, 200, {
        crashes,
        // Pre-rendered so the UI can show exactly what would be shared.
        reports: crashes.map((c) => ({ id: c.id, body: reportBody(c, hw) })),
      });
      return;
    }

    if (p === '/api/logs') {
      json(res, 200, { file: LOG_FILE, lines: tail(Number(url.searchParams.get('n') || 300)) });
      return;
    }

    if (p === '/api/scan/deep') {
      const root = url.searchParams.get('root') || HOME;
      const resolved = path.resolve(root);
      if (!resolved.startsWith(HOME) && resolved !== '/') {
        json(res, 400, { error: 'root must be inside the home folder' });
        return;
      }
      const oldDays = Number(url.searchParams.get('days') || 180);
      const minLarge = Number(url.searchParams.get('minLarge') || 100) * 1024 * 1024;
      const thorough = url.searchParams.get('thorough') === '1';
      await streamScan(req, res, 'deep', ({ onProgress, shouldStop }) =>
        deepScan(resolved, { oldDays, minLarge, thorough, onProgress, shouldStop }),
      );
      return;
    }

    if (p === '/api/scan/junk') {
      await streamScan(req, res, 'junk', ({ onProgress, shouldStop }) => scanJunk(onProgress, shouldStop));
      return;
    }

    if (p === '/api/scan/apps') {
      await streamScan(req, res, 'apps', ({ onProgress, shouldStop }) => scanApps(onProgress, shouldStop));
      return;
    }

    if (p === '/api/scan/home') {
      await streamScan(req, res, 'home', ({ onProgress, shouldStop }) => homeMap(onProgress, shouldStop));
      return;
    }

    if (p === '/api/scan/devtools') {
      await streamScan(req, res, 'devtools', ({ onProgress, shouldStop }) =>
        scanDevTools(onProgress, shouldStop),
      );
      return;
    }

    if (p === '/api/scan/spotlight') {
      const min = Number(url.searchParams.get('min') || 1024) * 1024 * 1024;
      json(res, 200, { files: await spotlightLarge(min), scannedAt: Date.now() });
      return;
    }

    if (req.method === 'POST') {
      if (!mutationAllowed(req)) {
        json(res, 403, { error: 'blocked: request did not originate from the app' });
        return;
      }
      const body = await readBody(req);

      if (p === '/api/trash') {
        const paths = Array.isArray(body.paths) ? body.paths : [];
        if (!paths.length) {
          json(res, 400, { error: 'no paths given' });
          return;
        }
        const blocked = paths.filter(isProtected);
        if (blocked.length) {
          logWarn('api.trash.blocked', { blocked });
          json(res, 400, { error: 'protected path in selection', blocked });
          return;
        }
        json(res, 200, await trashMany(paths));
        return;
      }

      if (p === '/api/trash/empty') {
        json(res, 200, await emptyTrash());
        return;
      }

      if (p === '/api/empty') {
        const dirs = Array.isArray(body.dirs) ? body.dirs : body.dir ? [body.dir] : [];
        if (!dirs.length) {
          json(res, 400, { error: 'no dir given' });
          return;
        }
        const results = [];
        for (const dir of dirs) results.push(await emptyDirToTrash(dir));
        json(res, 200, dirs.length === 1 ? results[0] : { results });
        return;
      }

      if (p === '/api/crash') {
        const entry = recordCrash({
          kind: body.kind,
          message: body.message,
          stack: body.stack,
          where: 'interface',
          context: body.context,
        });
        json(res, 200, { ok: true, id: entry.id });
        return;
      }

      if (p === '/api/crashes/clear') {
        clearCrashes();
        json(res, 200, { ok: true });
        return;
      }

      if (p === '/api/scan/stop') {
        const key = String(body.key || '');
        const stop = running.get(key);
        if (!stop) {
          json(res, 404, { error: 'no scan running', key });
          return;
        }
        stop();
        json(res, 200, { ok: true, key });
        return;
      }

      if (p === '/api/reveal') {
        json(res, 200, await reveal(body.path || HOME));
        return;
      }
    }

    if (p.startsWith('/api/')) {
      json(res, 404, { error: 'unknown endpoint' });
      return;
    }

    await serveStatic(req, res, p);
  } catch (err) {
    logError('api.failed', { path: p, message: err?.message, stack: err?.stack?.split('\n')[1]?.trim() });
    recordCrash({ kind: err?.name || 'Error', message: err?.message, stack: err?.stack, where: `server ${p}` });
    if (!res.headersSent) json(res, 500, { error: err?.message || 'internal error' });
    else res.end();
  }
});

server.listen(PORT, HOST, async () => {
  const hw = await hardware();
  const url = `http://${HOST}:${PORT}`;
  process.stdout.write(
    `\n  MacPuffin v${VERSION} ready\n` +
      `  ${hw.model} · ${hw.cpu} · ${(hw.memTotal / 1024 ** 3).toFixed(0)} GB · ${hw.osName} ${hw.osVersion}\n` +
      `  ${url}\n  log: ${LOG_FILE}\n\n`,
  );
  logInfo('server.start', { version: VERSION, port: PORT, model: hw.model, os: `${hw.osName} ${hw.osVersion}` });
  if (process.env.NO_OPEN !== '1') sh('open', [url]);
});

process.on('uncaughtException', (err) => {
  recordCrash({ kind: 'uncaughtException', message: err?.message, stack: err?.stack, where: 'server' });
  logError('server.uncaught', { message: err?.message });
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  recordCrash({ kind: 'unhandledRejection', message: err.message, stack: err.stack, where: 'server' });
  logError('server.unhandledRejection', { message: err.message });
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

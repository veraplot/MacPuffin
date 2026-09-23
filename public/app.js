/* ─────────────────────────────────────────────────────────────
   MacPuffin front-end — state, SSE scans, rendering
   ───────────────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  sys: null,
  hw: null,
  deep: null,
  junk: null,
  apps: null,
  home: null,
  spotlight: null,
  devtools: null,
  procSort: 'mem',
  cpuHistory: new Array(60).fill(0),
  sel: { large: new Set(), old: new Set(), dupes: new Set(), junk: new Set(), apps: new Set() },
  scanning: new Set(),
  // What this session has moved to the Trash. The server cannot measure a
  // directory cheaply, so we carry the size the scan already knows.
  trashed: { items: 0, bytes: 0 },
};

const VIEW_META = {
  cockpit: ['Cockpit', 'Live picture of this Mac'],
  cleanup: ['Cleanup', 'Caches, logs and build leftovers that rebuild themselves'],
  large: ['Large files', 'The biggest single files in your home folder'],
  old: ['Old files', 'Big files you have not touched in a long time'],
  dupes: ['Duplicates', 'Identical files taking space more than once'],
  apps: ['Applications', 'Installed apps by size and last use'],
  storage: ['Storage map', 'Where the space actually went'],
  perf: ['Memory & CPU', 'Live pressure and the processes causing it'],
  devtools: ['Developer tools', 'Python environments, node_modules and Docker images on this Mac'],
};

/* ── Formatting ─────────────────────────────────────────────── */

function fmtBytes(n, digits) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const d = digits ?? (v < 10 && i > 1 ? 1 : 0);
  return `${v.toFixed(d)} ${units[i]}`;
}

function fmtAgo(ms) {
  if (!ms) return 'unknown';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) {
    const m = Math.round(days / 30);
    return `${m} month${m > 1 ? 's' : ''} ago`;
  }
  const y = (days / 365).toFixed(1).replace(/\.0$/, '');
  return `${y} year${Number(y) > 1 ? 's' : ''} ago`;
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((sec % 3600) / 60)}m`;
}

/** An <img> for a bundle's real icon; hides itself if the app has none. */
function appIconTag(bundlePath, cls = 'app-icon') {
  if (!bundlePath) return `<span class="${cls} app-icon-blank"></span>`;
  return `<img class="${cls}" src="/api/appicon?path=${encodeURIComponent(bundlePath)}" alt="" loading="lazy" />`;
}

// Icons that fail to load collapse to an empty slot. Registered here rather
// than as an inline onerror, which our own CSP (script-src 'self') forbids.
// `error` does not bubble, so this listens during the capture phase.
document.addEventListener(
  'error',
  (e) => {
    const el = e.target;
    if (el instanceof HTMLImageElement && el.classList.contains('app-icon')) {
      el.classList.add('app-icon-blank');
      el.removeAttribute('src');
    }
  },
  true,
);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortPath = (p) => (state.hw?.home ? String(p).replace(state.hw.home, '~') : String(p));

/** Trim the middle, not the tail: the filename stays readable. */
function midPath(p, max = 78) {
  const s = shortPath(p);
  if (s.length <= max) return s;
  const tail = Math.ceil(max * 0.62);
  return `${s.slice(0, max - tail - 1)}…${s.slice(-tail)}`;
}

/* ── Transport ──────────────────────────────────────────────── */

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-macpuffin': '1' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/** Run a server-side scan over SSE, forwarding progress ticks. */
function stream(url, { onProgress, onDone, onError }) {
  const es = new EventSource(url);
  es.addEventListener('progress', (e) => onProgress?.(JSON.parse(e.data)));
  es.addEventListener('done', (e) => { es.close(); onDone?.(JSON.parse(e.data)); });
  es.addEventListener('error', (e) => {
    es.close();
    let msg = 'Scan interrupted';
    try { msg = JSON.parse(e.data).message; } catch { /* transport-level error */ }
    onError?.(msg);
  });
  return es;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 4200);
  setTimeout(() => el.remove(), 4600);
}

/* ── Routing ────────────────────────────────────────────────── */

function go(view) {
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
  const [title, sub] = VIEW_META[view] || ['', ''];
  $('#view-title').textContent = title;
  $('#view-sub').textContent = sub;
  document.documentElement.dataset.view = view;
  location.hash = view;
  $('.content').scrollTop = 0;
}

/* ── Live system loop ───────────────────────────────────────── */

async function tickSystem() {
  try {
    state.sys = await api('/api/system');
  } catch {
    return;
  }
  const { mem, cpu, disk, procs, hw } = state.sys;

  $('#pill-cpu b').textContent = `${Math.round(cpu.busy)}%`;
  $('#pill-cpu').classList.toggle('hot', cpu.busy > 80);
  $('#pill-mem b').textContent = `${Math.round(mem.pressure * 100)}%`;
  $('#pill-mem').classList.toggle('hot', mem.pressure > 0.88);
  $('#pill-up b').textContent = fmtUptime(cpu.uptime);

  if (disk) {
    const pct = disk.percent;
    $('#side-disk-fill').style.width = `${pct * 100}%`;
    $('#side-disk-fill').parentElement.classList.toggle('hot', pct > 0.9);
    $('#side-disk-text').textContent = `${fmtBytes(disk.free)} free`;

    $('#disk-meter').style.width = `${(1 - pct) * 100}%`;   // the span masks the free remainder
    $('#disk-free').textContent = fmtBytes(disk.free);
    $('#disk-total').textContent = fmtBytes(disk.total);
    $('#hero-eyebrow').textContent = `Startup disk · ${Math.round(pct * 100)}% used`;

    // Once a deep scan exists, renderDeepSummary owns the hero copy.
    if (!state.scanning.size && !state.deep) {
      const free = disk.free;
      $('#hero-headline').textContent =
        pct > 0.95 ? 'Critically low on space'
        : pct > 0.85 ? 'Your disk is filling up'
        : pct > 0.6 ? 'Your Mac is in good shape'
        : 'Plenty of room';
      $('#hero-note').textContent =
        `${fmtBytes(free)} free of ${fmtBytes(disk.total)} on ${disk.mount}. Run a scan to see what is using it.`;
    }
  }

  $('#side-mem-fill').style.width = `${mem.pressure * 100}%`;
  $('#side-mem-fill').parentElement.classList.toggle('hot', mem.pressure > 0.88);
  $('#side-mem-text').textContent = `${fmtBytes(mem.used)} used`;
  $('#c-mem').textContent = `${Math.round(mem.pressure * 100)}%`;
  $('#c-mem-note').textContent = `${fmtBytes(mem.used)} of ${fmtBytes(mem.total)} in use`;

  $('#machine').textContent = `${hw.hostname} · ${hw.osName} ${hw.osVersion}`;
  state.hw = hw;

  renderProcs(procs);
  renderPerf(mem, cpu, procs);
  if (document.documentElement.dataset.view === 'storage') renderVolumes();
}

function procRow(p, value, ratio) {
  return `<li>
    <span class="pname">${appIconTag(p.app, 'app-icon sm')}<span class="pname-text">${esc(p.name)}</span>${p.count > 1 ? `<small class="pcount">×${p.count}</small>` : ''}</span>
    <span class="pval">${value}</span>
    <span class="ptrack"><span style="width:${Math.min(ratio * 100, 100)}%"></span></span>
  </li>`;
}

function renderProcs(procs) {
  const maxMem = procs.byMem[0]?.mem || 1;
  $('#cockpit-mem').innerHTML = procs.byMem.slice(0, 8).map((p) => procRow(p, fmtBytes(p.mem), p.mem / maxMem)).join('');
  const maxCpu = Math.max(procs.byCpu[0]?.cpu || 1, 100);
  $('#cockpit-cpu').innerHTML = procs.byCpu.slice(0, 8).map((p) => procRow(p, `${p.cpu.toFixed(1)}%`, p.cpu / maxCpu)).join('');

  const list = state.procSort === 'mem' ? procs.byMem : procs.byCpu;
  $('#proc-table').innerHTML =
    `<div class="row head" style="grid-template-columns:1fr auto auto auto"><span>Process</span><span>Memory</span><span>CPU</span><span>Procs</span></div>` +
    list.map((p) => `<div class="row" style="grid-template-columns:1fr auto auto auto">
        <div class="cell-name name-with-icon">${appIconTag(p.app)}<b>${esc(p.name)}</b></div>
        <span class="cell-size">${fmtBytes(p.mem)}</span>
        <span class="cell-meta">${p.cpu.toFixed(1)}%</span>
        <span class="cell-meta" style="min-width:48px">${p.count}</span>
      </div>`).join('');
}

// Four steps of one ramp plus an empty track: the split is read by position,
// not by hue, so no part needs a colour of its own.
const MEM_PARTS = [
  ['app', 'App memory', '#f5a524'],
  ['wired', 'Wired', '#b8791b'],
  ['compressed', 'Compressed', '#7c5413'],
  ['cached', 'Cached files', '#3f3f46'],
  ['free', 'Free', '#232327'],
];

function renderPerf(mem, cpu) {
  $('#perf-mem-used').textContent = fmtBytes(mem.used);
  $('#perf-mem-total').textContent = `of ${fmtBytes(mem.total)} used`;
  $('#mem-stack').innerHTML = MEM_PARTS
    .map(([k, , color]) => `<div style="width:${(mem[k] / mem.total) * 100}%;background:${color}"></div>`)
    .join('');
  $('#mem-legend').innerHTML = MEM_PARTS
    .map(([k, label, color]) => `<li><i style="background:${color}"></i>${label} <b>${fmtBytes(mem[k])}</b></li>`)
    .join('');
  $('#swap-kv').innerHTML = `
    <div><span>Swap used</span><b>${fmtBytes(mem.swapUsed)}</b></div>
    <div><span>Swap allocated</span><b>${fmtBytes(mem.swapTotal)}</b></div>
    <div><span>Memory pressure</span><b>${Math.round(mem.pressure * 100)}%</b></div>`;

  state.cpuHistory.push(cpu.busy);
  if (state.cpuHistory.length > 60) state.cpuHistory.shift();
  $('#perf-cpu-busy').textContent = `${Math.round(cpu.busy)}%`;
  $('#perf-cpu-model').textContent = `${state.hw?.cpu || ''} · ${cpu.cores} cores`;
  $('#cpu-spark').innerHTML = state.cpuHistory.map((v) => `<span style="height:${Math.max(v, 2)}%"></span>`).join('');
  $('#cpu-kv').innerHTML = `
    <div><span>User</span><b>${cpu.user?.toFixed(1) ?? '—'}%</b></div>
    <div><span>System</span><b>${cpu.sys?.toFixed(1) ?? '—'}%</b></div>
    <div><span>Load average</span><b>${cpu.load1.toFixed(2)} · ${cpu.load5.toFixed(2)} · ${cpu.load15.toFixed(2)}</b></div>
    <div><span>Uptime</span><b>${fmtUptime(cpu.uptime)}</b></div>
    ${state.sys?.power?.hasBattery ? `<div><span>Battery</span><b>${state.sys.power.percent}% ${state.sys.power.charging ? '(charging)' : ''}</b></div>` : ''}`;
}

function renderVolumes() {
  if (!state.sys) return;
  $('#volumes').innerHTML = state.sys.volumes
    .map((v) => `<div class="vol">
      <div class="vol-head"><b>${esc(v.mount)}</b><span>${fmtBytes(v.used)} used · ${fmtBytes(v.free)} free · ${fmtBytes(v.total)} total</span></div>
      <div class="meter" style="margin:0"><span style="width:${(1 - v.percent) * 100}%"></span></div>
    </div>`)
    .join('');
}

/* ── Selection helpers ──────────────────────────────────────── */

function selectionBytes(scope) {
  const sel = state.sel[scope];
  const index = scopeIndex(scope);
  let total = 0;
  for (const p of sel) total += index.get(p) || 0;
  return total;
}

function scopeIndex(scope) {
  const map = new Map();
  if (scope === 'large') (currentLarge() || []).forEach((f) => map.set(f.path, f.size));
  if (scope === 'old') (state.deep?.old || []).forEach((f) => map.set(f.path, f.size));
  if (scope === 'dupes') (state.deep?.duplicates || []).forEach((g) => g.paths.forEach((p) => map.set(p, g.size)));
  if (scope === 'junk') (state.junk?.items || []).forEach((i) => map.set(i.path, i.size));
  if (scope === 'apps') (state.apps?.apps || []).forEach((a) => map.set(a.path, a.size));
  return map;
}

function syncSelection(scope) {
  const btn = $(`[data-action="trash-selected"][data-scope="${scope}"]`);
  if (!btn) return;
  const n = state.sel[scope].size;
  btn.disabled = n === 0;
  btn.textContent = n === 0
    ? 'Move selection to Trash'
    : `Move ${n} item${n > 1 ? 's' : ''} to Trash · ${fmtBytes(selectionBytes(scope))}`;
}

function onRowToggle(e) {
  const box = e.target.closest('input[type=checkbox][data-path]');
  if (!box) return;
  const { scope, path } = box.dataset;
  if (box.checked) state.sel[scope].add(path);
  else state.sel[scope].delete(path);
  syncSelection(scope);
}

/* ── Renderers: file tables ─────────────────────────────────── */

function fileRows(files, scope) {
  return files
    .map((f) => `<div class="row">
      <input type="checkbox" data-scope="${scope}" data-path="${esc(f.path)}" ${state.sel[scope].has(f.path) ? 'checked' : ''} />
      <div class="cell-name"><b>${esc(f.name)}</b><small title="${esc(shortPath(f.path))}">${esc(midPath(f.path, 96))}</small></div>
      <span class="cell-size">${fmtBytes(f.size)}</span>
      <span class="cell-meta">${fmtAgo(f.lastUsed || f.mtime)}</span>
      <button class="btn btn-tiny" data-reveal="${esc(f.path)}">Reveal</button>
    </div>`)
    .join('');
}

function currentLarge() {
  const min = Number($('#large-min').value) * 1024 * 1024;
  const source = state.spotlight?.files?.length && (!state.deep || state.spotlight.scannedAt > state.deep.scannedAt)
    ? state.spotlight.files
    : state.deep?.large;
  return source?.filter((f) => f.size >= min);
}

function renderLarge() {
  const files = currentLarge();
  if (!files) return;
  const total = files.reduce((s, f) => s + f.size, 0);
  $('#large-stat').textContent = `${files.length} files · ${fmtBytes(total)}${partialNote(state.deep)}`;
  $('#large-table').innerHTML = files.length
    ? `<div class="row head"><span></span><span>File</span><span>Size</span><span>Last used</span><span></span></div>${fileRows(files, 'large')}`
    : '<p class="empty">No files above that size threshold.</p>';
  syncSelection('large');
}

function renderOld() {
  const d = state.deep;
  if (!d) return;
  $('#old-stat').textContent = `${d.oldCount.toLocaleString()} files · ${fmtBytes(d.oldBytes)} untouched for ${d.oldDays}+ days${partialNote(d)}`;
  $('#old-table').innerHTML = d.old.length
    ? `<div class="row head"><span></span><span>File</span><span>Size</span><span>Last used</span><span></span></div>${fileRows(d.old, 'old')}`
    : '<p class="empty">Nothing big has gone stale. Nice.</p>';
  syncSelection('old');
}

const expandedDupes = new Set();

function renderDupes() {
  const groups = state.deep?.duplicates;
  if (!groups) return;
  const wasted = groups.reduce((s, g) => s + g.wasted, 0);
  $('#dupe-stat').textContent = `${groups.length} groups · ${fmtBytes(wasted)} reclaimable${partialNote(state.deep)}`;

  $('#dupe-table').innerHTML = groups.length
    ? groups
        .map((g, gi) => {
          const open = expandedDupes.has(gi);
          const shown = open ? g.paths : g.paths.slice(0, 4);
          const selected = g.paths.filter((p) => state.sel.dupes.has(p)).length;
          const rows = shown
            .map((p, pi) => `<div class="row sub">
              <input type="checkbox" data-scope="dupes" data-path="${esc(p)}" ${state.sel.dupes.has(p) ? 'checked' : ''} />
              <div class="cell-name"><small title="${esc(shortPath(p))}">${esc(midPath(p))}</small></div>
              <span class="cell-meta">${pi === 0 ? 'newest' : fmtAgo(g.mtimes?.[pi])}</span>
              <button class="btn btn-tiny" data-reveal="${esc(p)}">Reveal</button>
            </div>`)
            .join('');
          const more = g.paths.length > shown.length
            ? `<div class="row sub"><span></span><div class="cell-name"><button class="btn btn-tiny" data-dupe-expand="${gi}">Show all ${g.paths.length} copies</button></div><span></span><span></span></div>`
            : '';
          return `<div class="row group" data-dupe-toggle="${gi}">
              <span class="chev${open ? ' open' : ''}"></span>
              <div class="cell-name"><b>${esc(g.name)}</b><small>${g.count} copies${selected ? ` · ${selected} selected` : ''}</small></div>
              <span class="cell-size">${fmtBytes(g.size)}</span>
              <span class="cell-meta">wastes ${fmtBytes(g.wasted)}</span>
            </div>${rows}${more}`;
        })
        .join('')
    : '<p class="empty">No duplicate files found above 1 MB.</p>';
  syncSelection('dupes');
}

function renderJunk() {
  const j = state.junk;
  if (!j) return;
  $('#junk-stat').textContent = `${fmtBytes(j.total)} found · ${fmtBytes(j.reclaimable)} safe to clear`;
  $('#c-junk').textContent = fmtBytes(j.reclaimable);
  $('#c-junk-note').textContent = `${j.items.length} locations · ${fmtBytes(j.total)} total`;
  $('#junk-table').innerHTML = j.items.length
    ? `<div class="row head"><span></span><span>Location</span><span>Size</span><span>Files</span><span></span></div>` +
      j.items
        .map((i) => `<div class="row">
          <input type="checkbox" data-scope="junk" data-path="${esc(i.path)}" ${state.sel.junk.has(i.path) ? 'checked' : ''} ${i.safety === 'danger' ? 'disabled' : ''} />
          <div class="cell-name"><b>${esc(i.label)} <span class="tag tag-${i.safety}">${i.safety}</span>${
            i.mode === 'empty' ? ' <span class="tag tag-mode">contents only</span>' : ''
          }</b><small>${esc(shortPath(i.path))}</small></div>
          <span class="cell-size">${fmtBytes(i.size)}</span>
          <span class="cell-meta">${i.files.toLocaleString()} files</span>
          <button class="btn btn-tiny" data-empty="${esc(i.path)}">${i.mode === 'emptyTrash' ? 'Empty Trash' : 'Empty'}</button>
        </div>`)
        .join('')
    : '<p class="empty">Nothing to clean.</p>';
  syncSelection('junk');
}

function renderApps() {
  const a = state.apps;
  if (!a) return;
  $('#apps-stat').textContent = `${a.count} apps · ${fmtBytes(a.total)}`;
  $('#c-apps').textContent = fmtBytes(a.total);
  $('#c-apps-note').textContent = `${a.count} applications installed`;
  $('#apps-table').innerHTML =
    `<div class="row head"><span></span><span>Application</span><span>Size</span><span>Last used</span><span></span></div>` +
    a.apps
      .map((app) => `<div class="row">
        <input type="checkbox" data-scope="apps" data-path="${esc(app.path)}" ${state.sel.apps.has(app.path) ? 'checked' : ''} />
        <div class="cell-name name-with-icon">${appIconTag(app.path)}<div class="name-text"><b>${esc(app.name)}${app.version ? ` <small style="display:inline;color:var(--ink-faint)">${esc(app.version)}</small>` : ''}</b><small>${esc(shortPath(app.path))}</small></div></div>
        <span class="cell-size">${fmtBytes(app.size)}</span>
        <span class="cell-meta">${fmtAgo(app.lastUsed)}</span>
        <button class="btn btn-tiny" data-reveal="${esc(app.path)}">Reveal</button>
      </div>`)
      .join('');
  syncSelection('apps');
}

const FOLDER_COLORS = ['#f5a524', '#d18f20', '#ad791c', '#8a6318', '#6b4e15', '#4f3b12', '#3a2d10', '#2b230e'];

function barBlock(items, total, label = (i) => i.name) {
  if (!items.length) return '<p class="empty">Nothing to show.</p>';
  return items
    .slice(0, 12)
    .map((i, idx) => `<div class="barline">
      <span class="lbl">${esc(label(i))}</span>
      <span class="val">${fmtBytes(i.size)} · ${((i.size / total) * 100).toFixed(1)}%</span>
      <span class="track"><span style="width:${(i.size / (items[0].size || 1)) * 100}%;background:${FOLDER_COLORS[idx % FOLDER_COLORS.length]}"></span></span>
    </div>`)
    .join('');
}

function renderHomeMap() {
  const h = state.home;
  if (!h) return;
  $('#home-stat').textContent =
    `${fmtBytes(h.total)} across ${h.items.length} folders${h.partial ? ' · still measuring…' : ''}`;
  $('#home-bars').innerHTML = barBlock(h.items, h.total);
}

function renderCategories() {
  const d = state.deep;
  if (!d) return;
  $('#cat-bars').innerHTML = barBlock(d.categories, d.totalBytes);
}

/** Wording for a result set that was cut short. */
const partialNote = (d) => (d?.partial ? ' · partial scan' : '');

function renderDeepSummary() {
  const d = state.deep;
  if (!d) return;
  const large = currentLarge() || [];
  $('#c-large').textContent = fmtBytes(large.reduce((s, f) => s + f.size, 0));
  $('#c-large-note').textContent = `${large.length} files over the threshold`;
  $('#c-old').textContent = fmtBytes(d.oldBytes);
  $('#c-old-note').textContent = `${d.oldCount.toLocaleString()} files idle ${d.oldDays}+ days`;
  const wasted = d.duplicates.reduce((s, g) => s + g.wasted, 0);
  $('#c-dupe').textContent = fmtBytes(wasted);
  $('#c-dupe-note').textContent = `${d.duplicates.length} duplicate groups`;
  $('#hero-headline').textContent = d.partial ? 'Scan stopped early' : 'Scan complete';
  $('#hero-note').textContent =
    `${d.files.toLocaleString()} files · ${fmtBytes(d.totalBytes)} scanned in ${(d.elapsed / 1000).toFixed(1)}s` +
    (d.partial ? ' before you stopped it — the results below cover only what was reached. ' : '. ') +
    `${fmtBytes(d.oldBytes + wasted)} looks reclaimable from old files and duplicates.` +
    (d.skippedCount ? ` ${d.skippedCount.toLocaleString()} cache and dependency folders were skipped — see Cleanup.` : '')
    + (d.deniedCount
      ? ` ${d.deniedCount.toLocaleString()} folder${d.deniedCount > 1 ? 's' : ''} could not be read, so the total is lower than reality`
        + ' — allow MacPuffin under System Settings › Privacy & Security › Files and Folders.'
      : '');
}

/* ── Scans ──────────────────────────────────────────────────── */

/** What each scan is called while it runs, and whether it can be stopped. */
const SCAN_LABEL = {
  deep: 'Scanning your home folder',
  junk: 'Measuring reclaimable locations',
  apps: 'Measuring applications',
  home: 'Mapping the home folder',
  devtools: 'Measuring developer tools',
  spot: 'Asking Spotlight',
};

function setScanning(key, on) {
  if (on) state.scanning.add(key); else state.scanning.delete(key);
  const running = state.scanning.size > 0;

  $$('[data-scan]').forEach((b) => { b.disabled = running; });
  $('#btn-scan-all').disabled = running;
  $('#btn-scan-all').textContent = running ? 'Scanning…' : 'Scan this Mac';

  // The strip lives in the shell, not in a view, so progress stays visible
  // when you switch screens mid-scan.
  const strip = $('#scanstrip');
  strip.hidden = !running;
  if (!running) {
    $('#scan-count').textContent = '';
    $('#scan-path').textContent = '';
    $('#scan-bar').style.width = '';
    $('#scan-bar-wrap').classList.add('indet');
    return;
  }
  const current = [...state.scanning][0];
  strip.dataset.key = current;
  $('#scan-label').textContent = SCAN_LABEL[current] || 'Scanning';
  $('#btn-stop').hidden = !['deep', 'junk', 'apps', 'home', 'devtools'].includes(current);
}

/** Report progress into the one strip. */
function scanProgress({ files, bytes, current }) {
  if (files !== undefined) {
    $('#scan-count').textContent = `${files.toLocaleString()} files · ${fmtBytes(bytes || 0)}`;
    $('#scan-bar-wrap').classList.remove('indet');
    $('#scan-bar').style.width = `${Math.min((files / 400000) * 100, 96)}%`;
  }
  if (current) $('#scan-path').textContent = shortPath(current);
}

let deepStream = null;

function runDeep() {
  const days = $('#old-days').value;
  const minLarge = Math.min(Number($('#large-min').value), 100);
  const thorough = $('#deep-thorough').checked ? 1 : 0;
  setScanning('deep', true);
  $('#hero-headline').textContent = 'Scanning your home folder…';

  deepStream = stream(`/api/scan/deep?days=${days}&minLarge=${minLarge}&thorough=${thorough}`, {
    onProgress: scanProgress,
    onDone: (data) => {
      state.deep = data;
      state.spotlight = null;
      setScanning('deep', false);
      renderLarge(); renderOld(); renderDupes(); renderCategories(); renderDeepSummary();
      toast(
        data.partial
          ? `Scan stopped — keeping ${data.files.toLocaleString()} files found in ${(data.elapsed / 1000).toFixed(1)}s`
          : `Deep scan done — ${data.files.toLocaleString()} files in ${(data.elapsed / 1000).toFixed(1)}s`,
        'ok',
      );
    },
    onError: (msg) => {
      setScanning('deep', false);
      toast(msg, 'err');
    },
  });
}

function runSse(key, url, onDone, onPartial) {
  setScanning(key, true);
  stream(url, {
    onProgress: (p) => {
      scanProgress(p);
      if (p.item) onPartial?.(p.item);
    },
    onDone: (data) => { setScanning(key, false); onDone(data); },
    onError: (msg) => { setScanning(key, false); toast(msg, 'err'); },
  });
}

const SCANS = {
  deep: runDeep,
  junk: () => runSse('junk', '/api/scan/junk', (d) => { state.junk = d; renderJunk(); toast(`${fmtBytes(d.reclaimable)} of junk found`, 'ok'); }),
  apps: () => runSse('apps', '/api/scan/apps', (d) => { state.apps = d; renderApps(); toast(`${d.count} apps · ${fmtBytes(d.total)}`, 'ok'); }),
  devtools: () => runSse('devtools', '/api/scan/devtools', (d) => {
    state.devtools = d;
    renderDevTools();
    toast(d.partial ? 'Developer scan stopped — keeping what was found' : 'Developer tools scanned', 'ok');
  }),
  home: () => {
    const partial = { items: [], total: 0, partial: true };
    state.home = partial;
    runSse(
      'home',
      '/api/scan/home',
      (d) => { state.home = d; renderHomeMap(); toast('Home folder mapped', 'ok'); },
      (item) => {
        partial.items.push(item);
        partial.items.sort((a, b) => b.size - a.size);
        partial.total += item.size;
        renderHomeMap();
      },
    );
  },
  spotlight: async () => {
    setScanning('spot', true);
    try {
      const min = Number($('#large-min').value); // MB, matching the server
      state.spotlight = await api(`/api/scan/spotlight?min=${min}`);
      renderLarge();
      toast(`Spotlight found ${state.spotlight.files.length} large files`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setScanning('spot', false);
    }
  },
};

/* ── Destructive actions ────────────────────────────────────── */

function confirmDialog({ title, message, list, okLabel }) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML =
      `<p>${message}</p>` +
      (list?.length ? `<div class="modal-list">${list.map((p) => `<div>${esc(shortPath(p))}</div>`).join('')}</div>` : '');
    $('#modal-ok').textContent = okLabel || 'Move to Trash';
    $('#modal').hidden = false;

    const close = (val) => {
      $('#modal').hidden = true;
      $('#modal-ok').removeEventListener('click', ok);
      $('#modal-cancel').removeEventListener('click', cancel);
      resolve(val);
    };
    const ok = () => close(true);
    const cancel = () => close(false);
    $('#modal-ok').addEventListener('click', ok);
    $('#modal-cancel').addEventListener('click', cancel);
  });
}

/** Track what went to the Trash and keep the reminder banner truthful. */
function noteTrashed(items, bytes) {
  state.trashed.items += items;
  state.trashed.bytes += bytes;
  renderTrashBanner();
}

function renderTrashBanner() {
  const t = state.trashed;
  const banner = $('#trash-banner');
  banner.hidden = t.items === 0;
  if (t.items === 0) return;
  $('#trash-banner-title').textContent = `${fmtBytes(t.bytes)} is sitting in the Trash`;
  $('#trash-banner-note').textContent =
    `${t.items} item${t.items > 1 ? 's' : ''} moved this session. The disk does not get that space back until the Trash is emptied.`;
}

/** Turn an errno into something a person can act on. */
const ERROR_HELP = {
  EACCES: 'macOS blocked it — allow MacPuffin under System Settings › Privacy & Security › App Management, or remove the app from Finder',
  EPERM: 'macOS blocked it — this item is protected by the system',
  ENOENT: 'already gone',
  'not found': 'already gone',
  EBUSY: 'in use — quit the app and try again',
  ENOTEMPTY: 'a folder of the same name is already in the Trash',
};
const explain = (code) => ERROR_HELP[code] || code;

/** Report only what actually happened, naming the failures. */
function reportTrashResult(res, knownBytes) {
  const failed = res.failed?.length || 0;
  if (res.ok > 0) noteTrashed(res.ok, knownBytes);
  if (!failed) {
    toast(`${res.ok} moved to Trash · ${fmtBytes(knownBytes)} pending`, 'ok');
    return;
  }
  const codes = [...new Set(res.failed.map((f) => explain(f.error)))].join(' · ');
  toast(`${res.ok} moved · ${failed} failed — ${codes}`, 'err');
  console.warn('MacPuffin: failed to trash', res.failed);
}

/**
 * Cleanup locations are not all cleaned the same way. macOS refuses to move its
 * own standard folders (~/Library/Caches and friends) — `mv` and Finder fail on
 * them too — so those get their contents emptied while the folder stays.
 */
async function cleanJunkSelection() {
  const paths = [...state.sel.junk];
  if (!paths.length) return;
  const items = (state.junk?.items || []).filter((i) => paths.includes(i.path));
  const size = items.reduce((s, i) => s + i.size, 0);
  const toEmpty = items.filter((i) => i.mode === 'empty').map((i) => i.path);
  const toMove = items.filter((i) => i.mode === 'move').map((i) => i.path);
  const wantsTrash = items.some((i) => i.mode === 'emptyTrash');

  if (wantsTrash && items.length === 1) return doEmptyTrash();

  const okd = await confirmDialog({
    title: `Clean ${items.length} location${items.length > 1 ? 's' : ''}?`,
    message:
      `About ${fmtBytes(size)} moves to ~/.Trash. Nothing is erased — everything stays restorable from Finder ` +
      `until you empty the Trash, and the disk only gets the space back at that point.` +
      (toEmpty.length
        ? ` ${toEmpty.length} of these are macOS-owned folders, so their contents are emptied and the folders themselves stay in place.`
        : ''),
    list: paths,
  });
  if (!okd) return;

  try {
    let moved = 0;
    let failedCount = 0;
    const codes = new Set();

    if (toMove.length) {
      const res = await post('/api/trash', { paths: toMove });
      moved += res.ok;
      failedCount += res.failed.length;
      res.failed.forEach((f) => codes.add(f.error));
    }
    if (toEmpty.length) {
      const res = await post('/api/empty', { dirs: toEmpty });
      const list = res.results || [res];
      for (const r of list) {
        moved += r.moved || 0;
        failedCount += r.errorCount || 0;
        (r.errors || []).forEach((e) => codes.add(e.error));
      }
    }

    state.sel.junk.clear();
    syncSelection('junk');
    if (moved) noteTrashed(moved, size);
    if (failedCount) {
      toast(`${moved} moved · ${failedCount} failed — ${[...codes].map(explain).join(' · ')}`, 'err');
    } else {
      toast(`Cleaned · ${fmtBytes(size)} now pending in the Trash`, 'ok');
    }
    SCANS.junk();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function trashSelected(scope) {
  if (scope === 'junk') return cleanJunkSelection();
  const paths = [...state.sel[scope]];
  if (!paths.length) return;
  const size = selectionBytes(scope);

  const okd = await confirmDialog({
    title: `Move ${paths.length} item${paths.length > 1 ? 's' : ''} to the Trash?`,
    message:
      `This moves about ${fmtBytes(size)} into ~/.Trash. Nothing is erased: you can restore every item from Finder ` +
      `until you empty the Trash. Space is only freed once the Trash is emptied.`,
    list: paths,
  });
  if (!okd) return;

  try {
    const res = await post('/api/trash', { paths });
    state.sel[scope].clear();
    syncSelection(scope);
    // Count only the bytes of the items that actually moved.
    const index = scopeIndex(scope);
    const movedBytes = res.results
      .filter((r) => r.ok)
      .reduce((s, r) => s + (index.get(r.path) || r.size || 0), 0);
    reportTrashResult(res, movedBytes);
    $$(`input[data-scope="${scope}"]`).forEach((b) => { b.checked = false; });
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function doEmptyTrash() {
  const okd = await confirmDialog({
    title: 'Empty the Trash permanently?',
    message:
      'This asks Finder to erase everything currently in the Trash — not only the items moved by MacPuffin. ' +
      'It cannot be undone, and anything you wanted to restore will be gone. Only the space freed by this step ' +
      'shows up as free disk space.',
    okLabel: 'Empty Trash permanently',
  });
  if (!okd) return;
  try {
    const res = await post('/api/trash/empty', {});
    if (!res.ok) throw new Error(res.error || 'Finder refused');
    state.trashed = { items: 0, bytes: 0 };
    renderTrashBanner();
    toast('Trash emptied', 'ok');
  } catch (err) {
    toast(`Empty Trash failed: ${err.message}`, 'err');
  }
}

async function emptyDir(dir) {
  const item = state.junk?.items.find((i) => i.path === dir);
  if (item?.mode === 'emptyTrash') return doEmptyTrash();
  const okd = await confirmDialog({
    title: `Empty ${item?.label || dir}?`,
    message:
      `Every file inside this folder moves to ~/.Trash — about ${fmtBytes(item?.size || 0)}. The folder itself stays. ` +
      `${item?.safety === 'safe' ? 'macOS or the owning tool rebuilds this content automatically.' : 'Review this one first: the owning app may need its contents.'}`,
    list: [dir],
    okLabel: 'Empty to Trash',
  });
  if (!okd) return;
  try {
    const res = await post('/api/empty', { dir });
    // `res.freed` only covers loose files; sub-folders are reported as
    // `unsized`, so the scan's own figure is the honest number to show.
    const known = item?.size || res.freed;
    if (res.moved) noteTrashed(res.moved, known);
    if (res.errorCount) {
      const codes = [...new Set(res.errors.map((e) => explain(e.error)))].join(' · ');
      toast(`${res.moved} moved · ${res.errorCount} failed — ${codes}`, 'err');
      console.warn('MacPuffin: failed to empty', res.errors);
    } else {
      toast(`${res.moved} items moved · ${fmtBytes(known)} pending in Trash`, 'ok');
    }
    SCANS.junk();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** Keep the newest copy of each duplicate group, select the rest. */
function selectDupesButNewest() {
  const groups = state.deep?.duplicates || [];
  state.sel.dupes.clear();
  for (const g of groups) g.paths.slice(1).forEach((p) => state.sel.dupes.add(p));
  renderDupes();
  toast(`${state.sel.dupes.size} redundant copies selected`);
}

/* ── Wiring ─────────────────────────────────────────────────── */

document.addEventListener('click', (e) => {
  const nav = e.target.closest('.nav-item');
  if (nav) return go(nav.dataset.view);

  const card = e.target.closest('[data-goto]');
  if (card) return go(card.dataset.goto);

  const scan = e.target.closest('[data-scan]');
  if (scan) return SCANS[scan.dataset.scan]?.();

  const rev = e.target.closest('[data-reveal]');
  if (rev) return post('/api/reveal', { path: rev.dataset.reveal }).catch(() => {});

  const emp = e.target.closest('[data-empty]');
  if (emp) return emptyDir(emp.dataset.empty);

  const act = e.target.closest('[data-action]');
  if (act?.dataset.action === 'trash-selected') return trashSelected(act.dataset.scope);
  if (act?.dataset.action === 'select-dupes') return selectDupesButNewest();

  const expand = e.target.closest('[data-dupe-expand]');
  if (expand) { expandedDupes.add(Number(expand.dataset.dupeExpand)); return renderDupes(); }

  const toggle = e.target.closest('[data-dupe-toggle]');
  if (toggle) {
    const gi = Number(toggle.dataset.dupeToggle);
    if (expandedDupes.has(gi)) expandedDupes.delete(gi); else expandedDupes.add(gi);
    return renderDupes();
  }

  const sortBtn = e.target.closest('#proc-sort button');
  if (sortBtn) {
    state.procSort = sortBtn.dataset.sort;
    $$('#proc-sort button').forEach((b) => b.classList.toggle('is-on', b === sortBtn));
    if (state.sys) renderProcs(state.sys.procs);
  }
});

document.addEventListener('change', (e) => {
  onRowToggle(e);
  if (e.target.id === 'large-min') { renderLarge(); renderDeepSummary(); }
  if (e.target.id === 'old-days' && state.deep) toast('Re-run the deep scan to apply the new age threshold');
});

$('#btn-scan-all').addEventListener('click', async () => {
  SCANS.junk();
  SCANS.apps();
  runDeep();
});

$('#btn-open-storage').addEventListener('click', () => { go('storage'); if (!state.home) SCANS.home(); });

$('#btn-empty-trash').addEventListener('click', doEmptyTrash);
$('#btn-reveal-trash').addEventListener('click', () => post('/api/reveal', { path: `${state.hw?.home || ''}/.Trash` }).catch(() => {}));

$('#btn-stop').addEventListener('click', async () => {
  const btn = $('#btn-stop');
  const key = $('#scanstrip').dataset.key || 'deep';
  btn.disabled = true;
  btn.textContent = 'Stopping…';
  try {
    // The stream stays open on purpose: the server finishes the walk early and
    // still sends its results, so a stopped scan is a usable scan.
    await post('/api/scan/stop', { key });
  } catch {
    // Already finished between the click and the request — nothing to stop.
    deepStream?.close();
    setScanning(key, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Stop';
  }
});

$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal-cancel').click(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) $('#modal-cancel').click(); });

/* ── Developer tools ────────────────────────────────────────── */

function renderDevTools() {
  const d = state.devtools;
  if (!d) return;
  const { python, node, docker } = d;

  $('#dev-stat').textContent =
    `${fmtBytes(python.total + node.total + node.storeTotal + docker.total)} across toolchains`
    + (d.partial ? ' · partial scan' : '');

  // ── Python
  $('#c-py').textContent = fmtBytes(python.total);
  $('#c-py-note').textContent = `${python.count} environments`;
  $('#py-stat').textContent = `${python.count} found · ${fmtBytes(python.total)}`;
  $('#py-table').innerHTML = python.envs.length
    ? `<div class="row head" style="grid-template-columns:1fr auto auto auto"><span>Environment</span><span>Size</span><span>Last used</span><span></span></div>`
      + python.envs.map((e) => `<div class="row" style="grid-template-columns:1fr auto auto auto">
          <div class="cell-name"><b>${esc(e.name)} <span class="kind-tag">${esc(e.kind)}</span>${e.version ? ` <small style="display:inline;color:var(--ink-faint)">${esc(e.version)}</small>` : ''}</b><small title="${esc(shortPath(e.path))}">${esc(midPath(e.path, 88))}</small></div>
          <span class="cell-size">${e.size === null ? '—' : fmtBytes(e.size)}</span>
          <span class="cell-meta">${e.lastUsed ? fmtAgo(e.lastUsed) : ''}</span>
          <button class="btn btn-tiny" data-reveal="${esc(e.path)}">Reveal</button>
        </div>`).join('')
    : '<p class="empty">No Python environments found.</p>';

  // ── node_modules
  $('#c-nm').textContent = fmtBytes(node.total + node.storeTotal);
  $('#c-nm-note').textContent = `${node.count} projects · ${fmtBytes(node.storeTotal)} in shared stores`;
  $('#nm-stat').textContent = `${node.count} folders · ${fmtBytes(node.total)} + ${fmtBytes(node.storeTotal)} shared`;
  const storeRows = node.stores.map((st) => `<div class="row" style="grid-template-columns:1fr auto auto auto">
      <div class="cell-name"><b>${esc(st.label)} <span class="kind-tag">shared</span></b><small>${esc(shortPath(st.path))}</small></div>
      <span class="cell-size">${fmtBytes(st.size)}</span><span class="cell-meta"></span>
      <button class="btn btn-tiny" data-reveal="${esc(st.path)}">Reveal</button>
    </div>`).join('');
  $('#nm-table').innerHTML = node.modules.length || storeRows
    ? `<div class="row head" style="grid-template-columns:1fr auto auto auto"><span>Project</span><span>Size</span><span>Packages</span><span></span></div>`
      + storeRows
      + node.modules.map((m) => `<div class="row" style="grid-template-columns:1fr auto auto auto">
          <div class="cell-name"><b>${esc(m.project)}</b><small title="${esc(shortPath(m.path))}">${esc(midPath(m.path, 88))}</small></div>
          <span class="cell-size">${fmtBytes(m.size)}</span>
          <span class="cell-meta">${m.packages.toLocaleString()} pkgs</span>
          <button class="btn btn-tiny" data-reveal="${esc(m.path)}">Reveal</button>
        </div>`).join('')
    : '<p class="empty">No node_modules folders found.</p>';

  // ── Docker
  $('#c-dk').textContent = docker.available ? fmtBytes(docker.total) : '—';
  $('#c-dk-note').textContent = docker.available
    ? `${docker.images.length} images · ${docker.dangling || 0} untagged`
    : docker.reason;
  $('#dk-stat').textContent = docker.available
    ? `${docker.images.length} images · ${fmtBytes(docker.total)}${docker.reclaimable ? ` · ${fmtBytes(docker.reclaimable)} reclaimable` : ''}`
    : docker.reason;
  $('#dk-table').innerHTML = !docker.available
    ? `<p class="empty">${esc(docker.reason)}.</p>`
    : docker.images.length
      ? `<div class="row head" style="grid-template-columns:1fr auto auto"><span>Image</span><span>Size</span><span>Created</span></div>`
        + docker.images.map((i) => `<div class="row" style="grid-template-columns:1fr auto auto">
            <div class="cell-name"><b>${esc(i.name)}${i.dangling ? ' <span class="kind-tag">untagged</span>' : ''}</b><small>${esc(i.id)}</small></div>
            <span class="cell-size">${fmtBytes(i.size)}</span>
            <span class="cell-meta">${esc(i.created || '')}</span>
          </div>`).join('')
      : '<p class="empty">Docker is running but has no images.</p>';
}

/* ── Update notice ──────────────────────────────────────────── */

/**
 * Called by the native shell when GitHub reports a newer release. The page
 * never makes that request itself and the server has no outbound network path
 * at all, so in a browser — or with no connection — this simply never fires.
 */
window.macpuffinUpdate = ({ version, url } = {}) => {
  if (!version || localStorage.getItem('skipUpdate') === version) return;
  $('#update-note').textContent =
    `You are running v${state.hw?.version || '?'}. Version ${version} is out — the download opens in your browser.`;
  $('#btn-update-get').href = url || 'https://github.com/veraplot/MacPuffin/releases/latest';
  $('#update-banner').hidden = false;
};

$('#btn-update-later').addEventListener('click', () => {
  // Remember the dismissal per version, so the same release is not re-announced.
  const shown = $('#update-note').textContent.match(/Version ([\d.]+)/)?.[1];
  if (shown) localStorage.setItem('skipUpdate', shown);
  $('#update-banner').hidden = true;
});

/* ── Reporting: bugs, ideas and crashes ─────────────────────── */

const REPO = 'https://github.com/veraplot/MacPuffin';

/** A GitHub issue URL with the body filled in. Links are opened, never posted:
 *  nothing leaves this machine until you press submit on GitHub yourself. */
function issueUrl({ template, labels, title, body }) {
  const q = new URLSearchParams();
  if (template) q.set('template', template);
  if (labels) q.set('labels', labels);
  if (title) q.set('title', title);
  // GitHub truncates very long URLs; keep well inside the limit.
  if (body) q.set('body', body.slice(0, 5800));
  return `${REPO}/issues/new?${q}`;
}

function machineLine() {
  const hw = state.hw;
  if (!hw) return '';
  return `MacPuffin ${hw.version} · ${hw.model} · ${hw.cpu} · ${hw.arch}${hw.translated ? ' (Rosetta)' : ''}`
    + ` · ${Math.round(hw.memTotal / 1024 ** 3)} GB · ${hw.osName} ${hw.osVersion}`;
}

/**
 * Open a link outside the app.
 *
 * `window.open` is refused by pop-up blockers in a browser and is a silent
 * no-op inside a WKWebView with no new-window handler, so a real anchor click
 * is used instead: it counts as a user gesture everywhere, and the native
 * shell routes any non-localhost navigation to the default browser.
 */
function openExternal(url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
}

$('#btn-report-bug').addEventListener('click', () => {
  openExternal(issueUrl({
    template: 'bug_report.yml',
    labels: 'bug',
    body: `### Environment\n\n${machineLine()}\n`,
  }));
});

$('#btn-request-feature').addEventListener('click', () => {
  openExternal(issueUrl({ template: 'feature_request.yml', labels: 'enhancement' }));
});

/* ── Crash reports ──────────────────────────────────────────── */

let crashReports = [];

async function refreshCrashes() {
  const data = await api('/api/crashes').catch(() => null);
  if (!data) return;
  crashReports = data.reports || [];
  const latest = data.crashes?.[0];
  const banner = $('#crash-banner');
  if (!latest || localStorage.getItem('skipCrash') === latest.id) {
    banner.hidden = true;
    return;
  }
  $('#crash-note').textContent =
    `${latest.kind}: ${latest.message}`.slice(0, 160)
    + ` — ${latest.where}${latest.count > 1 ? `, seen ${latest.count} times` : ''}.`;
  banner.dataset.crashId = latest.id;
  banner.hidden = false;
}

/** Report a fault in the page itself, so interface bugs are not invisible. */
function reportClientError(kind, message, stack) {
  post('/api/crash', { kind, message, stack }).then(refreshCrashes).catch(() => {});
}

window.addEventListener('error', (e) => {
  if (e.target instanceof HTMLElement) return;   // resource errors handled elsewhere
  reportClientError(e.error?.name || 'Error', e.message, e.error?.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  reportClientError(r?.name || 'UnhandledRejection', r?.message || String(r), r?.stack);
});

$('#btn-crash-dismiss').addEventListener('click', () => {
  const id = $('#crash-banner').dataset.crashId;
  if (id) localStorage.setItem('skipCrash', id);
  $('#crash-banner').hidden = true;
});

$('#btn-crash-view').addEventListener('click', () => {
  const id = $('#crash-banner').dataset.crashId;
  const report = crashReports.find((r) => r.id === id);
  if (!report) return;
  confirmDialog({
    title: 'This is the whole report',
    message:
      'Nothing else is collected and nothing has been sent. File paths have already been replaced with ~ '
      + 'and your account name removed. Sharing opens a pre-filled issue on GitHub; you still have to press submit there, '
      + 'and GitHub issues are public.',
    list: report.body.split('\n'),
    okLabel: 'Close',
  });
});

$('#btn-crash-share').addEventListener('click', async () => {
  const id = $('#crash-banner').dataset.crashId;
  const report = crashReports.find((r) => r.id === id);
  if (!report) return;
  const ok = await confirmDialog({
    title: 'Open a public issue with this report?',
    message:
      'This opens GitHub in your browser with the report already filled in. Nothing is sent from here — '
      + 'you review it and press submit yourself. Paths are shown as ~ and your account name is removed, '
      + 'but the issue will be publicly visible once you submit it.',
    okLabel: 'Open GitHub',
  });
  if (!ok) return;
  openExternal(issueUrl({
    labels: 'crash',
    title: `Crash: ${$('#crash-note').textContent.slice(0, 90)}`,
    body: report.body,
  }));
});

/* ── Boot ───────────────────────────────────────────────────── */

/** Reload the last scan results the server still holds, so a page refresh
 *  does not throw away a two-minute walk. */
async function restoreCache() {
  const c = await api('/api/cache').catch(() => ({}));
  if (c.deep) { state.deep = c.deep; renderLarge(); renderOld(); renderDupes(); renderCategories(); renderDeepSummary(); }
  if (c.junk) { state.junk = c.junk; renderJunk(); }
  if (c.apps) { state.apps = c.apps; renderApps(); }
  if (c.home) { state.home = c.home; renderHomeMap(); }
  if (c.devtools) { state.devtools = c.devtools; renderDevTools(); }
}

(async function boot() {
  state.hw = await api('/api/hardware').catch(() => null);
  // The version comes from package.json via the server: one source of truth.
  if (state.hw?.version) {
    $('#app-version').textContent = `v${state.hw.version}`;
    document.title = `MacPuffin v${state.hw.version}`;
  }
  go(location.hash.slice(1) in VIEW_META ? location.hash.slice(1) : 'cockpit');
  await tickSystem();
  await restoreCache();
  await refreshCrashes();
  setInterval(tickSystem, 2500);
})();

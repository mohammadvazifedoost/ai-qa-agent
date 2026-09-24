/**
 * The dashboard is a single static page served by `ai-qa-agent ui`. Styling is Tailwind, compiled at
 * package build time into dist/ui/styles.css (see src/ui/tailwind.css). The page reads
 * /api/overview, links evidence under /files/, creates ClickUp tasks / Jira issues through
 * POST /api/file, deletes scenarios through POST /api/scenarios/delete, adds and edits them through
 * POST /api/scenarios/save (with AI drafts from /api/scenarios/draft) and writes one scenario's
 * test through POST /api/scenarios/test and runs it through POST /api/scenarios/run.
 * Whole runs (POST /api/runs/all, /api/runs/not-run) are background jobs polled through GET /api/job;
 * tracker connection status comes from GET /api/trackers.
 */
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI QA Agent — test results</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="grid min-h-screen grid-cols-1 lg:grid-cols-[272px_minmax(0,1fr)]">
  <aside class="bg-rail text-rail-ink lg:sticky lg:top-0 lg:h-screen lg:overflow-auto">
    <div class="px-5 pb-4 pt-5 lg:pb-5 lg:pt-6">
      <p class="m-0 text-[11.5px] font-bold uppercase tracking-[0.12em] text-rail-muted">AI QA Agent</p>
      <p class="m-0 mt-1 text-xl font-extrabold tracking-tight" id="project">…</p>
      <p class="m-0 mt-0.5 text-xs text-rail-muted break-all" id="url"></p>
      <label class="mt-4 block text-xs font-semibold text-rail-muted">Run
        <select id="run" class="rail-field mt-1" aria-label="Run"></select>
      </label>
      <p class="m-0 mt-1.5 text-xs text-rail-muted" id="runmeta"></p>
    </div>
    <nav class="border-t border-rail-line px-3 py-3" aria-label="Pages">
      <ul class="m-0 list-none p-0" id="nav"></ul>
    </nav>
    <div class="border-t border-rail-line px-5 py-4 text-[13px] text-rail-muted" id="tracker"></div>
  </aside>

  <main class="max-w-[1160px] px-4 pb-20 pt-5 md:px-8 md:pt-7">
    <div id="main"><p class="py-12 text-center text-muted">Loading…</p></div>
  </main>
</div>
<dialog id="modal" class="m-auto w-[min(1040px,calc(100vw-32px))] max-h-[calc(100vh-32px)] rounded-2xl border-0 bg-surface p-0 text-ink shadow-[0_24px_70px_rgba(11,31,42,.28)] max-sm:h-dvh max-sm:max-h-dvh max-sm:w-screen max-sm:max-w-none max-sm:rounded-none" aria-labelledby="m-title"></dialog>
<div id="toast" role="status" aria-live="polite" hidden class="fixed bottom-5 left-1/2 z-10 max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-bg shadow-lg"></div>
<script>
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const file = (p) => '/files/' + p.split('/').map(encodeURIComponent).join('/');
let data;
let view = { page: '', only: 'all', type: '', q: '', includeNotRun: false };

async function load(runId) {
  const res = await fetch('/api/overview' + (runId ? '?run=' + encodeURIComponent(runId) : ''));
  data = await res.json();
  render();
  loadTrackers(false);
  if (data.job?.status === 'running') watchJob();
  // Tracker verification happens after the first paint so the page never waits for it.
  if (data.run?.tasksPending) {
    const runId = data.run.id;
    try {
      const t = await (await fetch('/api/tasks?run=' + encodeURIComponent(runId))).json();
      if (data.run && data.run.id === runId) { data.run.tasks = t.tasks || {}; data.run.tasksPending = false; refreshActions(); }
    } catch { if (data.run && data.run.id === runId) { data.run.tasksPending = false; refreshActions(); } }
  }
}

/** Re-render only the action cells (and the open modal's footer) once the tracker answered. */
function refreshActions() {
  for (const cell of document.querySelectorAll('[data-action-for]')) {
    const sc = data.scenarios.find((x) => x.id === cell.dataset.actionFor);
    if (sc) cell.innerHTML = action(sc, statusOf(sc.id));
  }
  const modal = $('#modal');
  if (modal.open && modal.dataset.mode === 'view') openModal(modal.dataset.id, modal.dataset.notice);
}

/* ---------- joins ---------- */
const outcomesFor = (id) => data.run ? data.run.outcomes.filter((o) => o.scenarioId === id) : [];
/** A test run again on its own after the analysis: the analysis describes an earlier failure. */
const rerunOf = (key) => data.run?.outcomes.find((o) => o.key === key)?.rerunAt;
const failureFor = (key) => rerunOf(key) ? undefined : data.run?.failures.find((f) => f.key === key);
const issueFor = (key) => rerunOf(key) ? undefined : data.run?.issues.find((i) => i.failureKeys.includes(key));
function statusOf(id) {
  const s = outcomesFor(id).map((o) => o.status);
  if (!s.length) return 'none';
  if (s.includes('failed')) return 'failed';
  if (s.includes('flaky')) return 'flaky';
  return s.every((x) => x === 'skipped') ? 'none' : 'passed';
}
function failingOutcome(sc) {
  const outs = outcomesFor(sc.id).filter((o) => o.status === 'failed' || o.status === 'flaky');
  return outs.find((o) => issueFor(o.key)) ?? outs[0] ?? null;
}
function classificationOf(sc) {
  const f = outcomesFor(sc.id).map((o) => failureFor(o.key)).find(Boolean);
  return f ? f.classification : null;
}
const isBug = (c) => c === 'PRODUCT_BUG' || c === 'DESIGN_MISMATCH';
const human = (c) => c ? c.replace('_', ' ').toLowerCase() : '';
const typeChip = (sc) => '<span class="chip chip-' + esc(sc.category) + '">' + esc(sc.category) + '</span>' +
  (sc.origin === 'person' ? ' <span class="chip chip-person" title="Written or edited by a person; the AI will not change or remove it">yours</span>' : '');
const TEST_STATE = { missing: 'no test yet', outdated: 'test out of date' };
const testChip = (sc) => data.testStates[sc.id] ? ' <span class="chip chip-todo">' + TEST_STATE[data.testStates[sc.id]] + '</span>' : '';
const addButton = () => data.authoring.pages.length ? '<button class="btn" onclick="openEditor()">Add scenario</button>' : '';
const fmtRun = (id) => id.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2');

/* ---------- bug trackers in the rail ---------- */
let trackers = null;
async function loadTrackers(fresh) {
  try {
    const t = await (await fetch('/api/trackers' + (fresh ? '?fresh=1' : ''))).json();
    trackers = t.trackers;
  } catch { trackers = null; }
  renderTrackers();
}
const TRACKER_STATE = {
  connected: ['text-pass', 'Connected'],
  'missing-credentials': ['text-flaky', 'Credentials missing'],
  error: ['text-fail', 'Cannot connect'],
  'not-configured': ['text-rail-muted', 'Not configured'],
};
function renderTrackers() {
  const el = $('#tracker');
  const head = '<b class="block text-[11.5px] font-bold uppercase tracking-[0.12em] text-rail-muted">Bug trackers</b>';
  if (!trackers) { el.innerHTML = head + '<span class="mt-1 block">Checking…</span>'; return; }
  el.innerHTML = head + trackers.map((t) => {
    const [cls, label] = TRACKER_STATE[t.state];
    const detail = t.state === 'connected' ? esc(t.detail)
      : t.state === 'missing-credentials' ? 'Set ' + t.missingEnv.map((v) => '<code class="font-mono">' + esc(v) + '</code>').join(' and ') + ' in the shell that started ai-qa-agent ui.'
      : t.state === 'error' ? esc(String(t.detail || '').split('\n')[0].slice(0, 160))
      : 'Add a <code class="font-mono">' + t.kind + '</code> section to .qa/config.ts to file bugs here.';
    return '<div class="mt-2.5"><div class="flex items-center justify-between gap-2"><span class="font-semibold text-rail-ink">' + esc(t.name) + '</span>' +
      '<span class="text-xs font-bold ' + cls + '">' + label + '</span></div>' +
      '<p class="m-0 mt-0.5 text-xs leading-snug">' + (t.active ? 'Bugs are filed here' + (t.target ? ' · ' + esc(t.target) : '') + '. ' : '') + detail + '</p></div>';
  }).join('');
}

/* ---------- whole runs (background jobs) ---------- */
let jobTimer;
/** The job this page started or saw running; its outcome is shown until dismissed. */
let watched = null;
function toolbar(notRunWithTest) {
  const busy = data.job?.status === 'running';
  const dis = busy ? ' disabled title="' + esc(data.job.label) + '…"' : '';
  return '<div class="flex flex-wrap items-center gap-2">' +
    '<button class="btn-quiet" onclick="refreshAll(this)" title="Reload results and re-check the bug trackers">Refresh</button>' +
    (notRunWithTest ? '<button class="btn btn-ghost"' + dis + ' onclick="startJob(\'/api/runs/not-run\')" title="Run every test without a result in this run and add the results to it">Run not-run tests (' + notRunWithTest + ')</button>' : '') +
    '<button class="btn btn-ghost"' + dis + ' onclick="startJob(\'/api/runs/all\')" title="Start a new run with every test, like ai-qa-agent test">Run all tests</button>' +
    addButton() + '</div>';
}
function jobBanner() {
  const j = data.job;
  if (!j || !watched || j.startedAt !== watched) return '';
  const since = new Date(j.startedAt).toLocaleTimeString();
  if (j.status === 'running') {
    return '<section class="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface px-5 py-4" role="status" aria-live="polite">' +
      '<span class="size-2.5 animate-pulse rounded-full bg-accent" aria-hidden="true"></span>' +
      '<p class="m-0 text-sm font-semibold">' + esc(j.label) + '…</p><p class="m-0 text-[13px] text-muted">Started ' + esc(since) + '. The results appear here when Playwright is done.</p></section>';
  }
  const ok = j.status === 'done';
  return '<section class="mb-6 flex flex-wrap items-center gap-3 rounded-2xl px-5 py-4 ' + (ok ? 'bg-accent-soft' : 'bg-fail-soft') + '" role="status">' +
    '<p class="m-0 min-w-0 flex-1 text-sm font-semibold ' + (ok ? 'text-accent' : 'text-fail') + '">' + esc(ok ? j.message : 'Could not finish: ' + j.message) + '</p>' +
    '<button class="btn-quiet" onclick="watched=null;render()">Dismiss</button></section>';
}
async function startJob(url) {
  let out = {}, ok = false;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: data.run?.id }) });
    out = await res.json(); ok = res.ok;
  } catch (err) { out = { error: String(err) }; }
  if (!ok) { toast(out.error || 'Could not start the run.'); return; }
  data.job = out;
  watchJob();
}
function watchJob() {
  watched = data.job.startedAt;
  render();
  clearTimeout(jobTimer);
  jobTimer = setTimeout(pollJob, 2000);
}
async function pollJob() {
  let j = null;
  try { j = (await (await fetch('/api/job')).json()).job; } catch { /* server restarting: try again */ }
  if (j && j.status !== 'running') {
    // A new full run is shown when it is done; other jobs updated the run being viewed.
    await load(j.kind === 'run-all' ? j.runId : (j.runId ?? data.run?.id));
    watched = j.startedAt;
    render();
    return;
  }
  jobTimer = setTimeout(pollJob, 2000);
}
async function refreshAll(btn) {
  btn.disabled = true; btn.textContent = 'Refreshing…';
  await load(data.run?.id);
  await loadTrackers(true);
}

/* ---------- render ---------- */
function render() {
  $('#project').textContent = data.project.name;
  $('#url').textContent = data.project.baseUrl;
  const sel = $('#run');
  sel.innerHTML = data.runs.map((r) => '<option value="' + esc(r.id) + '"' + (data.run && r.id === data.run.id ? ' selected' : '') + '>' + esc(fmtRun(r.id)) + '</option>').join('');
  sel.onchange = () => load(sel.value);
  const runInfo = data.runs.find((r) => data.run && r.id === data.run.id);
  $('#runmeta').textContent = runInfo ? (runInfo.stats.passed + runInfo.stats.failed + runInfo.stats.flaky) + ' tests · ' + runInfo.status : '';

  renderTrackers();

  const main = $('#main');
  const empty = (msg) => '<div class="rounded-2xl border border-dashed border-line-strong px-6 py-14 text-center text-muted">' + msg + '</div>';
  const orAdd = data.authoring.pages.length ? '<p class="mb-0 mt-4">' + addButton() + '</p>' : '';
  if (!data.scenarios.length) { $('#nav').innerHTML = ''; main.innerHTML = empty('No scenarios yet. Run <code class="font-mono text-[13px]">ai-qa-agent scenarios</code> first, or write your own.' + orAdd); return; }

  const all = data.scenarios.map((sc) => ({ sc, status: statusOf(sc.id) }));
  const inRun = all.filter((x) => x.status !== 'none');
  const pages = [...new Set(all.map((x) => x.sc.page))].sort();

  // Rail: pages with a heat strip (one cell per test in this run) and counts.
  $('#nav').innerHTML = ['', ...pages].map((p) => {
    const rows = (p ? all.filter((x) => x.sc.page === p) : all).filter((x) => x.status !== 'none');
    const fail = rows.filter((x) => x.status !== 'passed').length;
    return '<li class="my-0.5"><button class="rail-btn" aria-current="' + (view.page === p) + '" onclick="setPage(\'' + esc(p) + '\')">' +
      '<span class="flex w-full items-center justify-between gap-2"><span class="truncate font-semibold">' + (p ? esc(p) : 'All pages') + '</span>' +
      '<span class="shrink-0 text-xs ' + (fail ? 'font-bold text-fail' : 'text-rail-muted') + '">' + (rows.length ? (fail ? fail + ' failing' : rows.length + ' passed') : 'not in run') + '</span></span>' +
      (rows.length ? '<span class="flex flex-wrap gap-[3px]" aria-hidden="true">' + rows.map((x) => '<i class="cell cell-' + x.status + '"></i>').join('') + '</span>' : '') +
      '</button></li>';
  }).join('');

  const s = data.run?.stats ?? { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  const ran = s.passed + s.failed + s.flaky;
  const defects = data.run?.issues.length ?? 0;
  const byType = ['functional', 'visual', 'responsive'].map((t) => {
    const rows = inRun.filter((x) => x.sc.category === t);
    return { t, total: rows.length, failed: rows.filter((x) => x.status !== 'passed').length };
  }).filter((x) => x.total);

  let html = '<div class="mb-6 flex flex-wrap items-end justify-between gap-3"><div>' +
    '<h1 class="m-0 text-[28px] font-extrabold tracking-tight">Test results</h1>' +
    '<p class="m-0 mt-1 text-sm text-muted">' + (data.run ? 'Run ' + esc(fmtRun(data.run.id)) + ' against ' + esc(data.project.baseUrl) : 'No test run yet. Run a test below, or all of them with <code class="font-mono text-[13px]">ai-qa-agent test</code>.') + '</p></div>' + toolbar(all.filter((x) => x.status === 'none' && x.sc.approved && data.testStates[x.sc.id] !== 'missing').length) + '</div>' + jobBanner();

  if (data.run) html += '<section class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center rounded-2xl border border-line bg-surface p-5 md:p-6" aria-label="Verdict">' +
    ring(s, ran) +
    '<div><p class="m-0 text-[13px] font-semibold text-muted">By test type</p><div class="mt-2 grid gap-2">' +
    byType.map((b) => '<div class="grid grid-cols-[92px_minmax(0,1fr)_64px] items-center gap-3 text-sm"><span class="chip chip-' + b.t + ' justify-self-start">' + b.t + '</span>' +
      '<span class="flex h-2 overflow-hidden rounded-full bg-line"><span class="block h-full bg-pass" style="width:' + (100 * (b.total - b.failed) / b.total) + '%"></span><span class="block h-full bg-fail" style="width:' + (100 * b.failed / b.total) + '%"></span></span>' +
      '<span class="text-right text-[13px] text-muted">' + (b.total - b.failed) + '/' + b.total + '</span></div>').join('') +
    '</div></div>' +
    '<div class="md:border-l md:border-line md:pl-6"><p class="m-0 text-[13px] font-semibold text-muted">Distinct defects</p>' +
    '<p class="m-0 mt-1 text-[36px] font-extrabold leading-none tracking-tight ' + (defects ? 'text-fail' : 'text-pass') + '">' + defects + '</p>' +
    '<p class="m-0 mt-1 text-[13px] text-muted">' + (defects ? 'across ' + s.failed + ' failing tests' : 'nothing to report') + '</p></div></section>';

  const q = view.q.trim().toLowerCase();
  const rows = all.filter((x) => (!view.page || x.sc.page === view.page) &&
    (view.only === 'all' ? true : view.only === 'failed' ? x.status === 'failed' || x.status === 'flaky' : view.only === 'todo' ? !!data.testStates[x.sc.id] : view.only === 'notrun' ? x.status === 'none' : x.status === 'passed') &&
    (!view.type || x.sc.category === view.type) &&
    (!q || x.sc.id.toLowerCase().includes(q) || x.sc.title.toLowerCase().includes(q)) &&
    // Not-run scenarios are hidden by default, except your own and ones still waiting for a test.
    (!data.run || view.includeNotRun || view.only === 'notrun' || x.status !== 'none' || x.sc.origin === 'person' || !!data.testStates[x.sc.id]));
  const todo = all.filter((x) => data.testStates[x.sc.id]).length;
  const notRun = data.run ? all.length - inRun.length : 0;
  if ((view.only === 'todo' && !todo) || (view.only === 'notrun' && !notRun)) view.only = 'all';
  const types = [...new Set(all.map((x) => x.sc.category))].sort();
  html += '<div class="sticky top-0 z-10 -mx-4 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 bg-bg/95 px-4 py-2.5 backdrop-blur md:-mx-8 md:px-8">' +
    '<div class="inline-flex overflow-hidden rounded-lg border border-line-strong bg-surface" role="group" aria-label="Show">' +
    ['all', 'failed', 'passed', ...(notRun ? ['notrun'] : []), ...(todo ? ['todo'] : [])].map((k) => '<button class="seg-btn" aria-pressed="' + (view.only === k) + '" onclick="setOnly(\'' + k + '\')">' + ({ all: 'All', failed: 'Failures', passed: 'Passing', notrun: 'Not run (' + notRun + ')', todo: 'Needs test (' + todo + ')' })[k] + '</button>').join('') + '</div>' +
    '<select class="field" aria-label="Type" onchange="view.type=this.value;render()"><option value="">All types</option>' +
    types.map((t) => '<option value="' + esc(t) + '"' + (view.type === t ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select>' +
    '<input class="field w-52" type="search" placeholder="Search id or title" value="' + esc(view.q) + '" oninput="view.q=this.value;render();this.focus();this.setSelectionRange(this.value.length,this.value.length)" aria-label="Search">' +
    '<label class="flex items-center gap-1.5 text-sm text-muted"><input type="checkbox" ' + (view.includeNotRun ? 'checked' : '') + ' onchange="view.includeNotRun=this.checked;render()"> include not run</label>' +
    '<span class="ml-auto text-[13px] text-muted">' + rows.length + ' of ' + all.length + '</span></div>';

  if (!rows.length) html += empty('Nothing matches this filter.');
  for (const page of pages) {
    const group = rows.filter((x) => x.sc.page === page);
    if (!group.length) continue;
    const fails = group.filter((x) => x.status === 'failed' || x.status === 'flaky').length;
    html += '<div class="mb-2 mt-7 flex items-baseline gap-2.5"><h2 class="m-0 font-mono text-[15px] font-semibold">' + esc(page) + '</h2><span class="text-[13px] text-muted">' + group.length + ' scenarios' + (fails ? ' · <span class="font-semibold text-fail">' + fails + ' failing</span>' : '') + '</span></div>' +
      '<ul class="m-0 list-none overflow-hidden rounded-xl border border-line bg-surface p-0">';
    for (const { sc, status } of group) html += row(sc, status);
    html += '</ul>';
  }
  main.innerHTML = html;
  requestAnimationFrame(() => document.querySelectorAll('.ring-arc').forEach((el) => { el.style.strokeDashoffset = el.dataset.to; }));
}

/** Pass-ratio ring: passed (green) and flaky (amber) arcs over a failed (red) track. */
function ring(s, ran) {
  const r = 46, c = 2 * Math.PI * r;
  const pass = ran ? s.passed / ran : 0, flaky = ran ? s.flaky / ran : 0;
  const arc = (frac, offsetFrac, cls) => '<circle class="ring-arc" cx="60" cy="60" r="' + r + '" fill="none" stroke="var(--color-' + cls + ')" stroke-width="12" stroke-linecap="butt" ' +
    'stroke-dasharray="' + c + '" stroke-dashoffset="' + c + '" data-to="' + (c - c * frac) + '" transform="rotate(' + (-90 + 360 * offsetFrac) + ' 60 60)"></circle>';
  return '<div class="flex items-center gap-5"><svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label="' + s.passed + ' of ' + ran + ' tests passed">' +
    '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="var(--color-' + (s.failed ? 'fail' : 'line') + ')" stroke-width="12"></circle>' +
    arc(pass, 0, 'pass') + (flaky ? arc(flaky, pass, 'flaky') : '') +
    '<text x="60" y="58" text-anchor="middle" font-size="26" font-weight="800" fill="var(--color-ink)" font-family="Manrope, sans-serif">' + Math.round(pass * 100) + '%</text>' +
    '<text x="60" y="76" text-anchor="middle" font-size="11" font-weight="600" fill="var(--color-muted)" font-family="Manrope, sans-serif">passed</text></svg>' +
    '<div class="text-sm"><p class="m-0 text-[30px] font-extrabold leading-none tracking-tight">' + s.passed + '<span class="text-lg font-semibold text-muted">/' + ran + '</span></p>' +
    '<p class="m-0 mt-2 text-muted"><span class="font-semibold text-pass">' + s.passed + ' passed</span> · <span class="font-semibold text-fail">' + s.failed + ' failed</span>' + (s.flaky ? ' · <span class="font-semibold text-flaky">' + s.flaky + ' flaky</span>' : '') + '</p></div></div>';
}

function row(sc, status) {
  const cls = classificationOf(sc);
  const failing = status === 'failed' || status === 'flaky';
  const chips = typeChip(sc) + testChip(sc) + (failing ? '<span class="chip ' + (cls && isBug(cls) ? 'chip-bug' : 'chip-other') + '">' + esc(cls ? human(cls) : 'not analyzed') + '</span>' : '');
  return '<li class="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-3.5 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[14px_118px_minmax(0,1fr)_auto] ' + (failing ? 'row-' + status : '') + '">' +
    '<button class="group col-span-2 grid min-w-0 cursor-pointer grid-cols-subgrid items-center gap-3.5 border-0 bg-transparent p-0 text-left text-inherit sm:col-span-3" onclick="openModal(\'' + esc(sc.id) + '\')" aria-haspopup="dialog">' +
    '<span class="dot dot-' + status + '" aria-label="' + status + '"></span>' +
    '<span class="hidden font-mono text-[12.5px] text-muted sm:block">' + esc(sc.id) + '</span>' +
    '<span class="flex min-w-0 items-center gap-2"><span class="min-w-0 truncate font-medium group-hover:text-accent">' + esc(sc.title) + '</span><span class="flex shrink-0 gap-1.5">' + chips + '</span>' +
    '<span class="ml-1 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true">›</span></span></button>' +
    '<span class="col-start-2 flex items-center gap-2.5 whitespace-nowrap sm:col-start-4" data-action-for="' + esc(sc.id) + '">' + action(sc, status) + '</span></li>';
}

function action(sc, status) {
  if (status === 'none') {
    return sc.approved && data.testStates[sc.id] !== 'missing' ? '<button class="btn btn-ghost" onclick="event.stopPropagation(); runTest(this, \'' + esc(sc.id) + '\')">Run test</button>' : '';
  }
  if (status !== 'failed' && status !== 'flaky') return '';
  const tr = data.tracker;
  if (!tr.configured) return '';
  const o = failingOutcome(sc);
  if (!o) return '';
  if (data.run.tasksPending) return '<span class="text-xs text-muted" aria-live="polite">checking ' + esc(tr.name) + '…</span>';
  const task = data.run.tasks[o.key];
  if (task && task.exists) {
    return '<a class="btn btn-ghost" href="' + esc(task.url || '#') + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="' + esc(task.status ? 'Status in ' + tr.name + ': ' + task.status : '') + '">' + (tr.noun === 'issue' ? 'Open ' + esc(task.taskId) : 'Open task ' + esc(task.taskId)) + '</a>';
  }
  const issue = issueFor(o.key);
  const body = issue ? { issueId: issue.id } : { failureKey: o.key };
  const disabled = tr.tokenPresent ? '' : 'disabled title="' + 'Set ' + esc(tr.missingEnv.join(' and ')) + ' in the shell that started ai-qa-agent ui"';
  return '<button class="btn" ' + disabled + ' onclick="event.stopPropagation(); fileBug(this, ' + esc(JSON.stringify(body)) + ')">Create ' + tr.noun + '</button>';
}

async function fileBug(btn, body) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Creating…';
  const res = await fetch('/api/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: data.run.id, ...body }) });
  const out = await res.json();
  if (!res.ok) { btn.disabled = false; btn.textContent = label; alert('Could not create the ' + data.tracker.noun + ': ' + (out.error || out.reason || res.status)); return; }
  const open = $('#modal').open ? $('#modal').dataset.id : null;
  await load(data.run.id);
  if (open) openModal(open);
}

/* ---------- modal ---------- */
function openModal(id, notice) {
  const sc = data.scenarios.find((x) => x.id === id);
  if (!sc) return;
  const status = statusOf(id);
  const outs = outcomesFor(id);
  const modal = $('#modal');
  modal.dataset.id = id;
  modal.dataset.mode = 'view';
  modal.dataset.notice = notice || '';
  let left = '', right = '';
  const section = (title, body) => '<section class="mb-[22px]">' + (title ? '<h3 class="section-title">' + title + '</h3>' : '') + body + '</section>';
  if (notice) left += section('', '<p class="m-0 rounded-lg bg-accent-soft px-3 py-2.5 text-sm font-semibold text-accent" role="status">' + esc(notice) + '</p>');
  if (outs.length === 0) left += section('', '<p class="m-0 text-base font-semibold">This scenario was not part of the selected run.</p>');
  for (const o of outs) {
    const f = failureFor(o.key), issue = issueFor(o.key);
    if (o.rerunAt) left += section('', '<p class="m-0 text-[13px] text-muted">Run on its own at ' + esc(new Date(o.rerunAt).toLocaleString()) + (o.status === 'passed' ? '' : '; not analyzed by the AI yet') + '.</p>');
    if (outs.length > 1) left += '<h3 class="section-title">' + esc(o.project) + '</h3>';
    if (o.status === 'passed') left += section('', '<p class="m-0 text-base font-semibold text-pass">Passed' + (o.attempts > 1 ? ' after ' + o.attempts + ' attempts' : '') + '.</p>');
    if (f || issue) {
      left += section('What happened',
        '<p class="mb-2 mt-0 text-base font-semibold">' + esc(issue ? issue.bug.title : f.summary) + '</p>' +
        (f ? '<p class="m-0 text-sm text-muted">' + esc(human(f.classification)) + ' · ' + Math.round(f.confidence * 100) + '% confidence' + (issue ? ' · ' + esc(issue.bug.severity) + ' severity' : '') + '</p>' : '') +
        (issue ? '<p class="mt-2 mb-0 text-sm text-muted">Root cause: <code class="font-mono text-[12.5px] text-ink">' + esc(issue.bug.suspectedRootCause) + '</code></p>'
               : (f?.testProblem ? '<p class="mt-2 mb-0 text-sm text-muted">Test problem: ' + esc(f.testProblem) + '</p>' : '')));
      if (issue) left += section('Expected vs actual', '<p class="mb-1.5 mt-0"><b>Expected</b> ' + esc(issue.bug.expectedResult) + '</p><p class="m-0"><b>Actual</b> ' + esc(issue.bug.actualResult) + '</p>');
    } else if (o.status !== 'passed') {
      left += section('', '<p class="m-0 text-base font-semibold">Failed; not analyzed yet (run <code class="font-mono text-[13px]">ai-qa-agent triage</code>).</p>');
    }
    if (o.error) left += section('', '<details class="disclosure"><summary>Test error</summary><pre class="mt-2.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 font-mono text-xs">' + esc(o.error.message) + '</pre></details>');
    const a = o.artifacts;
    if (a.screenshots[0] || a.video) {
      right += section('Evidence' + (outs.length > 1 ? ' · ' + esc(o.project) : ''),
        (a.screenshots[0] ? '<a href="' + file(a.screenshots[0]) + '" target="_blank" rel="noopener"><img class="block max-w-full rounded-[10px] border border-line" loading="lazy" src="' + file(a.screenshots[0]) + '" alt="Final screenshot of ' + esc(o.key) + '"></a>' : '') +
        (a.video ? '<video class="mt-3 block w-full rounded-[10px] bg-black" controls preload="metadata" src="' + file(a.video) + '"></video>' : '') +
        '<div class="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">' + link(a.trace, 'Trace') + link(a.logs, 'Console & network', true) + link(a.errorContext, 'Page snapshot', true) +
        a.design.map((d) => link(d, d.split('_design-').pop().replace('.png', '').replace(/-/g, ' '), true)).join('') + '</div>');
    }
  }
  left += section('', '<details class="disclosure"><summary>Scenario steps and expected results</summary><ol class="mt-2 list-decimal pl-5 text-sm">' + sc.steps.map((x) => '<li class="my-0.5">' + esc(x) + '</li>').join('') + '</ol>' +
    '<h3 class="section-title mt-3">Expected</h3><ul class="mt-2 list-disc pl-5 text-sm">' + sc.expectedResults.map((x) => '<li class="my-0.5">' + esc(x) + '</li>').join('') + '</ul></details>');

  let foot = '';
  if (status === 'failed' || status === 'flaky') {
    foot = action(sc, status);
    const o = failingOutcome(sc);
    if (foot && o && !issueFor(o.key)) foot += '<span class="text-[13px] text-muted">Not confirmed as a product bug by the analyzer — the ' + data.tracker.noun + ' will be labelled needs-verification.</span>';
  }
  modal.innerHTML = '<div class="flex items-start gap-4 border-b border-line px-5 pb-4 pt-5 md:px-6 md:pt-[22px]"><div class="min-w-0">' +
    '<span class="pill pill-' + status + '">' + (status === 'none' ? 'not run' : status) + '</span> ' + typeChip(sc) +
    '<h2 id="m-title" class="mb-1 mt-1.5 text-xl font-extrabold tracking-tight">' + esc(sc.title) + '</h2>' +
    '<div class="text-[13px] text-muted"><span class="font-mono text-[12.5px]">' + esc(sc.id) + '</span> · ' + esc(sc.page) + ' · ' + esc(sc.viewport) + ' · ' + esc(sc.priority) + ' priority</div></div>' +
    '<button class="ml-auto size-[34px] shrink-0 cursor-pointer rounded-full border-0 bg-line text-lg leading-none text-ink hover:bg-line-strong" onclick="document.getElementById(\'modal\').close()" aria-label="Close">×</button></div>' +
    '<div class="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-auto px-5 py-5 md:grid-cols-[minmax(300px,1fr)_minmax(300px,1.25fr)] md:px-6"><div>' + left + '</div><div>' + right + '</div></div>' +
    '<div class="flex flex-wrap items-center gap-3 border-t border-line bg-bg px-5 py-3.5 md:px-6">' + testArea(sc) + foot + deleteArea(sc.id) + '</div>';
  if (!modal.open) modal.showModal();
}

/* ---------- write one scenario's test ---------- */
function testArea(sc) {
  if (!sc.approved) return '';
  const state = data.testStates[sc.id];
  const label = state === 'missing' ? 'Create test' : 'Rewrite test';
  const hint = state === 'missing' ? 'This scenario has no test yet.' : state === 'outdated' ? 'The scenario changed after its test was written.' : '';
  const ran = statusOf(sc.id) !== 'none';
  const run = state === 'missing' ? '' : '<button id="run-btn" class="' + (state ? 'btn-quiet' : ran ? 'btn btn-ghost' : 'btn') + '" onclick="runTest(this, \'' + esc(sc.id) + '\')" title="Run only this test with Playwright and update its result in this run">' + (ran ? 'Run again' : 'Run test') + '</button>';
  return '<div id="test-area" class="flex flex-wrap items-center gap-2">' + (state ? '' : run) +
    '<button id="test-btn" class="' + (state ? 'btn' : 'btn-quiet') + '" onclick="writeTest(\'' + esc(sc.id) + '\')" title="The AI writes only this scenario' + "'" + 's test; the other tests in the file are not changed">' + label + '</button>' + (state ? run : '') +
    '<span id="test-status" class="text-[13px] text-muted" aria-live="polite">' + hint + '</span></div>';
}
async function writeTest(id) {
  const btn = $('#test-btn');
  if (!btn || btn.disabled) return;
  btn.disabled = true; btn.textContent = 'Writing test…';
  $('#test-status').textContent = 'The AI is writing the test and Playwright is checking it. This can take a few minutes.';
  let out = {}, ok = false;
  try {
    const res = await fetch('/api/scenarios/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    out = await res.json(); ok = res.ok;
  } catch (err) { out = { error: String(err) }; }
  const modal = $('#modal');
  const stillHere = modal.open && modal.dataset.mode === 'view' && modal.dataset.id === id;
  if (!ok) {
    if (stillHere) {
      btn.disabled = false; btn.textContent = data.testStates[id] === 'missing' ? 'Create test' : 'Rewrite test';
      $('#test-status').innerHTML = '<span class="text-fail">Could not write the test: ' + esc(out.error || 'unknown error') + '</span>';
    } else toast('Could not write the test for ' + id + ': ' + (out.error || 'unknown error'));
    return;
  }
  const done = (out.action === 'generated' ? 'Generated ' + out.file + ' with the tests of every scenario on ' + out.page : (out.action === 'added' ? 'Added the test for ' : 'Rewrote the test for ') + id + ' in ' + out.file) + '. Run ai-qa-agent test to execute it.';
  await load(data.run?.id);
  if (stillHere) openModal(id, done); else toast(done);
}

async function runTest(btn, id) {
  if (btn.disabled) return;
  const label = btn.textContent;
  const inModal = !!btn.closest('#modal');
  btn.disabled = true; btn.textContent = 'Running…';
  if (inModal) $('#test-status').textContent = 'Playwright is running this test. This can take a minute.';
  let out = {}, ok = false;
  try {
    const res = await fetch('/api/scenarios/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, runId: data.run?.id }) });
    out = await res.json(); ok = res.ok;
  } catch (err) { out = { error: String(err) }; }
  const modal = $('#modal');
  const modalHere = modal.open && modal.dataset.mode === 'view' && modal.dataset.id === id;
  if (!ok) {
    const msg = 'Could not run ' + id + ': ' + (out.error || 'unknown error');
    if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
    if (modalHere && $('#test-status')) $('#test-status').innerHTML = '<span class="text-fail">' + esc(msg) + '</span>';
    else toast(msg);
    return;
  }
  const summary = id + ' ' + out.outcomes.map((o) => o.status + (out.outcomes.length > 1 ? ' (' + o.project + ')' : '')).join(', ') +
    (out.merged ? '. Its result in this run was updated.' : '. Started a new run with it.');
  await load(out.runId);
  if (modalHere) openModal(id, summary); else toast(summary);
}

/* ---------- delete scenario (inline confirm in the modal footer) ---------- */
function deleteArea(id) {
  return '<div id="del-area" class="ml-auto flex flex-wrap items-center justify-end gap-2">' +
    '<button class="btn-quiet" onclick="openEditor(\'' + esc(id) + '\')">Edit scenario</button>' +
    '<button class="btn-quiet btn-quiet-danger" onclick="askDelete(\'' + esc(id) + '\')">Delete scenario</button></div>';
}
function askDelete(id) {
  const area = $('#del-area');
  area.innerHTML = '<span class="text-[13px] text-muted">Delete <span class="font-mono text-[12.5px] text-ink">' + esc(id) + '</span> and its test?</span>' +
    '<input id="del-reason" class="field w-48 py-[5px]" placeholder="Reason (optional)" aria-label="Reason for deleting (optional)" maxlength="200">' +
    '<button class="btn-quiet" onclick="cancelDelete(\'' + esc(id) + '\')">Cancel</button>' +
    '<button id="del-confirm" class="btn btn-danger" onclick="confirmDelete(\'' + esc(id) + '\')">Delete</button>' +
    '<p id="del-error" class="m-0 w-full text-right text-[13px] text-fail" role="alert"></p>';
  const input = $('#del-reason');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmDelete(id); });
  input.focus();
}
function cancelDelete(id) { $('#del-area').outerHTML = deleteArea(id); }
async function confirmDelete(id) {
  const btn = $('#del-confirm');
  if (!btn || btn.disabled) return;
  btn.disabled = true; btn.textContent = 'Deleting…';
  const reason = $('#del-reason').value.trim();
  let out = {}, ok = false;
  try {
    const res = await fetch('/api/scenarios/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, reason: reason || undefined }) });
    out = await res.json(); ok = res.ok;
  } catch (err) { out = { error: String(err) }; }
  if (!ok) { btn.disabled = false; btn.textContent = 'Delete'; $('#del-error').textContent = 'Could not delete: ' + (out.error || 'unknown error'); return; }
  $('#modal').close();
  await load(data.run?.id);
  toast(id + ' deleted' + (out.spec === 'test-removed' ? ' and its test removed' : '') + '. Undo: ai-qa-agent scenarios restore ' + id);
}
/* ---------- add / edit scenario (form in the modal) ---------- */
const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
const options = (list, selected) => list.map((v) => '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
function field(id, label, control, hint) {
  return '<div><label for="' + id + '" class="block text-sm font-semibold">' + label + (hint ? ' <span class="font-normal text-muted">' + hint + '</span>' : '') + '</label>' + control + '</div>';
}
const textarea = (id, value, rows) => '<textarea id="' + id + '" rows="' + rows + '" class="field mt-1 block w-full resize-y font-sans leading-snug">' + esc((value || []).join('\n')) + '</textarea>';

function openEditor(id) {
  const sc = id ? data.scenarios.find((x) => x.id === id) : null;
  const a = data.authoring;
  const modal = $('#modal');
  modal.dataset.id = id || '';
  modal.dataset.mode = 'edit';
  const pages = sc && !a.pages.includes(sc.page) ? [sc.page, ...a.pages] : a.pages;
  const page = sc ? sc.page : (view.page && pages.includes(view.page) ? view.page : pages[0]);
  const close = 'document.getElementById(\'modal\').close()';
  const draft = sc ? '' :
    '<section class="mb-5 rounded-xl bg-accent-soft p-4">' +
    field('f-desc', 'Describe the test', '<textarea id="f-desc" rows="2" class="field mt-1 block w-full resize-y font-sans" placeholder="e.g. Applying the coupon SAVE10 takes 10% off the total"></textarea>', '(optional)') +
    '<div class="mt-2 flex flex-wrap items-center gap-3"><button type="button" id="f-draft" class="btn" onclick="draftWithAi()">Draft with AI</button>' +
    '<span id="f-draft-status" class="text-[13px] text-muted" aria-live="polite">The AI fills in the fields below for you to review.</span></div></section>';
  modal.innerHTML = '<div class="flex items-start gap-4 border-b border-line px-5 pb-4 pt-5 md:px-6 md:pt-[22px]"><div class="min-w-0">' +
    '<h2 id="m-title" class="m-0 text-xl font-extrabold tracking-tight">' + (sc ? 'Edit scenario' : 'Add scenario') + '</h2>' +
    '<p class="m-0 mt-1 text-[13px] text-muted">' + (sc ? '<span class="font-mono text-[12.5px]">' + esc(sc.id) + '</span> · ' + esc(sc.page) : 'Scenarios you write are yours: the AI will not change or remove them.') + '</p></div>' +
    '<button type="button" class="ml-auto size-[34px] shrink-0 cursor-pointer rounded-full border-0 bg-line text-lg leading-none text-ink hover:bg-line-strong" onclick="' + close + '" aria-label="Close">×</button></div>' +
    '<form id="f" class="min-h-0 flex-1 overflow-auto px-5 py-5 md:px-6" onsubmit="event.preventDefault(); saveEditor()">' + draft +
    '<div class="grid grid-cols-1 gap-4 md:grid-cols-2">' +
    '<div class="md:col-span-2">' + field('f-title', 'Title', '<input id="f-title" class="field mt-1 block w-full" required value="' + esc(sc?.title) + '">') + '</div>' +
    field('f-page', 'Page', '<select id="f-page" class="field mt-1 block w-full"' + (sc ? ' disabled' : '') + '>' + options(pages, page) + '</select>') +
    field('f-viewport', 'Viewport', '<select id="f-viewport" class="field mt-1 block w-full">' + options(a.viewports, sc?.viewport ?? a.viewports[0]) + '</select>') +
    field('f-category', 'Type', '<select id="f-category" class="field mt-1 block w-full">' + options(a.categories, sc?.category ?? 'functional') + '</select>') +
    field('f-priority', 'Priority', '<select id="f-priority" class="field mt-1 block w-full">' + options(['high', 'medium', 'low'], sc?.priority ?? 'medium') + '</select>') +
    '<div class="md:col-span-2">' + field('f-steps', 'Steps', textarea('f-steps', sc?.steps, 5), 'one per line') + '</div>' +
    '<div class="md:col-span-2">' + field('f-expected', 'Expected results', textarea('f-expected', sc?.expectedResults, 3), 'one per line; the correct behaviour') + '</div>' +
    field('f-pre', 'Preconditions', textarea('f-pre', sc?.preconditions, 2), 'optional') +
    field('f-data', 'Test data', textarea('f-data', sc?.testData, 2), 'optional') +
    field('f-feature', 'Feature', '<input id="f-feature" class="field mt-1 block w-full" placeholder="e.g. checkout" value="' + esc(sc?.feature) + '">', 'optional') +
    field('f-why', 'Why it matters', '<input id="f-why" class="field mt-1 block w-full" value="' + esc(sc?.rationale) + '">', 'optional') +
    '</div>' +
    (sc && sc.origin !== 'person' ? '<p class="mb-0 mt-4 text-[13px] text-muted">The AI wrote this scenario. Saving your changes makes it yours, so the AI will no longer change or remove it.</p>' : '') +
    (sc?.design ? '<p class="mb-0 mt-2 text-[13px] text-muted">Its Figma design checks are kept as they are.</p>' : '') +
    '</form>' +
    '<div class="flex flex-wrap items-center gap-3 border-t border-line bg-bg px-5 py-3.5 md:px-6">' +
    '<p id="f-error" class="m-0 min-w-0 flex-1 text-[13px] text-fail" role="alert"></p>' +
    '<button type="button" class="btn-quiet" onclick="' + (sc ? 'openModal(\'' + esc(sc.id) + '\')' : close) + '">Cancel</button>' +
    '<button id="f-save" class="btn" type="submit" form="f">' + (sc ? 'Save changes' : 'Add scenario') + '</button></div>';
  if (!modal.open) modal.showModal();
  (sc ? $('#f-title') : $('#f-desc')).focus();
}

async function draftWithAi() {
  const description = $('#f-desc').value.trim();
  const status = $('#f-draft-status');
  if (!description) { status.textContent = 'Write a sentence first.'; $('#f-desc').focus(); return; }
  const btn = $('#f-draft');
  btn.disabled = true; btn.textContent = 'Drafting…';
  status.textContent = 'The AI is reading the page; this can take a minute.';
  let out = {}, ok = false;
  try {
    const res = await fetch('/api/scenarios/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: $('#f-page').value, description }) });
    out = await res.json(); ok = res.ok;
  } catch (err) { out = { error: String(err) }; }
  if (!$('#f') || $('#f-draft') !== btn) return; // the form was closed or replaced meanwhile
  btn.disabled = false; btn.textContent = 'Draft with AI';
  if (!ok) { status.textContent = out.error || 'The AI could not draft it.'; return; }
  const set = (sel, v) => { if (v !== undefined) $(sel).value = Array.isArray(v) ? v.join('\n') : v; };
  set('#f-title', out.title); set('#f-category', out.category); set('#f-priority', out.priority);
  if (data.authoring.viewports.includes(out.viewport)) set('#f-viewport', out.viewport);
  set('#f-steps', out.steps); set('#f-expected', out.expectedResults); set('#f-pre', out.preconditions);
  set('#f-data', out.testData); set('#f-feature', out.feature); set('#f-why', out.rationale);
  status.textContent = 'Drafted. Review the fields, then add the scenario.';
}

async function saveEditor() {
  const id = $('#modal').dataset.id || undefined;
  const scenario = {
    page: $('#f-page').value, title: $('#f-title').value, viewport: $('#f-viewport').value,
    category: $('#f-category').value, priority: $('#f-priority').value,
    steps: lines($('#f-steps').value), expectedResults: lines($('#f-expected').value),
    preconditions: lines($('#f-pre').value), testData: lines($('#f-data').value),
    feature: $('#f-feature').value, rationale: $('#f-why').value,
  };
  const err = $('#f-error');
  if (!scenario.steps.length) { err.textContent = 'Add at least one step.'; $('#f-steps').focus(); return; }
  if (!scenario.expectedResults.length) { err.textContent = 'Add at least one expected result.'; $('#f-expected').focus(); return; }
  const btn = $('#f-save');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…'; err.textContent = '';
  let out = {}, ok = false;
  try {
    const res = await fetch('/api/scenarios/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, scenario }) });
    out = await res.json(); ok = res.ok;
  } catch (e) { out = { error: String(e) }; }
  if (!ok) { btn.disabled = false; btn.textContent = label; err.textContent = 'Could not save: ' + (out.error || 'unknown error'); return; }
  // A new or changed scenario has not run yet; make sure it shows in the list.
  view.includeNotRun = true;
  await load(data.run?.id);
  openModal(out.id, (id ? 'Saved. ' : 'Added ' + out.id + '. ') + (data.testStates[out.id] === 'missing' ? 'Create its test with the button below.' : data.testStates[out.id] ? 'Rewrite its test with the button below to match your changes.' : ''));
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 8000);
}
const link = (href, text, blank) => href ? '<a class="text-accent underline-offset-2 hover:underline" href="' + file(href) + '"' + (blank ? ' target="_blank" rel="noopener"' : '') + '>' + esc(text) + '</a>' : '';
$('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

function setPage(p) { view.page = p; render(); }
function setOnly(k) { view.only = k; render(); }
load();
</script>
</body>
</html>`;

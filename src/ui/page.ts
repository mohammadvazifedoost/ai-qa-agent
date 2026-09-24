/**
 * The dashboard is a single static page served by `ai-qa-agent ui`. Styling is Tailwind, compiled at
 * package build time into dist/ui/styles.css (see src/ui/tailwind.css). The page reads
 * /api/overview, links evidence under /files/, creates ClickUp tasks through POST /api/file and
 * deletes scenarios through POST /api/scenarios/delete.
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
    <div class="border-t border-rail-line px-5 py-4 text-[13px] text-rail-muted" id="clickup"></div>
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
  // ClickUp verification happens after the first paint so the page never waits for it.
  if (data.run?.tasksPending) {
    const runId = data.run.id;
    try {
      const t = await (await fetch('/api/tasks?run=' + encodeURIComponent(runId))).json();
      if (data.run && data.run.id === runId) { data.run.tasks = t.tasks || {}; data.run.tasksPending = false; refreshActions(); }
    } catch { if (data.run && data.run.id === runId) { data.run.tasksPending = false; refreshActions(); } }
  }
}

/** Re-render only the action cells (and the open modal's footer) once ClickUp answered. */
function refreshActions() {
  for (const cell of document.querySelectorAll('[data-action-for]')) {
    const sc = data.scenarios.find((x) => x.id === cell.dataset.actionFor);
    if (sc) cell.innerHTML = action(sc, statusOf(sc.id));
  }
  const modal = $('#modal');
  if (modal.open) openModal(modal.dataset.id);
}

/* ---------- joins ---------- */
const outcomesFor = (id) => data.run ? data.run.outcomes.filter((o) => o.scenarioId === id) : [];
const failureFor = (key) => data.run?.failures.find((f) => f.key === key);
const issueFor = (key) => data.run?.issues.find((i) => i.failureKeys.includes(key));
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
const typeChip = (sc) => '<span class="chip chip-' + esc(sc.category) + '">' + esc(sc.category) + '</span>';
const fmtRun = (id) => id.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2');

/* ---------- render ---------- */
function render() {
  $('#project').textContent = data.project.name;
  $('#url').textContent = data.project.baseUrl;
  const sel = $('#run');
  sel.innerHTML = data.runs.map((r) => '<option value="' + esc(r.id) + '"' + (data.run && r.id === data.run.id ? ' selected' : '') + '>' + esc(fmtRun(r.id)) + '</option>').join('');
  sel.onchange = () => load(sel.value);
  const runInfo = data.runs.find((r) => data.run && r.id === data.run.id);
  $('#runmeta').textContent = runInfo ? (runInfo.stats.passed + runInfo.stats.failed + runInfo.stats.flaky) + ' tests · ' + runInfo.status : '';

  const cu = $('#clickup');
  const head = '<b class="block text-[11.5px] font-bold uppercase tracking-[0.12em] text-rail-muted">ClickUp</b>';
  if (!data.clickup.configured) cu.innerHTML = head + '<span class="mt-1 block">Not configured — bugs stay in the report.</span>';
  else if (!data.clickup.tokenPresent) cu.innerHTML = head + '<span class="mt-1 block text-flaky">Token missing in the shell that started ai-qa-agent ui.</span>';
  else cu.innerHTML = head + '<span class="mt-1 block"><span class="text-pass">Ready</span> · list ' + esc(data.clickup.listId) + '</span>';

  const main = $('#main');
  const empty = (msg) => '<div class="rounded-2xl border border-dashed border-line-strong px-6 py-14 text-center text-muted">' + msg + '</div>';
  if (!data.scenarios.length) { $('#nav').innerHTML = ''; main.innerHTML = empty('No scenarios yet. Run <code class="font-mono text-[13px]">ai-qa-agent scenarios</code> first.'); return; }
  if (!data.run) { $('#nav').innerHTML = ''; main.innerHTML = empty('No test run yet. Run <code class="font-mono text-[13px]">ai-qa-agent run</code> or <code class="font-mono text-[13px]">ai-qa-agent test</code>.'); return; }

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

  const s = data.run.stats;
  const ran = s.passed + s.failed + s.flaky;
  const defects = data.run.issues.length;
  const byType = ['functional', 'visual', 'responsive'].map((t) => {
    const rows = inRun.filter((x) => x.sc.category === t);
    return { t, total: rows.length, failed: rows.filter((x) => x.status !== 'passed').length };
  }).filter((x) => x.total);

  let html = '<div class="mb-6 flex flex-wrap items-end justify-between gap-3"><div>' +
    '<h1 class="m-0 text-[28px] font-extrabold tracking-tight">Test results</h1>' +
    '<p class="m-0 mt-1 text-sm text-muted">Run ' + esc(fmtRun(data.run.id)) + ' against ' + esc(data.project.baseUrl) + '</p></div></div>';

  html += '<section class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center rounded-2xl border border-line bg-surface p-5 md:p-6" aria-label="Verdict">' +
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
    (view.only === 'all' ? true : view.only === 'failed' ? x.status === 'failed' || x.status === 'flaky' : x.status === 'passed') &&
    (!view.type || x.sc.category === view.type) &&
    (!q || x.sc.id.toLowerCase().includes(q) || x.sc.title.toLowerCase().includes(q)) &&
    (view.includeNotRun || x.status !== 'none'));
  const types = [...new Set(all.map((x) => x.sc.category))].sort();
  html += '<div class="sticky top-0 z-10 -mx-4 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 bg-bg/95 px-4 py-2.5 backdrop-blur md:-mx-8 md:px-8">' +
    '<div class="inline-flex overflow-hidden rounded-lg border border-line-strong bg-surface" role="group" aria-label="Show">' +
    ['all', 'failed', 'passed'].map((k) => '<button class="seg-btn" aria-pressed="' + (view.only === k) + '" onclick="setOnly(\'' + k + '\')">' + ({ all: 'All', failed: 'Failures', passed: 'Passing' })[k] + '</button>').join('') + '</div>' +
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
  const chips = typeChip(sc) + (failing ? '<span class="chip ' + (cls && isBug(cls) ? 'chip-bug' : 'chip-other') + '">' + esc(cls ? human(cls) : 'not analyzed') + '</span>' : '');
  return '<li class="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-3.5 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[14px_118px_minmax(0,1fr)_auto] ' + (failing ? 'row-' + status : '') + '">' +
    '<button class="group col-span-2 grid min-w-0 cursor-pointer grid-cols-subgrid items-center gap-3.5 border-0 bg-transparent p-0 text-left text-inherit sm:col-span-3" onclick="openModal(\'' + esc(sc.id) + '\')" aria-haspopup="dialog">' +
    '<span class="dot dot-' + status + '" aria-label="' + status + '"></span>' +
    '<span class="hidden font-mono text-[12.5px] text-muted sm:block">' + esc(sc.id) + '</span>' +
    '<span class="flex min-w-0 items-center gap-2"><span class="min-w-0 truncate font-medium group-hover:text-accent">' + esc(sc.title) + '</span><span class="flex shrink-0 gap-1.5">' + chips + '</span>' +
    '<span class="ml-1 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true">›</span></span></button>' +
    '<span class="col-start-2 flex items-center gap-2.5 whitespace-nowrap sm:col-start-4" data-action-for="' + esc(sc.id) + '">' + action(sc, status) + '</span></li>';
}

function action(sc, status) {
  if (status !== 'failed' && status !== 'flaky') return '';
  if (!data.clickup.configured) return '';
  const o = failingOutcome(sc);
  if (!o) return '';
  if (data.run.tasksPending) return '<span class="text-xs text-muted" aria-live="polite">checking ClickUp…</span>';
  const task = data.run.tasks[o.key];
  if (task && task.exists) {
    return '<a class="btn btn-ghost" href="' + esc(task.url || '#') + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="' + esc(task.status ? 'Status in ClickUp: ' + task.status : '') + '">Open task ' + esc(task.taskId) + '</a>';
  }
  const issue = issueFor(o.key);
  const body = issue ? { issueId: issue.id } : { failureKey: o.key };
  const disabled = data.clickup.tokenPresent ? '' : 'disabled title="ClickUp token missing in the shell that started ai-qa-agent ui"';
  return '<button class="btn" ' + disabled + ' onclick="event.stopPropagation(); fileBug(this, ' + esc(JSON.stringify(body)) + ')">Create task</button>';
}

async function fileBug(btn, body) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Creating…';
  const res = await fetch('/api/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: data.run.id, ...body }) });
  const out = await res.json();
  if (!res.ok) { btn.disabled = false; btn.textContent = label; alert('Could not create the task: ' + (out.error || out.reason || res.status)); return; }
  const open = $('#modal').open ? $('#modal').dataset.id : null;
  await load(data.run.id);
  if (open) openModal(open);
}

/* ---------- modal ---------- */
function openModal(id) {
  const sc = data.scenarios.find((x) => x.id === id);
  if (!sc) return;
  const status = statusOf(id);
  const outs = outcomesFor(id);
  const modal = $('#modal');
  modal.dataset.id = id;
  let left = '', right = '';
  const section = (title, body) => '<section class="mb-[22px]">' + (title ? '<h3 class="section-title">' + title + '</h3>' : '') + body + '</section>';
  if (outs.length === 0) left += section('', '<p class="m-0 text-base font-semibold">This scenario was not part of the selected run.</p>');
  for (const o of outs) {
    const f = failureFor(o.key), issue = issueFor(o.key);
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
    if (foot && o && !issueFor(o.key)) foot += '<span class="text-[13px] text-muted">Not confirmed as a product bug by the analyzer — the task will be tagged needs-verification.</span>';
  }
  modal.innerHTML = '<div class="flex items-start gap-4 border-b border-line px-5 pb-4 pt-5 md:px-6 md:pt-[22px]"><div class="min-w-0">' +
    '<span class="pill pill-' + status + '">' + (status === 'none' ? 'not run' : status) + '</span> ' + typeChip(sc) +
    '<h2 id="m-title" class="mb-1 mt-1.5 text-xl font-extrabold tracking-tight">' + esc(sc.title) + '</h2>' +
    '<div class="text-[13px] text-muted"><span class="font-mono text-[12.5px]">' + esc(sc.id) + '</span> · ' + esc(sc.page) + ' · ' + esc(sc.viewport) + ' · ' + esc(sc.priority) + ' priority</div></div>' +
    '<button class="ml-auto size-[34px] shrink-0 cursor-pointer rounded-full border-0 bg-line text-lg leading-none text-ink hover:bg-line-strong" onclick="document.getElementById(\'modal\').close()" aria-label="Close">×</button></div>' +
    '<div class="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-auto px-5 py-5 md:grid-cols-[minmax(300px,1fr)_minmax(300px,1.25fr)] md:px-6"><div>' + left + '</div><div>' + right + '</div></div>' +
    '<div class="flex flex-wrap items-center gap-3 border-t border-line bg-bg px-5 py-3.5 md:px-6">' + foot + deleteArea(sc.id) + '</div>';
  if (!modal.open) modal.showModal();
}

/* ---------- delete scenario (inline confirm in the modal footer) ---------- */
function deleteArea(id) {
  return '<div id="del-area" class="ml-auto flex flex-wrap items-center justify-end gap-2">' +
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

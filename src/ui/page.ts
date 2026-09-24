/**
 * The dashboard is a single static page served by `ai-qa ui`. Styling is Tailwind, compiled at
 * package build time into dist/ui/styles.css (see src/ui/tailwind.css). The page reads
 * /api/overview, links evidence under /files/, and creates ClickUp tasks through POST /api/file.
 */
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ai-qa results</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="grid min-h-screen grid-cols-1 md:grid-cols-[248px_minmax(0,1fr)]">
  <aside class="border-b border-line p-4 md:sticky md:top-0 md:h-screen md:overflow-auto md:border-b-0 md:border-r md:px-[18px] md:py-6">
    <p class="m-0 text-lg font-extrabold tracking-tight" id="project">ai-qa</p>
    <p class="m-0 text-xs font-medium text-muted break-all" id="url"></p>
    <ul class="m-0 mt-5 list-none p-0" id="nav"></ul>
    <div class="mt-6 border-t border-line pt-4 text-[13px] text-muted" id="clickup"></div>
  </aside>
  <main class="max-w-[1120px] px-4 pb-16 pt-4 md:px-8 md:pt-6">
    <div class="mb-5 flex flex-wrap items-center gap-x-5 gap-y-3">
      <h1 class="m-0 text-[26px] font-extrabold tracking-tight">Test results</h1>
      <span class="flex-1"></span>
      <label class="text-muted">Run <select id="run" class="field" aria-label="Run"></select></label>
    </div>
    <div id="main"><p class="py-12 text-center text-muted">Loading…</p></div>
  </main>
</div>
<dialog id="modal" class="w-[min(1040px,calc(100vw-32px))] max-h-[calc(100vh-32px)] rounded-2xl border-0 bg-surface p-0 text-ink shadow-[0_20px_60px_rgba(16,35,31,.18)] dark:shadow-[0_20px_60px_rgba(0,0,0,.5)]" aria-labelledby="m-title"></dialog>
<script>
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const file = (p) => '/files/' + p.split('/').map(encodeURIComponent).join('/');
let data;
let view = { page: '', only: 'all', type: '', includeNotRun: false };

async function load(runId) {
  const res = await fetch('/api/overview' + (runId ? '?run=' + encodeURIComponent(runId) : ''));
  data = await res.json();
  render();
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
/** The failing outcome to act on for a scenario (issue-backed first). */
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

/* ---------- render ---------- */
function render() {
  $('#project').textContent = data.project.name;
  $('#url').textContent = data.project.baseUrl;
  const sel = $('#run');
  sel.innerHTML = data.runs.map((r) => '<option value="' + esc(r.id) + '"' + (data.run && r.id === data.run.id ? ' selected' : '') + '>' +
    esc(r.id.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')) + '</option>').join('');
  sel.onchange = () => load(sel.value);

  const cu = $('#clickup');
  if (!data.clickup.configured) cu.innerHTML = '<b class="block font-semibold text-ink">ClickUp</b>not configured — bugs stay in the report';
  else if (!data.clickup.tokenPresent) cu.innerHTML = '<b class="block font-semibold text-ink">ClickUp</b><span class="text-flaky">token missing in the shell that started ai-qa ui</span>';
  else cu.innerHTML = '<b class="block font-semibold text-ink">ClickUp</b><span class="text-pass">ready</span> · list ' + esc(data.clickup.listId);

  const main = $('#main');
  const empty = (msg) => '<p class="py-12 text-center text-muted">' + msg + '</p>';
  if (!data.scenarios.length) { $('#nav').innerHTML = ''; main.innerHTML = empty('No scenarios yet. Run <code class="font-mono text-[13px]">ai-qa scenarios</code> first.'); return; }
  if (!data.run) { $('#nav').innerHTML = ''; main.innerHTML = empty('No test run yet. Run <code class="font-mono text-[13px]">ai-qa run</code> or <code class="font-mono text-[13px]">ai-qa test</code>.'); return; }

  const all = data.scenarios.map((sc) => ({ sc, status: statusOf(sc.id) }));
  const inRun = all.filter((x) => x.status !== 'none');
  const pages = [...new Set(all.map((x) => x.sc.page))].sort();

  // Sidebar: pages with pass/fail counts for this run.
  $('#nav').innerHTML = ['', ...pages].map((p) => {
    const rows = (p ? all.filter((x) => x.sc.page === p) : all).filter((x) => x.status !== 'none');
    const pass = rows.filter((x) => x.status === 'passed').length, fail = rows.filter((x) => x.status !== 'passed').length;
    return '<li class="my-0.5"><button class="nav-btn" aria-current="' + (view.page === p) + '" onclick="setPage(\'' + esc(p) + '\')"><span>' + (p ? esc(p) : 'All pages') + '</span>' +
      '<span class="flex gap-1.5 text-xs font-semibold">' + (pass ? '<span class="min-w-[22px] rounded-md bg-pass-soft px-1.5 text-center text-pass">' + pass + '</span>' : '') +
      (fail ? '<span class="min-w-[22px] rounded-md bg-fail-soft px-1.5 text-center text-fail">' + fail + '</span>' : '') + '</span></button></li>';
  }).join('');

  const s = data.run.stats;
  const ran = s.passed + s.failed + s.flaky;
  const pct = (n) => ran ? (100 * n / ran) + '%' : '0%';
  const defects = data.run.issues.length;
  let html = '<div class="mb-5 rounded-[14px] border border-line bg-surface px-6 py-[22px]">' +
    '<div class="flex flex-wrap items-baseline gap-x-[18px] gap-y-2">' +
    '<span class="text-[44px] font-extrabold leading-none tracking-tighter">' + s.passed + '<i class="text-[22px] font-semibold not-italic text-muted">/' + ran + '</i></span>' +
    '<span class="text-muted">tests passed in this run</span>' +
    '<span class="ml-auto font-semibold"><b class="mr-1 text-[22px] text-fail">' + defects + '</b>' + (defects === 1 ? 'distinct defect' : 'distinct defects') + '</span></div>' +
    '<div class="my-4 mb-2 flex h-3.5 overflow-hidden rounded-full bg-line" role="img" aria-label="' + s.passed + ' passed, ' + s.failed + ' failed, ' + s.flaky + ' flaky">' +
    '<span class="block h-full bg-pass" style="width:' + pct(s.passed) + '"></span><span class="block h-full bg-flaky" style="width:' + pct(s.flaky) + '"></span><span class="block h-full bg-fail" style="width:' + pct(s.failed) + '"></span></div>' +
    '<div class="flex flex-wrap gap-4 text-[13px] text-muted">' + legend('bg-pass', s.passed + ' passed') + legend('bg-fail', s.failed + ' failed') +
    (s.flaky ? legend('bg-flaky', s.flaky + ' flaky') : '') + (all.length - inRun.length ? legend('bg-idle', (all.length - inRun.length) + ' not in this run') : '') + '</div></div>';

  const rows = all.filter((x) => (!view.page || x.sc.page === view.page) &&
    (view.only === 'all' ? true : view.only === 'failed' ? x.status === 'failed' || x.status === 'flaky' : x.status === 'passed') &&
    (!view.type || x.sc.category === view.type) &&
    (view.includeNotRun || x.status !== 'none'));
  const types = [...new Set(all.map((x) => x.sc.category))].sort();
  html += '<div class="mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-2">' +
    '<div class="inline-flex overflow-hidden rounded-lg border border-line-strong bg-surface" role="group" aria-label="Show">' +
    ['all', 'failed', 'passed'].map((k) => '<button class="seg-btn" aria-pressed="' + (view.only === k) + '" onclick="setOnly(\'' + k + '\')">' + ({ all: 'All', failed: 'Failures', passed: 'Passing' })[k] + '</button>').join('') + '</div>' +
    '<label class="text-muted">Type <select class="field" onchange="view.type=this.value;render()"><option value="">all types</option>' +
    types.map((t) => '<option value="' + esc(t) + '"' + (view.type === t ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select></label>' +
    '<label class="flex items-center gap-1.5 text-sm text-muted"><input type="checkbox" ' + (view.includeNotRun ? 'checked' : '') + ' onchange="view.includeNotRun=this.checked;render()"> show scenarios not in this run</label>' +
    '<span class="ml-auto text-[13px] text-muted">' + rows.length + ' shown</span></div>';

  if (!rows.length) html += empty('Nothing matches this filter.');
  for (const page of pages) {
    const group = rows.filter((x) => x.sc.page === page);
    if (!group.length) continue;
    const fails = group.filter((x) => x.status === 'failed' || x.status === 'flaky').length;
    html += '<div class="mb-2 mt-6 flex items-baseline gap-2.5"><h2 class="m-0 text-base font-bold">' + esc(page) + '</h2><span class="text-[13px] text-muted">' + group.length + (fails ? ' · ' + fails + ' failing' : '') + '</span></div>' +
      '<ul class="m-0 list-none overflow-hidden rounded-xl border border-line bg-surface p-0">';
    for (const { sc, status } of group) html += row(sc, status);
    html += '</ul>';
  }
  main.innerHTML = html;
}

const legend = (bg, text) => '<span><i class="mr-1.5 inline-block size-2.5 rounded-[3px] align-[-1px] ' + bg + '"></i>' + text + '</span>';

function row(sc, status) {
  const cls = classificationOf(sc);
  const failing = status === 'failed' || status === 'flaky';
  const chips = typeChip(sc) + (failing
    ? ' <span class="chip ' + (cls && isBug(cls) ? 'chip-bug' : 'chip-other') + '">' + esc(cls ? human(cls) : 'not analyzed') + '</span>'
    : '');
  return '<li class="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-3.5 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[14px_118px_minmax(0,1fr)_auto]">' +
    '<button class="group col-span-2 grid min-w-0 cursor-pointer grid-cols-subgrid items-center gap-3.5 border-0 bg-transparent p-0 text-left text-inherit sm:col-span-3" onclick="openModal(\'' + esc(sc.id) + '\')" aria-haspopup="dialog">' +
    '<span class="dot dot-' + status + '" aria-label="' + status + '"></span>' +
    '<span class="hidden font-mono text-[12.5px] text-muted sm:block">' + esc(sc.id) + '</span>' +
    '<span class="flex min-w-0 items-center gap-2"><span class="min-w-0 truncate font-medium group-hover:text-accent">' + esc(sc.title) + '</span><span class="flex shrink-0 gap-1.5">' + chips + '</span></span></button>' +
    '<span class="col-start-2 flex items-center gap-2.5 whitespace-nowrap sm:col-start-4">' + action(sc, status) + '</span></li>';
}

function action(sc, status) {
  if (status !== 'failed' && status !== 'flaky') return '';
  if (!data.clickup.configured) return '';
  const o = failingOutcome(sc);
  if (!o) return '';
  // The server checked ClickUp: link to the task if it still exists there, otherwise offer to create one.
  const task = data.run.tasks[o.key];
  if (task && task.exists) {
    return '<a class="btn btn-ghost" href="' + esc(task.url || '#') + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="' + esc(task.status ? 'Status in ClickUp: ' + task.status : '') + '">Open task ' + esc(task.taskId) + '</a>';
  }
  const issue = issueFor(o.key);
  const body = issue ? { issueId: issue.id } : { failureKey: o.key };
  const disabled = data.clickup.tokenPresent ? '' : 'disabled title="ClickUp token missing in the shell that started ai-qa ui"';
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
    if (o.status === 'passed') left += section('', '<p class="m-0 text-base font-semibold">Passed' + (o.attempts > 1 ? ' after ' + o.attempts + ' attempts' : '') + '.</p>');
    if (f || issue) {
      left += section('What happened',
        '<p class="mb-2 mt-0 text-base font-semibold">' + esc(issue ? issue.bug.title : f.summary) + '</p>' +
        (f ? '<p class="m-0 text-sm text-muted">' + esc(human(f.classification)) + ' · ' + Math.round(f.confidence * 100) + '% confidence' + (issue ? ' · ' + esc(issue.bug.severity) + ' severity' : '') + '</p>' : '') +
        (issue ? '<p class="mt-2 mb-0 text-sm text-muted">Root cause: <code class="font-mono text-[12.5px] text-ink">' + esc(issue.bug.suspectedRootCause) + '</code></p>'
               : (f?.testProblem ? '<p class="mt-2 mb-0 text-sm text-muted">Test problem: ' + esc(f.testProblem) + '</p>' : '')));
      if (issue) left += section('Expected vs actual', '<p class="mb-1.5 mt-0"><b>Expected</b> ' + esc(issue.bug.expectedResult) + '</p><p class="m-0"><b>Actual</b> ' + esc(issue.bug.actualResult) + '</p>');
    } else if (o.status !== 'passed') {
      left += section('', '<p class="m-0 text-base font-semibold">Failed; not analyzed yet (run <code class="font-mono text-[13px]">ai-qa triage</code>).</p>');
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
  modal.innerHTML = '<div class="flex items-start gap-4 border-b border-line px-6 pb-4 pt-[22px]"><div>' +
    '<span class="pill pill-' + status + '">' + (status === 'none' ? 'not run' : status) + '</span> ' + typeChip(sc) +
    '<h2 id="m-title" class="mb-1 mt-1 text-xl font-extrabold tracking-tight">' + esc(sc.title) + '</h2>' +
    '<div class="text-[13px] text-muted"><span class="font-mono text-[12.5px]">' + esc(sc.id) + '</span> · ' + esc(sc.page) + ' · ' + esc(sc.viewport) + ' · ' + esc(sc.priority) + ' priority</div></div>' +
    '<button class="ml-auto size-[34px] cursor-pointer rounded-full border-0 bg-line text-lg leading-none text-ink" onclick="document.getElementById(\'modal\').close()" aria-label="Close">×</button></div>' +
    '<div class="grid max-h-[calc(100vh-210px)] grid-cols-1 gap-6 overflow-auto px-6 py-5 md:grid-cols-[minmax(300px,1fr)_minmax(300px,1.25fr)]"><div>' + left + '</div><div>' + right + '</div></div>' +
    (foot ? '<div class="flex flex-wrap items-center gap-3 rounded-b-2xl border-t border-line bg-bg px-6 py-3.5">' + foot + '</div>' : '');
  if (!modal.open) modal.showModal();
}
const link = (href, text, blank) => href ? '<a class="text-accent" href="' + file(href) + '"' + (blank ? ' target="_blank" rel="noopener"' : '') + '>' + esc(text) + '</a>' : '';
$('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

function setPage(p) { view.page = p; render(); }
function setOnly(k) { view.only = k; render(); }
load();
</script>
</body>
</html>`;

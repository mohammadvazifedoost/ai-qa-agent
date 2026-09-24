/**
 * The dashboard is a single static page (no build step, no framework) served by `ai-qa ui`.
 * It reads /api/overview, links evidence under /files/, and files bugs through POST /api/file.
 */
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ai-qa results</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#F2F5F4;--surface:#FFFFFF;--ink:#10231F;--muted:#5F6F6B;--line:#DCE3E0;--line-strong:#B9C4C0;
  --accent:#0E6B5C;--accent-ink:#FFFFFF;--accent-soft:#E1F0EC;
  --pass:#2F7D4F;--pass-soft:#E4F2E9;--fail:#C03A2B;--fail-soft:#FAE6E2;--flaky:#B7791F;--flaky-soft:#FBEFD9;--idle:#9AA7A3;
  --shadow:0 20px 60px rgba(16,35,31,.18);
  --font:"Manrope",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0F1614;--surface:#161F1C;--ink:#E8EEEC;--muted:#98A6A2;--line:#243230;--line-strong:#3A4A46;
  --accent:#4FB8A2;--accent-ink:#0F1614;--accent-soft:#17302B;
  --pass:#5CC58A;--pass-soft:#13301F;--fail:#F0806F;--fail-soft:#3B1C17;--flaky:#E3AA4C;--flaky-soft:#3A2B10;--idle:#6C7A76;
  --shadow:0 20px 60px rgba(0,0,0,.5);
}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--font)}
a{color:var(--accent)}
button{font:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* Frame */
.app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
aside{border-right:1px solid var(--line);padding:24px 18px;position:sticky;top:0;height:100vh;overflow:auto}
main{padding:24px 32px 80px;max-width:1120px}
@media (max-width:880px){
  .app{grid-template-columns:1fr}
  aside{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:16px}
  main{padding:16px 16px 64px}
}
.brand{font-weight:800;font-size:18px;letter-spacing:-.01em;margin:0 0 2px}
.brand small{display:block;font-weight:500;font-size:12px;color:var(--muted);word-break:break-all}
.nav{list-style:none;margin:22px 0 0;padding:0}
.nav li{margin:2px 0}
.nav button{width:100%;display:flex;justify-content:space-between;align-items:center;gap:8px;background:none;border:0;border-radius:8px;padding:8px 10px;color:var(--ink);cursor:pointer;text-align:left}
.nav button:hover{background:var(--accent-soft)}
.nav button[aria-current="true"]{background:var(--surface);box-shadow:inset 0 0 0 1px var(--line)}
.nav .counts{display:flex;gap:6px;font-size:12px;font-weight:600}
.nav .counts span{min-width:22px;text-align:center;border-radius:6px;padding:1px 5px}
.nav .p{background:var(--pass-soft);color:var(--pass)}.nav .f{background:var(--fail-soft);color:var(--fail)}
.side-status{margin-top:26px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.side-status b{display:block;color:var(--ink);font-weight:600}
.side-status .ok{color:var(--pass)}.side-status .warn{color:var(--flaky)}

/* Header + verdict */
.topbar{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;margin-bottom:22px}
.topbar h1{font-size:26px;font-weight:800;letter-spacing:-.02em;margin:0}
.topbar .spacer{flex:1}
select,.toggle{font:inherit;padding:7px 10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink)}
.verdict{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin-bottom:22px}
.verdict .big{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 18px}
.verdict .ratio{font-size:44px;font-weight:800;letter-spacing:-.03em;line-height:1}
.verdict .ratio i{font-style:normal;color:var(--muted);font-weight:600;font-size:22px}
.verdict .label{font-size:15px;color:var(--muted)}
.verdict .defects{margin-left:auto;font-weight:600}
.verdict .defects b{color:var(--fail);font-size:22px;margin-right:4px}
.bar{display:flex;height:14px;border-radius:7px;overflow:hidden;margin:16px 0 8px;background:var(--line)}
.bar span{display:block;height:100%}
.bar .passed{background:var(--pass)}.bar .failed{background:var(--fail)}.bar .flaky{background:var(--flaky)}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--muted)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}

/* Controls */
.controls{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-bottom:14px}
.seg{display:inline-flex;border:1px solid var(--line-strong);border-radius:8px;overflow:hidden;background:var(--surface)}
.seg button{border:0;background:none;padding:7px 12px;color:var(--muted);cursor:pointer;font-weight:600}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--bg)}
.controls label.chk{display:flex;gap:6px;align-items:center;color:var(--muted);font-size:14px}
.controls .count{margin-left:auto;color:var(--muted);font-size:13px}

/* List */
.group{margin:24px 0 8px;display:flex;align-items:baseline;gap:10px}
.group h2{margin:0;font-size:16px;font-weight:700}
.group span{color:var(--muted);font-size:13px}
.list{list-style:none;margin:0;padding:0;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.row{display:grid;grid-template-columns:14px 118px minmax(0,1fr) auto;gap:14px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row .open{grid-column:1/4;display:grid;grid-template-columns:subgrid;align-items:center;gap:14px;background:none;border:0;padding:0;text-align:left;color:inherit;cursor:pointer;min-width:0}
.row .open:hover .title{color:var(--accent)}
.dot{width:10px;height:10px;border-radius:50%;background:var(--idle)}
.dot.passed{background:var(--pass)}.dot.failed{background:var(--fail)}.dot.flaky{background:var(--flaky)}
.id{font-family:var(--mono);font-size:12.5px;color:var(--muted)}
.title{font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.title .chip{margin-left:8px}
.chip{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;vertical-align:1px;white-space:nowrap}
.chip.bug{background:var(--fail-soft);color:var(--fail)}
.chip.other{background:var(--line);color:var(--muted)}
.chip.pass{background:var(--pass-soft);color:var(--pass)}
.chip.flaky{background:var(--flaky-soft);color:var(--flaky)}
.act{display:flex;align-items:center;gap:10px;white-space:nowrap}
.btn{display:inline-block;border:0;border-radius:8px;padding:7px 12px;font-weight:700;cursor:pointer;background:var(--accent);color:var(--accent-ink);text-decoration:none;line-height:1.4}
.btn:disabled{opacity:.55;cursor:default}
.btn.ghost{background:var(--accent-soft);color:var(--accent)}
a.btn.ghost:hover{text-decoration:underline}
@media (max-width:640px){
  .row{grid-template-columns:14px minmax(0,1fr)}
  .row .open{grid-column:1/3;grid-template-columns:14px minmax(0,1fr)}
  .row .id{display:none}
  .row .act{grid-column:2}
}
.empty{padding:48px 16px;color:var(--muted);text-align:center}
.empty code{font-family:var(--mono);font-size:13px}

/* Modal */
dialog{border:0;border-radius:16px;padding:0;width:min(1040px,calc(100vw - 32px));max-height:calc(100vh - 32px);background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}
dialog::backdrop{background:rgba(16,35,31,.55);backdrop-filter:blur(2px)}
.m-head{display:flex;gap:16px;align-items:flex-start;padding:22px 24px 16px;border-bottom:1px solid var(--line)}
.m-head h2{margin:4px 0 4px;font-size:20px;font-weight:800;letter-spacing:-.01em}
.m-head .meta{color:var(--muted);font-size:13px}
.m-head .close{margin-left:auto;background:var(--line);border:0;border-radius:50%;width:34px;height:34px;cursor:pointer;color:var(--ink);font-size:18px;line-height:1}
.pill{display:inline-block;font-weight:700;font-size:12px;padding:3px 10px;border-radius:999px}
.pill.passed{background:var(--pass-soft);color:var(--pass)}.pill.failed{background:var(--fail-soft);color:var(--fail)}.pill.flaky{background:var(--flaky-soft);color:var(--flaky)}.pill.none{background:var(--line);color:var(--muted)}
.m-body{padding:20px 24px;display:grid;grid-template-columns:minmax(300px,1fr) minmax(300px,1.25fr);gap:24px;overflow:auto;max-height:calc(100vh - 210px)}
@media (max-width:760px){.m-body{grid-template-columns:1fr}}
.m-body h3{margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.02em;color:var(--muted)}
.m-body section{margin-bottom:22px}
.lead{font-size:16px;font-weight:600;margin:0 0 8px}
.cause{font-size:14px;color:var(--muted);margin:0}
.cause code{font-family:var(--mono);font-size:12.5px;color:var(--ink)}
details summary{cursor:pointer;color:var(--accent);font-weight:600;font-size:14px;list-style:none}
details summary::-webkit-details-marker{display:none}
details summary::before{content:"▸ ";color:var(--muted)}
details[open] summary::before{content:"▾ "}
pre.err{white-space:pre-wrap;font-family:var(--mono);font-size:12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;max-height:240px;overflow:auto;margin:10px 0 0}
ol.steps,ul.exp{margin:8px 0 0;padding-left:20px;font-size:14px}
ol.steps li,ul.exp li{margin:3px 0}
.shot{display:block;border:1px solid var(--line);border-radius:10px;max-width:100%}
video{display:block;width:100%;border-radius:10px;background:#000;margin-top:12px}
.links{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:12px;font-size:14px}
.m-foot{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:14px 24px;border-top:1px solid var(--line);background:var(--bg);border-radius:0 0 16px 16px}
.m-foot .note{color:var(--muted);font-size:13px}
@media (prefers-reduced-motion:no-preference){dialog[open]{animation:pop .16s ease-out}@keyframes pop{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}}
</style>
</head>
<body>
<div class="app">
  <aside>
    <p class="brand" id="project">ai-qa<small id="url"></small></p>
    <ul class="nav" id="nav"></ul>
    <div class="side-status" id="clickup"></div>
  </aside>
  <main>
    <div class="topbar">
      <h1>Test results</h1>
      <span class="spacer"></span>
      <label>Run <select id="run" aria-label="Run"></select></label>
    </div>
    <div id="main"><p class="empty">Loading…</p></div>
  </main>
</div>
<dialog id="modal" aria-labelledby="m-title"></dialog>
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
const filingFor = (issueId) => data.run?.filing.find((f) => f.issueId === issueId && (f.action === 'created' || f.action === 'commented'));
function statusOf(id) {
  const s = outcomesFor(id).map((o) => o.status);
  if (!s.length) return 'none';
  if (s.includes('failed')) return 'failed';
  if (s.includes('flaky')) return 'flaky';
  return s.every((x) => x === 'skipped') ? 'none' : 'passed';
}
/** The ClickUp record for a scenario: its consolidated issue, or the ad-hoc filing of its failure. */
function clickupFor(sc) {
  const outs = outcomesFor(sc.id).filter((o) => o.status === 'failed' || o.status === 'flaky');
  for (const o of outs) {
    const issue = issueFor(o.key);
    const filed = issue ? filingFor(issue.id) : filingFor('FAIL-' + sc.id);
    if (filed) return { filed, issue, outcome: o };
    if (issue) return { issue, outcome: o };
  }
  return outs[0] ? { outcome: outs[0] } : null;
}
function classificationOf(sc) {
  const f = outcomesFor(sc.id).map((o) => failureFor(o.key)).find(Boolean);
  return f ? f.classification : null;
}
const isBug = (c) => c === 'PRODUCT_BUG' || c === 'DESIGN_MISMATCH';
const human = (c) => c ? c.replace('_', ' ').toLowerCase() : '';

/* ---------- render ---------- */
function render() {
  $('#project').firstChild.textContent = data.project.name;
  $('#url').textContent = data.project.baseUrl;
  const sel = $('#run');
  sel.innerHTML = data.runs.map((r) => '<option value="' + esc(r.id) + '"' + (data.run && r.id === data.run.id ? ' selected' : '') + '>' +
    esc(r.id.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')) + '</option>').join('');
  sel.onchange = () => load(sel.value);

  const cu = $('#clickup');
  if (!data.clickup.configured) cu.innerHTML = '<b>ClickUp</b>not configured';
  else if (!data.clickup.tokenPresent) cu.innerHTML = '<b>ClickUp</b><span class="warn">token missing in this shell</span>';
  else cu.innerHTML = '<b>ClickUp</b><span class="ok">ready</span> · list ' + esc(data.clickup.listId);

  const main = $('#main');
  if (!data.scenarios.length) { $('#nav').innerHTML = ''; main.innerHTML = '<p class="empty">No scenarios yet. Run <code>ai-qa scenarios</code> first.</p>'; return; }
  if (!data.run) { $('#nav').innerHTML = ''; main.innerHTML = '<p class="empty">No test run yet. Run <code>ai-qa run</code> or <code>ai-qa test</code>.</p>'; return; }

  const all = data.scenarios.map((sc) => ({ sc, status: statusOf(sc.id) }));
  const inRun = all.filter((x) => x.status !== 'none');
  const pages = [...new Set(all.map((x) => x.sc.page))].sort();

  // Sidebar: pages with pass/fail counts for this run.
  $('#nav').innerHTML = ['', ...pages].map((p) => {
    const rows = (p ? all.filter((x) => x.sc.page === p) : all).filter((x) => x.status !== 'none');
    const pass = rows.filter((x) => x.status === 'passed').length, fail = rows.filter((x) => x.status !== 'passed').length;
    return '<li><button aria-current="' + (view.page === p) + '" onclick="setPage(\'' + esc(p) + '\')"><span>' + (p ? esc(p) : 'All pages') + '</span>' +
      '<span class="counts">' + (pass ? '<span class="p">' + pass + '</span>' : '') + (fail ? '<span class="f">' + fail + '</span>' : '') + '</span></button></li>';
  }).join('');

  const s = data.run.stats;
  const ran = s.passed + s.failed + s.flaky;
  const pct = (n) => ran ? (100 * n / ran) + '%' : '0%';
  const failingIssues = data.run.issues.length;
  let html = '<div class="verdict"><div class="big"><span class="ratio">' + s.passed + '<i>/' + ran + '</i></span><span class="label">tests passed in this run</span>' +
    '<span class="defects"><b>' + failingIssues + '</b>' + (failingIssues === 1 ? 'distinct defect' : 'distinct defects') + '</span></div>' +
    '<div class="bar" role="img" aria-label="' + s.passed + ' passed, ' + s.failed + ' failed, ' + s.flaky + ' flaky">' +
    '<span class="passed" style="width:' + pct(s.passed) + '"></span><span class="flaky" style="width:' + pct(s.flaky) + '"></span><span class="failed" style="width:' + pct(s.failed) + '"></span></div>' +
    '<div class="legend"><span><i style="background:var(--pass)"></i>' + s.passed + ' passed</span><span><i style="background:var(--fail)"></i>' + s.failed + ' failed</span>' +
    (s.flaky ? '<span><i style="background:var(--flaky)"></i>' + s.flaky + ' flaky</span>' : '') +
    (all.length - inRun.length ? '<span><i style="background:var(--idle)"></i>' + (all.length - inRun.length) + ' not in this run</span>' : '') + '</div></div>';

  const rows = all.filter((x) => (!view.page || x.sc.page === view.page) &&
    (view.only === 'all' ? true : view.only === 'failed' ? x.status === 'failed' || x.status === 'flaky' : x.status === 'passed') &&
    (!view.type || x.sc.category === view.type) &&
    (view.includeNotRun || x.status !== 'none'));
  html += '<div class="controls"><div class="seg" role="group" aria-label="Show">' +
    ['all', 'failed', 'passed'].map((k) => '<button aria-pressed="' + (view.only === k) + '" onclick="setOnly(\'' + k + '\')">' + ({ all: 'All', failed: 'Failures', passed: 'Passing' })[k] + '</button>').join('') + '</div>' +
    '<label>Type <select onchange="view.type=this.value;render()"><option value="">all types</option>' +
    [...new Set(all.map((x) => x.sc.category))].sort().map((t) => '<option value="' + esc(t) + '"' + (view.type === t ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select></label>' +
    '<label class="chk"><input type="checkbox" ' + (view.includeNotRun ? 'checked' : '') + ' onchange="view.includeNotRun=this.checked;render()"> show scenarios not in this run</label>' +
    '<span class="count">' + rows.length + ' shown</span></div>';

  if (!rows.length) html += '<p class="empty">Nothing matches. ' + (view.only === 'failed' ? 'No failures here.' : '') + '</p>';
  for (const page of pages) {
    const group = rows.filter((x) => x.sc.page === page);
    if (!group.length) continue;
    const fails = group.filter((x) => x.status === 'failed' || x.status === 'flaky').length;
    html += '<div class="group"><h2>' + esc(page) + '</h2><span>' + group.length + (fails ? ' · ' + fails + ' failing' : '') + '</span></div><ul class="list">';
    for (const { sc, status } of group) html += row(sc, status);
    html += '</ul>';
  }
  main.innerHTML = html;
}

function row(sc, status) {
  const cls = classificationOf(sc);
  const chip = status === 'failed' || status === 'flaky'
    ? (cls ? '<span class="chip ' + (isBug(cls) ? 'bug' : 'other') + '">' + esc(human(cls)) + '</span>' : '<span class="chip other">not analyzed</span>')
    : '';
  return '<li class="row"><button class="open" onclick="openModal(\'' + esc(sc.id) + '\')" aria-haspopup="dialog">' +
    '<span class="dot ' + status + '" aria-label="' + status + '"></span><span class="id">' + esc(sc.id) + '</span>' +
    '<span class="title">' + esc(sc.title) + chip + '</span></button>' +
    '<span class="act">' + action(sc, status) + '</span></li>';
}

function action(sc, status) {
  if (status !== 'failed' && status !== 'flaky') return '';
  const cu = clickupFor(sc);
  if (!cu) return '';
  const can = data.clickup.configured && data.clickup.tokenPresent;
  const body = cu.issue ? { issueId: cu.issue.id } : { failureKey: cu.outcome.key };
  const disabled = can ? '' : 'disabled title="ClickUp token missing in the shell that started ai-qa ui"';
  const call = ' onclick="event.stopPropagation(); fileBug(this, ' + esc(JSON.stringify(body)) + ')"';
  // The server checked ClickUp: if a task for this defect still exists there, link to it;
  // otherwise (never created, or deleted in ClickUp) offer to create one.
  const task = data.run.tasks[cu.outcome.key];
  if (task && task.exists) {
    return '<a class="btn ghost" href="' + esc(task.url || '#') + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="' + esc(task.status ? 'Status in ClickUp: ' + task.status : '') + '">Open task ' + esc(task.taskId) + '</a>';
  }
  return '<button class="btn" ' + disabled + call + '>Create task</button>';
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
  const cu = clickupFor(sc);
  let left = '', right = '';
  if (outs.length === 0) left += '<section><p class="lead">This scenario was not part of the selected run.</p></section>';
  for (const o of outs) {
    const f = failureFor(o.key), issue = issueFor(o.key);
    if (outs.length > 1) left += '<h3>' + esc(o.project) + '</h3>';
    if (o.status === 'passed') left += '<section><p class="lead">Passed' + (o.attempts > 1 ? ' after ' + o.attempts + ' attempts' : '') + '.</p></section>';
    if (f || issue) {
      left += '<section><h3>What happened</h3><p class="lead">' + esc(issue ? issue.bug.title : f.summary) + '</p>' +
        (f ? '<p class="cause">' + esc(human(f.classification)) + ' · ' + Math.round(f.confidence * 100) + '% confidence' + (issue ? ' · ' + esc(issue.bug.severity) + ' severity' : '') + '</p>' : '') +
        (issue ? '<p class="cause" style="margin-top:8px">Root cause: <code>' + esc(issue.bug.suspectedRootCause) + '</code></p>' : (f?.testProblem ? '<p class="cause" style="margin-top:8px">Test problem: ' + esc(f.testProblem) + '</p>' : '')) + '</section>';
      if (issue) left += '<section><h3>Expected vs actual</h3><p style="margin:0 0 6px"><b>Expected</b> ' + esc(issue.bug.expectedResult) + '</p><p style="margin:0"><b>Actual</b> ' + esc(issue.bug.actualResult) + '</p></section>';
    } else if (o.status !== 'passed') {
      left += '<section><p class="lead">Failed; not analyzed yet (run <code>ai-qa triage</code>).</p></section>';
    }
    if (o.error) left += '<section><details><summary>Test error</summary><pre class="err">' + esc(o.error.message) + '</pre></details></section>';
    const a = o.artifacts;
    if (a.screenshots[0] || a.video) {
      right += '<section><h3>Evidence' + (outs.length > 1 ? ' · ' + esc(o.project) : '') + '</h3>' +
        (a.screenshots[0] ? '<a href="' + file(a.screenshots[0]) + '" target="_blank" rel="noopener"><img class="shot" loading="lazy" src="' + file(a.screenshots[0]) + '" alt="Final screenshot of ' + esc(o.key) + '"></a>' : '') +
        (a.video ? '<video controls preload="metadata" src="' + file(a.video) + '"></video>' : '') +
        '<div class="links">' + (a.trace ? '<a href="' + file(a.trace) + '">Trace</a>' : '') + (a.logs ? '<a href="' + file(a.logs) + '" target="_blank" rel="noopener">Console & network</a>' : '') +
        (a.errorContext ? '<a href="' + file(a.errorContext) + '" target="_blank" rel="noopener">Page snapshot</a>' : '') +
        a.design.map((d) => '<a href="' + file(d) + '" target="_blank" rel="noopener">' + esc(d.split('_design-').pop().replace('.png', '').replace(/-/g, ' ')) + '</a>').join('') + '</div></section>';
    }
  }
  left += '<section><details><summary>Scenario steps and expected results</summary><ol class="steps">' + sc.steps.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ol>' +
    '<h3 style="margin-top:12px">Expected</h3><ul class="exp">' + sc.expectedResults.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></details></section>';

  let foot = '';
  if (status === 'failed' || status === 'flaky') {
    foot = action(sc, status);
    if (cu && !cu.issue) foot += '<span class="note">Not confirmed as a product bug by the analyzer — the task will be tagged needs-verification.</span>';
  }
  modal.innerHTML = '<div class="m-head"><div><span class="pill ' + status + '">' + (status === 'none' ? 'not run' : status) + '</span>' +
    '<h2 id="m-title">' + esc(sc.title) + '</h2><div class="meta"><span class="id">' + esc(sc.id) + '</span> · ' + esc(sc.page) + ' · ' + esc(sc.category) + ' · ' + esc(sc.viewport) + ' · ' + esc(sc.priority) + ' priority</div></div>' +
    '<button class="close" onclick="document.getElementById(\'modal\').close()" aria-label="Close">×</button></div>' +
    '<div class="m-body"><div>' + left + '</div><div>' + right + '</div></div>' +
    (foot ? '<div class="m-foot">' + foot + '</div>' : '');
  if (!modal.open) modal.showModal();
}
$('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

function setPage(p) { view.page = p; render(); }
function setOnly(k) { view.only = k; render(); }
load();
</script>
</body>
</html>`;

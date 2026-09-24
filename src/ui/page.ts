/**
 * The dashboard is a single static page (no build step, no framework) served by `ai-qa ui`.
 * It reads /api/overview and links evidence files under /files/.
 */
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ai-qa results</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#F3F5F6;--surface:#FFFFFF;--ink:#16202A;--muted:#66737F;--line:#D9DFE4;
  --pass:#1B7F4C;--fail:#B3261E;--flaky:#B26A00;--skip:#8A96A0;--action:#1F4FD1;--action-ink:#fff;
  --pass-soft:#E3F3EA;--fail-soft:#FBE7E5;--flaky-soft:#FFF1DC;
  --font:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0F1418;--surface:#161C22;--ink:#E6EBEF;--muted:#94A0AB;--line:#26303A;
  --pass:#4CC38A;--fail:#F0776E;--flaky:#E4A33B;--skip:#7D8994;--action:#7C9BFF;--action-ink:#0F1418;
  --pass-soft:#12301F;--fail-soft:#3A1A17;--flaky-soft:#3A2A10;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--font)}
a{color:var(--action)}
.wrap{max-width:1240px;margin:0 auto;padding:24px 16px 64px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 24px;margin-bottom:20px}
header h1{font-size:22px;font-weight:600;margin:0}
header .url{color:var(--muted)}
header select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)}
.spacer{flex:1}
.status{color:var(--muted)}
.status.ok{color:var(--pass)}.status.warn{color:var(--flaky)}
.summary{display:flex;flex-wrap:wrap;gap:8px 28px;align-items:baseline;margin:0 0 8px}
.summary .n{font-size:28px;font-weight:600;line-height:1}
.summary .n.pass{color:var(--pass)}.summary .n.fail{color:var(--fail)}.summary .n.flaky{color:var(--flaky)}
.summary .l{color:var(--muted);margin-left:6px}
.strip{display:flex;gap:2px;height:28px;margin:8px 0 20px}
.strip button{flex:1;min-width:6px;border:0;padding:0;cursor:pointer;border-radius:2px;background:var(--skip);opacity:.9}
.strip button.passed{background:var(--pass)}.strip button.failed{background:var(--fail)}.strip button.flaky{background:var(--flaky)}
.strip button:hover,.strip button:focus-visible{opacity:1;outline:2px solid var(--ink);outline-offset:1px}
.filters{display:flex;flex-wrap:wrap;gap:8px 16px;margin-bottom:12px;align-items:center}
.filters label{color:var(--muted)}
.filters select,.filters input{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)}
.page{margin-top:28px}
.page h2{font-size:17px;font-weight:600;margin:0 0 8px}
.page h2 small{color:var(--muted);font-weight:400;margin-left:10px}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th{text-align:left;font-weight:500;color:var(--muted);padding:8px 12px;border-bottom:1px solid var(--line);font-size:13px}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
tr.row{cursor:pointer}
tr.row:hover td{background:color-mix(in srgb,var(--line) 35%,transparent)}
.id{font-family:var(--mono);font-size:13px;white-space:nowrap}
.meta{color:var(--muted);font-size:13px}
.result{display:inline-block;padding:2px 9px;border-radius:999px;font-size:13px;font-weight:500;white-space:nowrap}
.result.passed{background:var(--pass-soft);color:var(--pass)}
.result.failed{background:var(--fail-soft);color:var(--fail)}
.result.flaky{background:var(--flaky-soft);color:var(--flaky)}
.result.skipped,.result.none{background:transparent;color:var(--muted);border:1px solid var(--line)}
.cls{font-size:13px}
.cls.bug{color:var(--fail);font-weight:500}
.cls.other{color:var(--muted)}
tr.detail td{background:color-mix(in srgb,var(--line) 20%,transparent);padding:16px 12px 20px}
.detail-grid{display:grid;grid-template-columns:minmax(280px,1fr) minmax(280px,1.4fr);gap:20px}
@media (max-width:860px){.detail-grid{grid-template-columns:1fr}}
.detail h4{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--muted)}
.detail ol,.detail ul{margin:0 0 14px;padding-left:20px}
.detail li{margin:2px 0}
.error{white-space:pre-wrap;font-family:var(--mono);font-size:12.5px;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:10px;max-height:260px;overflow:auto;margin:0 0 14px}
.evidence img{max-width:100%;border:1px solid var(--line);border-radius:6px;display:block;margin-bottom:10px}
.evidence video{max-width:100%;border:1px solid var(--line);border-radius:6px;display:block;margin-bottom:10px;background:#000}
.links{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:12px}
.issue{border-left:3px solid var(--fail);padding:6px 12px;margin:8px 0 12px;background:var(--surface);border-radius:0 6px 6px 0}
.issue b{display:block}
.issue .rc{font-size:13px;color:var(--muted);margin-top:4px}
button.file{font:inherit;font-weight:500;background:var(--action);color:var(--action-ink);border:0;border-radius:6px;padding:8px 14px;cursor:pointer}
button.file:disabled{opacity:.55;cursor:default}
button.file:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.filed{color:var(--pass);font-weight:500}
.note{color:var(--muted);font-size:13px;margin-top:6px}
.empty{padding:40px 0;color:var(--muted)}
.empty code{font-family:var(--mono);font-size:13px}
@media (prefers-reduced-motion:no-preference){tr.detail{animation:reveal .18s ease-out}@keyframes reveal{from{opacity:0}to{opacity:1}}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="project">ai-qa</h1>
    <span class="url" id="url"></span>
    <span class="spacer"></span>
    <label>Run <select id="run"></select></label>
    <span class="status" id="clickup"></span>
  </header>
  <div id="main"><p class="empty">Loading…</p></div>
</div>
<script>
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const file = (p) => '/files/' + p.split('/').map(encodeURIComponent).join('/');
let data, filters = { page: '', category: '', status: '' };

async function load(runId) {
  const res = await fetch('/api/overview' + (runId ? '?run=' + encodeURIComponent(runId) : ''));
  data = await res.json();
  render();
}

function outcomesFor(id) {
  return data.run ? data.run.outcomes.filter((o) => o.scenarioId === id) : [];
}
function failureFor(key) { return data.run?.failures.find((f) => f.key === key); }
function issueFor(key) { return data.run?.issues.find((i) => i.failureKeys.includes(key)); }
function filingFor(issueId) { return data.run?.filing.find((f) => f.issueId === issueId); }

function overallStatus(id) {
  const os = outcomesFor(id).map((o) => o.status);
  if (!os.length) return 'none';
  if (os.includes('failed')) return 'failed';
  if (os.includes('flaky')) return 'flaky';
  if (os.every((s) => s === 'skipped')) return 'skipped';
  return 'passed';
}

function render() {
  $('#project').textContent = data.project.name;
  $('#url').textContent = data.project.baseUrl;
  const sel = $('#run');
  sel.innerHTML = data.runs.map((r) => '<option value="' + esc(r.id) + '"' + (data.run && r.id === data.run.id ? ' selected' : '') + '>' +
    esc(r.id.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')) + ' — ' + r.stats.passed + ' passed, ' + r.stats.failed + ' failed</option>').join('');
  sel.onchange = () => load(sel.value);
  const cu = $('#clickup');
  if (!data.clickup.configured) { cu.textContent = 'ClickUp not configured'; cu.className = 'status'; }
  else if (!data.clickup.tokenPresent) { cu.textContent = 'ClickUp token missing — start ai-qa ui with the token in the environment'; cu.className = 'status warn'; }
  else { cu.textContent = 'ClickUp ready · list ' + data.clickup.listId; cu.className = 'status ok'; }

  const main = $('#main');
  if (!data.scenarios.length) { main.innerHTML = '<p class="empty">No scenarios yet. Run <code>ai-qa scenarios</code> first.</p>'; return; }
  if (!data.run) { main.innerHTML = '<p class="empty">No test run yet. Run <code>ai-qa run</code> or <code>ai-qa test</code>.</p>'; return; }

  const s = data.run.stats;
  const pages = [...new Set(data.scenarios.map((x) => x.page))].sort();
  const categories = [...new Set(data.scenarios.map((x) => x.category))].sort();
  const withStatus = data.scenarios.map((sc) => ({ sc, status: overallStatus(sc.id) }));
  const visible = withStatus.filter(({ sc, status }) =>
    (!filters.page || sc.page === filters.page) && (!filters.category || sc.category === filters.category) && (!filters.status || status === filters.status));

  let html = '<div class="summary">' +
    '<span><span class="n pass">' + s.passed + '</span><span class="l">passed</span></span>' +
    '<span><span class="n fail">' + s.failed + '</span><span class="l">failed</span></span>' +
    (s.flaky ? '<span><span class="n flaky">' + s.flaky + '</span><span class="l">flaky</span></span>' : '') +
    '<span><span class="n">' + data.run.issues.length + '</span><span class="l">distinct defects</span></span>' +
    '<span class="l">' + data.scenarios.length + ' scenarios</span></div>';
  html += '<div class="strip" aria-label="Each block is one scenario; click to jump to it">' +
    withStatus.map(({ sc, status }) => '<button class="' + status + '" title="' + esc(sc.id + ' — ' + status) + '" onclick="jump(\'' + esc(sc.id) + '\')"></button>').join('') + '</div>';
  html += '<div class="filters">' +
    sel2('page', 'Page', pages) + sel2('category', 'Category', categories) +
    sel2('status', 'Result', ['passed', 'failed', 'flaky', 'none'], { none: 'not run' }) +
    '<span class="meta">' + visible.length + ' shown</span></div>';

  for (const page of pages) {
    const rows = visible.filter((v) => v.sc.page === page);
    if (!rows.length) continue;
    const fails = rows.filter((r) => r.status === 'failed').length;
    html += '<section class="page"><h2>' + esc(page) + '<small>' + rows.length + ' scenarios' + (fails ? ', ' + fails + ' failing' : '') + '</small></h2>';
    html += '<table><thead><tr><th>ID</th><th>Scenario</th><th>Type</th><th>Result</th><th>Analysis</th></tr></thead><tbody>';
    for (const { sc, status } of rows) {
      const outs = outcomesFor(sc.id);
      const analysis = outs.map((o) => {
        const f = failureFor(o.key); if (!f) return '';
        const issue = issueFor(o.key);
        const bug = f.classification === 'PRODUCT_BUG' || f.classification === 'DESIGN_MISMATCH';
        return '<span class="cls ' + (bug ? 'bug' : 'other') + '">' + esc(f.classification.replace('_', ' ').toLowerCase()) + (issue ? ' · ' + esc(issue.id) : '') + '</span>';
      }).filter(Boolean).join('<br>');
      html += '<tr class="row" id="row-' + esc(sc.id) + '" onclick="toggle(\'' + esc(sc.id) + '\')">' +
        '<td class="id">' + esc(sc.id) + '</td>' +
        '<td>' + esc(sc.title) + '<div class="meta">' + esc(sc.feature) + ' · ' + esc(sc.priority) + ' priority</div></td>' +
        '<td class="meta">' + esc(sc.category) + '<br>' + esc(sc.viewport) + '</td>' +
        '<td><span class="result ' + status + '">' + (status === 'none' ? 'not run' : status) + '</span>' +
        (outs.length > 1 ? '<div class="meta">' + outs.map((o) => esc(o.project.replace('chromium-', '')) + ' ' + o.status).join(', ') + '</div>' : '') + '</td>' +
        '<td>' + (analysis || '<span class="meta">—</span>') + '</td></tr>';
      html += '<tr class="detail" id="detail-' + esc(sc.id) + '" hidden><td colspan="5">' + detail(sc, outs) + '</td></tr>';
    }
    html += '</tbody></table></section>';
  }
  main.innerHTML = html;
  for (const k of Object.keys(filters)) { const el = $('#f-' + k); if (el) el.onchange = () => { filters[k] = el.value; render(); }; }
}

function sel2(key, label, options, names = {}) {
  return '<label>' + label + ' <select id="f-' + key + '"><option value="">all</option>' +
    options.map((o) => '<option value="' + esc(o) + '"' + (filters[key] === o ? ' selected' : '') + '>' + esc(names[o] || o) + '</option>').join('') + '</select></label>';
}

function detail(sc, outs) {
  let left = '<div class="detail"><h4>Steps</h4><ol>' + sc.steps.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ol>' +
    '<h4>Expected</h4><ul>' + sc.expectedResults.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
  if (sc.preconditions?.length) left += '<h4>Preconditions</h4><ul>' + sc.preconditions.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
  left += '</div>';
  let right = '<div class="detail evidence">';
  if (!outs.length) right += '<p class="note">This scenario was not part of the selected run.</p>';
  for (const o of outs) {
    const a = o.artifacts;
    if (outs.length > 1) right += '<h4>' + esc(o.project) + '</h4>';
    if (o.error) right += '<h4>Error</h4><pre class="error">' + esc(o.error.message) + '</pre>';
    const f = failureFor(o.key);
    if (f) {
      right += '<h4>Analysis · ' + esc(f.classification.replace('_', ' ')) + ' (' + Math.round(f.confidence * 100) + '% confidence)</h4><p>' + esc(f.summary) + '</p>';
      if (f.testProblem) right += '<p class="note">Test problem: ' + esc(f.testProblem) + '</p>';
      const issue = issueFor(o.key);
      if (issue) right += issueBlock(issue);
    }
    if (a.screenshots[0]) right += '<h4>Screenshot</h4><a href="' + file(a.screenshots[0]) + '" target="_blank"><img loading="lazy" src="' + file(a.screenshots[0]) + '" alt="Final screenshot of ' + esc(o.key) + '"></a>';
    if (a.video) right += '<h4>Video</h4><video controls preload="metadata" src="' + file(a.video) + '"></video>';
    right += '<div class="links">' +
      (a.trace ? '<a href="' + file(a.trace) + '">Download trace</a>' : '') +
      (a.logs ? '<a href="' + file(a.logs) + '" target="_blank">Console & network log</a>' : '') +
      (a.errorContext ? '<a href="' + file(a.errorContext) + '" target="_blank">Page snapshot at failure</a>' : '') +
      a.design.map((d) => '<a href="' + file(d) + '" target="_blank">' + esc(d.split('_').pop()) + '</a>').join('') + '</div>';
  }
  right += '</div>';
  return '<div class="detail-grid">' + left + right + '</div>';
}

function issueBlock(issue) {
  const filed = filingFor(issue.id);
  let html = '<div class="issue" id="issue-' + esc(issue.id) + '"><b>' + esc(issue.id) + ': ' + esc(issue.bug.title) + '</b>' +
    '<span class="meta">' + esc(issue.bug.severity) + ' · ' + esc(issue.bug.category) + ' · tests ' + esc(issue.scenarioIds.join(', ')) + '</span>' +
    '<div class="rc">Root cause: ' + esc(issue.bug.suspectedRootCause) + '</div><div style="margin-top:10px">';
  if (filed && (filed.action === 'created' || filed.action === 'commented')) {
    html += '<span class="filed">Logged in ClickUp</span> · <a href="' + esc(filed.url || '#') + '" target="_blank">open task ' + esc(filed.taskId) + '</a>';
  } else {
    const can = data.clickup.configured && data.clickup.tokenPresent;
    html += '<button class="file" ' + (can ? '' : 'disabled') + ' onclick="event.stopPropagation(); fileIssue(\'' + esc(issue.id) + '\', this)">Log bug in ClickUp</button>';
    if (!issue.fileable) html += '<div class="note">Not filed automatically: ' + esc(issue.notFiledReason) + '. You can still log it.</div>';
    if (filed && filed.action === 'failed') html += '<div class="note">Last attempt failed: ' + esc(filed.reason) + '</div>';
  }
  return html + '</div></div>';
}

async function fileIssue(issueId, btn) {
  btn.disabled = true; btn.textContent = 'Logging…';
  const res = await fetch('/api/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: data.run.id, issueId }) });
  const body = await res.json();
  if (!res.ok) { btn.disabled = false; btn.textContent = 'Log bug in ClickUp'; alert('Could not log the bug: ' + (body.error || body.reason || res.status)); return; }
  await load(data.run.id);
  for (const sc of data.scenarios) if (data.run.issues.find((i) => i.id === issueId)?.scenarioIds.includes(sc.id)) toggle(sc.id, true);
}

function toggle(id, open) {
  const d = document.getElementById('detail-' + id);
  if (d) d.hidden = open === undefined ? !d.hidden : !open;
}
function jump(id) {
  filters = { page: '', category: '', status: '' }; render();
  toggle(id, true);
  document.getElementById('row-' + id)?.scrollIntoView({ block: 'center' });
}
load();
</script>
</body>
</html>`;

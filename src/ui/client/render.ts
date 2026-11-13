/** Rendering of the page: rail (pages, trackers), header toolbar, job banner, verdict and the list. */
import { $, act } from './dom.js';
import {
  classificationOf,
  esc,
  failingOutcome,
  fmtRun,
  human,
  isBug,
  isFailing,
  issueFor,
  listModel,
  type ScenarioView,
  type Status,
  type View,
} from './logic.js';
import { state } from './state.js';

export const typeChip = (sc: ScenarioView): string =>
  '<span class="chip chip-' +
  esc(sc.category) +
  '">' +
  esc(sc.category) +
  '</span>' +
  (sc.origin === 'person'
    ? ' <span class="chip chip-person" title="Written or edited by a person; the AI will not change or remove it">yours</span>'
    : '') +
  (sc.critical
    ? ' <span class="chip chip-critical" title="Critical flow: a core journey in the smoke tests (ai-qa-agent test --critical)">critical</span>'
    : '');

const TEST_STATE = { missing: 'no test yet', outdated: 'test out of date' } as const;
const testChip = (sc: ScenarioView): string => {
  const t = state.data.testStates[sc.id];
  return t ? ' <span class="chip chip-todo">' + TEST_STATE[t] + '</span>' : '';
};

export const addButton = (): string =>
  state.data.authoring.pages.length
    ? '<button class="btn" ' + act('open-editor') + '>Add scenario</button>'
    : '';

/* ---------- bug trackers in the rail ---------- */
const TRACKER_STATE = {
  connected: ['text-pass', 'Connected'],
  'missing-credentials': ['text-flaky', 'Credentials missing'],
  error: ['text-fail', 'Cannot connect'],
  'not-configured': ['text-rail-muted', 'Not configured'],
} as const;

export function renderTrackers(): void {
  const el = $('#tracker');
  const head =
    '<b class="block text-[11.5px] font-bold uppercase tracking-[0.12em] text-rail-muted">Bug trackers</b>';
  const trackers = state.trackers;
  if (!trackers) {
    el.innerHTML = head + '<span class="mt-1 block">Checking…</span>';
    return;
  }
  el.innerHTML =
    head +
    trackers
      .map((t) => {
        const [cls, label] = TRACKER_STATE[t.state];
        const detail =
          t.state === 'connected'
            ? esc(t.detail)
            : t.state === 'missing-credentials'
              ? 'Set ' +
                t.missingEnv.map((v) => '<code class="font-mono">' + esc(v) + '</code>').join(' and ') +
                ' in the shell that started ai-qa-agent ui.'
              : t.state === 'error'
                ? esc(
                    String(t.detail || '')
                      .split('\n')[0]!
                      .slice(0, 160),
                  )
                : 'Add a <code class="font-mono">' +
                  t.kind +
                  '</code> section to .qa/config.ts to file bugs here.';
        return (
          '<div class="mt-2.5"><div class="flex items-center justify-between gap-2"><span class="font-semibold text-rail-ink">' +
          esc(t.name) +
          '</span>' +
          '<span class="text-xs font-bold ' +
          cls +
          '">' +
          label +
          '</span></div>' +
          '<p class="m-0 mt-0.5 text-xs leading-snug">' +
          (t.active ? 'Bugs are filed here' + (t.target ? ' · ' + esc(t.target) : '') + '. ' : '') +
          detail +
          '</p></div>'
        );
      })
      .join('');
}

/* ---------- header toolbar and job banner ---------- */
function toolbar(notRunWithTest: number, failed: number): string {
  const { data } = state;
  const busy = data.job?.status === 'running';
  const dis = busy ? ' disabled title="' + esc(data.job!.label) + '…"' : '';
  const critical = data.scenarios.filter(
    (sc) => sc.critical && sc.approved && data.testStates[sc.id] !== 'missing',
  ).length;
  return (
    '<div class="flex flex-wrap items-center gap-2">' +
    '<button class="btn-quiet" ' +
    act('refresh') +
    ' title="Reload results and re-check the bug trackers">Refresh</button>' +
    (notRunWithTest
      ? '<button class="btn btn-ghost"' +
        dis +
        ' ' +
        act('start-job', { url: '/api/runs/not-run' }) +
        ' title="Run every test without a result in this run and add the results to it">Run not-run tests (' +
        notRunWithTest +
        ')</button>'
      : '') +
    (failed && data.run
      ? '<button class="btn btn-ghost"' +
        dis +
        ' ' +
        act('start-job', { url: '/api/runs/failed' }) +
        ' title="Run only the failed and flaky tests of this run again and update their results in it">Run failed tests (' +
        failed +
        ')</button>'
      : '') +
    '<button class="btn btn-ghost"' +
    dis +
    ' ' +
    act('start-job', { url: '/api/runs/all' }) +
    ' title="Start a new run with every test, like ai-qa-agent test">Run all tests</button>' +
    (critical
      ? '<button id="run-critical" class="btn btn-ghost" aria-label="Run critical flows"' +
        dis +
        ' ' +
        act('start-job', { url: '/api/runs/critical' }) +
        ' title="Start a new run with only the critical flows, like ai-qa-agent test --critical">Run critical flows (' +
        critical +
        ')</button>'
      : '') +
    planButtons(busy) +
    addButton() +
    '</div>'
  );
}

/** Create / update the bug-fix plan of the selected run, and open it once it exists. */
function planButtons(busy: boolean): string {
  const pl = state.data.plan;
  if (!pl) return '';
  const why = !pl.failures
    ? 'No failed tests in this run, nothing to plan'
    : busy
      ? state.data.job!.label + '…'
      : '';
  const label = pl.exists ? 'Update fix plan' : 'Create fix plan';
  const title =
    why ||
    'The AI reads your code and writes a plan for fixing the bugs behind the ' +
      pl.failures +
      ' failed test' +
      (pl.failures === 1 ? '' : 's') +
      ' to ' +
      pl.file;
  return (
    (pl.exists
      ? '<button class="btn-quiet" ' + act('view-plan') + ' title="' + esc(pl.file) + '">View plan</button>'
      : '') +
    '<button class="btn btn-ghost"' +
    (why ? ' disabled' : '') +
    ' title="' +
    esc(title) +
    '" ' +
    act('create-plan') +
    '>' +
    label +
    '</button>'
  );
}

function jobBanner(): string {
  const j = state.data.job;
  if (!j || !state.watched || j.startedAt !== state.watched) return '';
  const since = new Date(j.startedAt).toLocaleTimeString();
  if (j.status === 'running') {
    return (
      '<section class="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface px-5 py-4" role="status" aria-live="polite">' +
      '<span class="size-2.5 animate-pulse rounded-full bg-accent" aria-hidden="true"></span>' +
      '<p class="m-0 text-sm font-semibold">' +
      esc(j.label) +
      '…</p><p class="m-0 text-[13px] text-muted">Started ' +
      esc(since) +
      '. The results appear here when it is done.</p>' +
      '<button class="btn-quiet btn-quiet-danger ml-auto" ' +
      act('cancel-job') +
      ' title="Stop it now; nothing is changed">Cancel</button></section>'
    );
  }
  if (j.status === 'cancelled') {
    return (
      '<section class="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface px-5 py-4" role="status">' +
      '<p class="m-0 min-w-0 flex-1 text-sm font-semibold text-muted">' +
      esc(j.label) +
      ': ' +
      esc(j.message) +
      '</p><button class="btn-quiet" ' +
      act('dismiss-job') +
      '>Dismiss</button></section>'
    );
  }
  const ok = j.status === 'done';
  return (
    '<section class="mb-6 flex flex-wrap items-center gap-3 rounded-2xl px-5 py-4 ' +
    (ok ? 'bg-accent-soft' : 'bg-fail-soft') +
    '" role="status">' +
    '<p class="m-0 min-w-0 flex-1 text-sm font-semibold ' +
    (ok ? 'text-accent' : 'text-fail') +
    '">' +
    esc(ok ? j.message : 'Could not finish: ' + j.message) +
    '</p>' +
    (ok && j.kind === 'plan' && j.file
      ? '<button class="btn btn-ghost" ' + act('view-plan') + '>View plan</button>'
      : '') +
    '<button class="btn-quiet" ' +
    act('dismiss-job') +
    '>Dismiss</button></section>'
  );
}

/* ---------- the page ---------- */
export function render(): void {
  const { data, view } = state;
  $('#project').textContent = data.project.name;
  $('#url').textContent = data.project.baseUrl;
  const sel = $<HTMLSelectElement>('#run');
  sel.innerHTML = data.runs
    .map(
      (r) =>
        '<option value="' +
        esc(r.id) +
        '"' +
        (data.run && r.id === data.run.id ? ' selected' : '') +
        '>' +
        esc(fmtRun(r.id)) +
        '</option>',
    )
    .join('');
  $('#project-bar').textContent = data.project.name;
  $('#page-bar').textContent = (view.page || 'All pages') + (data.run ? ' · run ' + fmtRun(data.run.id) : '');
  const runInfo = data.runs.find((r) => data.run && r.id === data.run.id);
  $('#runmeta').textContent =
    runInfo && runInfo.stats
      ? runInfo.stats.passed + runInfo.stats.failed + runInfo.stats.flaky + ' tests · ' + runInfo.status
      : '';

  renderTrackers();

  const main = $('#main');
  const empty = (msg: string) =>
    '<div class="rounded-2xl border border-dashed border-line-strong px-6 py-14 text-center text-muted">' +
    msg +
    '</div>';
  const orAdd = data.authoring.pages.length ? '<p class="mb-0 mt-4">' + addButton() + '</p>' : '';
  if (!data.scenarios.length) {
    $('#nav').innerHTML = '';
    main.innerHTML = empty(
      'No scenarios yet. Run <code class="font-mono text-[13px]">ai-qa-agent scenarios</code> first, or write your own.' +
        orAdd,
    );
    return;
  }

  const m = listModel(data, view);
  view.only = m.only;

  // Rail: pages with a heat strip (one cell per test in this run) and counts.
  $('#nav').innerHTML = ['', ...m.pages]
    .map((p) => {
      const rows = (p ? m.all.filter((x) => x.sc.page === p) : m.all).filter((x) => x.status !== 'none');
      const fail = rows.filter((x) => x.status !== 'passed').length;
      return (
        '<li class="my-0.5"><button class="rail-btn" aria-current="' +
        (view.page === p) +
        '" ' +
        act('set-page', { page: p }) +
        '>' +
        '<span class="flex w-full items-center justify-between gap-2"><span class="truncate font-semibold">' +
        (p ? esc(p) : 'All pages') +
        '</span>' +
        '<span class="shrink-0 text-xs ' +
        (fail ? 'font-bold text-fail' : 'text-rail-muted') +
        '">' +
        (rows.length ? (fail ? fail + ' failing' : rows.length + ' passed') : 'not in run') +
        '</span></span>' +
        (rows.length
          ? '<span class="flex flex-wrap gap-[3px]" aria-hidden="true">' +
            rows.map((x) => '<i class="cell cell-' + x.status + '"></i>').join('') +
            '</span>'
          : '') +
        '</button></li>'
      );
    })
    .join('');

  const s = data.run?.stats ?? { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  const ran = s.passed + s.failed + s.flaky;
  const defects = data.run?.issues.length ?? 0;
  const byType = data.authoring.categories
    .map((t) => {
      const rows = m.inRun.filter((x) => x.sc.category === t);
      return { t, total: rows.length, failed: rows.filter((x) => x.status !== 'passed').length };
    })
    .filter((x) => x.total);

  let html =
    '<div class="mb-6 flex flex-wrap items-end justify-between gap-3"><div>' +
    '<h1 class="m-0 text-[28px] font-extrabold tracking-tight">Test results</h1>' +
    '<p class="m-0 mt-1 text-sm text-muted">' +
    (data.run
      ? 'Run ' + esc(fmtRun(data.run.id)) + ' against ' + esc(data.project.baseUrl)
      : 'No test run yet. Run a test below, or all of them with <code class="font-mono text-[13px]">ai-qa-agent test</code>.') +
    '</p></div>' +
    toolbar(m.notRunWithTest, m.failed) +
    '</div>' +
    jobBanner();

  if (data.run)
    html +=
      '<section class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center rounded-2xl border border-line bg-surface p-5 md:p-6" aria-label="Verdict">' +
      ring(s, ran) +
      '<div><p class="m-0 text-[13px] font-semibold text-muted">By test type</p><div class="mt-2 grid gap-2">' +
      byType
        .map(
          (b) =>
            '<div class="grid grid-cols-[92px_minmax(0,1fr)_64px] items-center gap-3 text-sm"><span class="chip chip-' +
            b.t +
            ' justify-self-start">' +
            b.t +
            '</span>' +
            '<span class="flex h-2 overflow-hidden rounded-full bg-line"><span class="block h-full bg-pass" style="width:' +
            (100 * (b.total - b.failed)) / b.total +
            '%"></span><span class="block h-full bg-fail" style="width:' +
            (100 * b.failed) / b.total +
            '%"></span></span>' +
            '<span class="text-right text-[13px] text-muted">' +
            (b.total - b.failed) +
            '/' +
            b.total +
            '</span></div>',
        )
        .join('') +
      '</div></div>' +
      '<div class="md:border-l md:border-line md:pl-6"><p class="m-0 text-[13px] font-semibold text-muted">Distinct defects</p>' +
      '<p class="m-0 mt-1 text-[36px] font-extrabold leading-none tracking-tight ' +
      (defects ? 'text-fail' : 'text-pass') +
      '">' +
      defects +
      '</p>' +
      '<p class="m-0 mt-1 text-[13px] text-muted">' +
      (defects ? 'across ' + s.failed + ' failing tests' : 'nothing to report') +
      '</p></div></section>';

  const labels = {
    all: 'All',
    failed: 'Failures',
    passed: 'Passing',
    notrun: 'Not run (' + m.notRun + ')',
    todo: 'Needs test (' + m.todo + ')',
  } as const;
  const kinds: View['only'][] = [
    'all',
    'failed',
    'passed',
    ...(m.notRun ? (['notrun'] as const) : []),
    ...(m.todo ? (['todo'] as const) : []),
  ];
  const segs = kinds.map(
    (k) =>
      '<button class="seg-btn" aria-pressed="' +
      (view.only === k) +
      '" ' +
      act('set-only', { only: k }) +
      '>' +
      labels[k] +
      '</button>',
  );
  html +=
    '<div class="sticky top-14 z-10 lg:top-0 -mx-4 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 bg-bg/95 px-4 py-2.5 backdrop-blur md:-mx-8 md:px-8">' +
    '<div class="inline-flex overflow-hidden rounded-lg border border-line-strong bg-surface" role="group" aria-label="Show">' +
    segs.join('') +
    '</div>' +
    '<select class="field" aria-label="Type" data-filter="type"><option value="">All types</option>' +
    m.types
      .map(
        (t) =>
          '<option value="' +
          esc(t) +
          '"' +
          (view.type === t ? ' selected' : '') +
          '>' +
          esc(t) +
          '</option>',
      )
      .join('') +
    '</select>' +
    '<input id="search" class="field w-52" type="search" placeholder="Search id or title" value="' +
    esc(view.q) +
    '" aria-label="Search" data-filter="q">' +
    '<span class="ml-auto text-[13px] text-muted">' +
    m.rows.length +
    ' of ' +
    m.all.length +
    '</span></div>';

  if (!m.rows.length) html += empty('Nothing matches this filter.');
  for (const page of m.pages) {
    const group = m.rows.filter((x) => x.sc.page === page);
    if (!group.length) continue;
    const fails = group.filter((x) => isFailing(x.status)).length;
    html +=
      '<div class="mb-2 mt-7 flex items-baseline gap-2.5"><h2 class="m-0 font-mono text-[15px] font-semibold">' +
      esc(page) +
      '</h2><span class="text-[13px] text-muted">' +
      group.length +
      ' scenarios' +
      (fails ? ' · <span class="font-semibold text-fail">' + fails + ' failing</span>' : '') +
      '</span></div>' +
      '<ul class="m-0 list-none overflow-hidden rounded-xl border border-line bg-surface p-0">';
    for (const { sc, status } of group) html += row(sc, status);
    html += '</ul>';
  }
  main.innerHTML = html;
  requestAnimationFrame(() =>
    document.querySelectorAll<SVGCircleElement>('.ring-arc').forEach((el) => {
      el.style.strokeDashoffset = el.dataset.to ?? '';
    }),
  );
}

/** Pass-ratio ring: passed (green) and flaky (amber) arcs over a failed (red) track. */
function ring(s: { passed: number; failed: number; flaky: number }, ran: number): string {
  const r = 46,
    c = 2 * Math.PI * r;
  const pass = ran ? s.passed / ran : 0,
    flaky = ran ? s.flaky / ran : 0;
  const arc = (frac: number, offsetFrac: number, cls: string) =>
    '<circle class="ring-arc" cx="60" cy="60" r="' +
    r +
    '" fill="none" stroke="var(--color-' +
    cls +
    ')" stroke-width="12" stroke-linecap="butt" ' +
    'stroke-dasharray="' +
    c +
    '" stroke-dashoffset="' +
    c +
    '" data-to="' +
    (c - c * frac) +
    '" transform="rotate(' +
    (-90 + 360 * offsetFrac) +
    ' 60 60)"></circle>';
  return (
    '<div class="flex items-center gap-5"><svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label="' +
    s.passed +
    ' of ' +
    ran +
    ' tests passed">' +
    '<circle cx="60" cy="60" r="' +
    r +
    '" fill="none" stroke="var(--color-' +
    (s.failed ? 'fail' : 'line') +
    ')" stroke-width="12"></circle>' +
    arc(pass, 0, 'pass') +
    (flaky ? arc(flaky, pass, 'flaky') : '') +
    '<text x="60" y="58" text-anchor="middle" font-size="26" font-weight="800" fill="var(--color-ink)" font-family="Manrope, sans-serif">' +
    Math.round(pass * 100) +
    '%</text>' +
    '<text x="60" y="76" text-anchor="middle" font-size="11" font-weight="600" fill="var(--color-muted)" font-family="Manrope, sans-serif">passed</text></svg>' +
    '<div class="text-sm"><p class="m-0 text-[30px] font-extrabold leading-none tracking-tight">' +
    s.passed +
    '<span class="text-lg font-semibold text-muted">/' +
    ran +
    '</span></p>' +
    '<p class="m-0 mt-2 text-muted"><span class="font-semibold text-pass">' +
    s.passed +
    ' passed</span> · <span class="font-semibold text-fail">' +
    s.failed +
    ' failed</span>' +
    (s.flaky ? ' · <span class="font-semibold text-flaky">' + s.flaky + ' flaky</span>' : '') +
    '</p></div></div>'
  );
}

function row(sc: ScenarioView, status: Status): string {
  const cls = classificationOf(state.data, sc);
  const failing = isFailing(status);
  const chips =
    typeChip(sc) +
    testChip(sc) +
    (failing
      ? '<span class="chip ' +
        (cls && isBug(cls) ? 'chip-bug' : 'chip-other') +
        '">' +
        esc(cls ? human(cls) : 'not analyzed') +
        '</span>'
      : '');
  return (
    '<li class="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-3.5 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[14px_118px_minmax(0,1fr)_auto] ' +
    (failing ? 'row-' + status : '') +
    '">' +
    '<button class="group col-span-2 grid min-w-0 cursor-pointer grid-cols-subgrid items-center gap-3.5 border-0 bg-transparent p-0 text-left text-inherit sm:col-span-3" ' +
    act('open-modal', { id: sc.id }) +
    ' aria-haspopup="dialog">' +
    '<span class="dot dot-' +
    status +
    '" aria-label="' +
    status +
    '"></span>' +
    '<span class="hidden font-mono text-[12.5px] text-muted sm:block">' +
    esc(sc.id) +
    '</span>' +
    '<span class="flex min-w-0 items-center gap-2"><span class="min-w-0 truncate font-medium group-hover:text-accent">' +
    esc(sc.title) +
    '</span><span class="flex shrink-0 gap-1.5">' +
    chips +
    '</span>' +
    '<span class="ml-1 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true">›</span></span></button>' +
    '<span class="col-start-2 flex items-center gap-2.5 whitespace-nowrap sm:col-start-4" data-action-for="' +
    esc(sc.id) +
    '">' +
    action(sc, status) +
    '</span></li>'
  );
}

/** The action next to a row (and in the modal footer): run a not-run test, or file / open a bug. */
export function action(sc: ScenarioView, status: Status): string {
  const { data } = state;
  if (status === 'none') {
    return sc.approved && data.testStates[sc.id] !== 'missing'
      ? '<button class="btn btn-ghost" ' + act('run-test', { id: sc.id }) + '>Run test</button>'
      : '';
  }
  if (!isFailing(status)) return '';
  const tr = data.tracker;
  if (!tr.configured || !data.run) return '';
  const o = failingOutcome(data, sc);
  if (!o) return '';
  if (data.run.tasksPending)
    return '<span class="text-xs text-muted" aria-live="polite">checking ' + esc(tr.name) + '…</span>';
  const task = data.run.tasks[o.key];
  if (task && task.exists) {
    return (
      '<a class="btn btn-ghost" href="' +
      esc(task.url || '#') +
      '" target="_blank" rel="noopener" title="' +
      esc(task.status ? 'Status in ' + tr.name + ': ' + task.status : '') +
      '">' +
      (tr.noun === 'issue' ? 'Open ' + esc(task.taskId) : 'Open task ' + esc(task.taskId)) +
      '</a>'
    );
  }
  const issue = issueFor(data, o.key);
  const body = issue ? { issueId: issue.id } : { failureKey: o.key };
  const disabled = tr.tokenPresent
    ? ''
    : 'disabled title="' +
      'Set ' +
      esc(tr.missingEnv.join(' and ')) +
      ' in the shell that started ai-qa-agent ui"';
  return (
    '<button class="btn" ' +
    disabled +
    ' ' +
    act('file-bug', { body: JSON.stringify(body) }) +
    '>Create ' +
    tr.noun +
    '</button>'
  );
}

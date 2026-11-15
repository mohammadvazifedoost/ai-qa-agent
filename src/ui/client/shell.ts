/** The frame around every page: the menu, the top bar (run, actions, theme) and the job banner. */
import { $, act } from './dom.js';
import {
  defectsOf,
  esc,
  initials,
  listModel,
  passRate,
  plural,
  projectSummary,
  routeHash,
  runCounts,
  runLabel,
  shortUrl,
  verdictOf,
  type PageName,
} from './logic.js';
import { state } from './state.js';
import { currentTheme } from './theme.js';
import { statusPill } from './ui.js';

const svg = (body: string, size = 20, stroke = 1.8): string =>
  '<svg class="shrink-0" width="' +
  size +
  '" height="' +
  size +
  '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
  stroke +
  '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  body +
  '</svg>';

/** Line icons, drawn in the colour of the text around them. They never stand alone without a name. */
const ICON = {
  overview: svg(
    '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  ),
  defects: svg(
    '<rect x="8" y="7" width="8" height="13" rx="4"/><path d="M12 11v9M9.5 4l1.2 2.4M14.5 4l-1.2 2.4M8 11.5H4.5M8 15.5H4M16 11.5h3.5M16 15.5h4"/>',
  ),
  scenarios: svg(
    '<path d="M3.5 6.5 5 8l3-3M3.5 12.5 5 14l3-3M3.5 18.5 5 20l3-3M12 6.5h9M12 12.5h9M12 18.5h9"/>',
  ),
  project: svg('<path d="M12 3 3 7.5l9 4.5 9-4.5L12 3zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5"/>'),
  tracker: svg('<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7zM12 17v5"/>'),
  storage: svg(
    '<ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/>',
  ),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 18, 2.2),
  run: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 18, 2),
  // The theme icon shows what the button switches to.
  dark: svg('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>', 20, 2),
  light: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    20,
    2,
  ),
  refresh: svg(
    '<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.3L20 15.5M20 20v-4.5h-4.5"/>',
    20,
    2,
  ),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 18, 2),
  play: '<svg class="shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5-12-7.5z"/></svg>',
  chevron:
    '<svg class="shrink-0" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5l4 4 4-4"/></svg>',
};

function nav(defects: number): string {
  const { data, route } = state;
  const badge = (text: string | number, kind = '') =>
    text ? '<span class="nav-badge ' + kind + '">' + text + '</span>' : '';
  const entry = (page: PageName, text: string, extra = '') =>
    '<li><a class="nav-link" href="' +
    routeHash(page) +
    '"' +
    (route.page === page ? ' aria-current="page"' : '') +
    '>' +
    ICON[page] +
    '<span class="flex-1">' +
    text +
    '</span>' +
    extra +
    '</a></li>';
  // Results are read; Setup is where the agent's knowledge of the application is brought up to date.
  const group = (id: string, name: string, entries: string, first = false) =>
    '<p id="' +
    id +
    '" class="m-0 px-3 pb-0.5 text-[13px] text-muted' +
    (first ? '' : ' pt-3') +
    '">' +
    name +
    '</p><ul class="m-0 flex list-none flex-col gap-1 p-0" aria-labelledby="' +
    id +
    '">' +
    entries +
    '</ul>';
  return (
    group(
      'nav-results',
      'Results',
      entry('overview', 'Overview') +
        entry('defects', 'Defects', badge(defects, 'nav-badge-fail')) +
        entry('scenarios', 'Scenarios', badge(data.scenarios.length)),
      true,
    ) +
    group(
      'nav-setup',
      'Setup',
      entry(
        'project',
        'Project',
        state.project && projectSummary(state.project).outdated ? badge('Out of date', 'nav-badge-warn') : '',
      ) +
        entry('tracker', 'Bug tracker', trackerBadge()) +
        entry('storage', 'Storage'),
    )
  );
}

/** The Bug tracker entry says when bugs cannot be filed: none connected, a token missing, an error. */
function trackerBadge(): string {
  const { trackers } = state;
  if (!trackers) return '';
  const active = trackers.find((t) => t.active);
  if (active?.state === 'connected') return '';
  return active?.state === 'error'
    ? '<span class="nav-badge nav-badge-fail">Error</span>'
    : '<span class="nav-badge nav-badge-warn">Set up</span>';
}

/** The selected run at a glance, on every page: a ring of passed, flaky and failed tests. */
function runCard(): string {
  const s = state.data.run?.stats;
  const rate = passRate(s);
  if (!s || !rate) return '';
  const arc = (n: number, before: number, color: string) => {
    if (!n) return '';
    const share = (n / rate.ran) * 100;
    return (
      '<circle cx="18" cy="18" r="15" stroke="var(--color-' +
      color +
      ')" stroke-width="5" pathLength="100" stroke-dasharray="' +
      share.toFixed(2) +
      ' ' +
      (100 - share).toFixed(2) +
      '" stroke-dashoffset="' +
      (-(before / rate.ran) * 100).toFixed(2) +
      '"/>'
    );
  };
  const line = s.failed
    ? '<span class="st-failed">' +
      s.failed +
      ' of ' +
      rate.ran +
      ' failed' +
      (s.flaky ? ', ' + s.flaky + ' flaky' : '') +
      '</span>'
    : s.flaky
      ? '<span class="st-flaky">' + s.flaky + ' of ' + rate.ran + ' flaky</span>'
      : '<span class="st-passed">' +
        (rate.ran === 1 ? 'The test passed' : 'All ' + rate.ran + ' tests passed') +
        '</span>';
  return (
    '<div class="flex items-center gap-3.5 rounded-xl border border-line bg-surface p-3.5">' +
    '<svg class="shrink-0 -rotate-90" width="56" height="56" viewBox="0 0 36 36" fill="none" aria-hidden="true">' +
    '<circle cx="18" cy="18" r="15" stroke="var(--color-line)" stroke-width="5"/>' +
    arc(s.passed, 0, 'pass') +
    arc(s.flaky, s.passed, 'flaky') +
    arc(s.failed, s.passed + s.flaky, 'fail') +
    '</svg><div class="flex min-w-0 flex-col text-[13px] leading-snug text-muted"><span>This run</span>' +
    '<span class="font-display text-[19px] font-bold text-white">' +
    rate.pct +
    '% passed</span>' +
    line +
    '</div></div>'
  );
}

/** The choices behind the Run tests button. */
function runMenu(): string {
  const { data } = state;
  const m = listModel(data, state.view);
  const critical = data.scenarios.filter(
    (sc) => sc.critical && sc.approved && data.testStates[sc.id] !== 'missing',
  ).length;
  const choice = (url: string, title: string, detail: string, show = true) =>
    show
      ? '<li><button type="button" class="menu-item" ' +
        act('start-job', { url }) +
        '><span class="font-semibold">' +
        title +
        '</span><span class="text-[13px] text-muted">' +
        detail +
        '</span></button></li>'
      : '';
  return (
    '<ul id="run-menu" hidden class="absolute left-0 top-full z-30 m-0 mt-1.5 w-[min(300px,calc(100vw-32px))] list-none sm:left-auto sm:right-0 rounded-xl border border-line bg-surface p-1.5 shadow-xl">' +
    choice('/api/runs/all', 'All tests', 'Starts a new run') +
    choice(
      '/api/runs/failed',
      'Failed tests (' + m.failed + ')',
      'Updates their results in this run',
      !!data.run && m.failed > 0,
    ) +
    choice('/api/runs/critical', 'Critical flows (' + critical + ')', 'Starts a new run', critical > 0) +
    choice(
      '/api/runs/not-run',
      'Tests not run yet (' + m.notRunWithTest + ')',
      'Adds their results to this run',
      m.notRunWithTest > 0,
    ) +
    '</ul>'
  );
}

function topbar(): string {
  const { data } = state;
  const busy = data.job?.status === 'running';
  const hasTests = data.scenarios.some((sc) => sc.approved && data.testStates[sc.id] !== 'missing');
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  const tile = (cls: string) =>
    '<span class="flex size-8 shrink-0 items-center justify-center rounded-md ' +
    cls +
    '">' +
    ICON.run +
    '</span>';
  const run = data.runs.length
    ? runPicker(tile('bg-accent-soft text-accent max-sm:hidden')) +
      statusPill(verdictOf(data.run?.stats), 'px-3 py-1.5 text-[15px]')
    : '<span class="inline-flex items-center gap-2.5 font-semibold text-ink-2">' +
      tile('bg-neutral-soft text-muted') +
      'No runs yet</span>';
  const iconButton = (action: string, name: string, title: string, icon: string) =>
    '<button type="button" class="btn btn-text btn-icon" ' +
    act(action) +
    ' aria-label="' +
    name +
    '" title="' +
    title +
    '">' +
    icon +
    '</button>';
  // On a phone the button keeps its name for screen readers and shows the plus alone.
  const add = data.authoring.pages.length
    ? '<button type="button" class="btn pl-3 max-sm:size-11 max-sm:px-0" ' +
      act('open-editor') +
      ' title="Write a new scenario">' +
      ICON.plus +
      '<span class="max-sm:sr-only">Add scenario</span></button>'
    : '';
  const tests = hasTests
    ? '<div class="relative"><button type="button" id="run-menu-btn" class="btn btn-primary pl-3.5"' +
      (busy ? ' disabled title="' + esc(data.job!.label) + '…"' : '') +
      ' aria-expanded="false" aria-controls="run-menu" ' +
      act('toggle-run-menu') +
      '>' +
      ICON.play +
      'Run tests' +
      ICON.chevron +
      '</button>' +
      runMenu() +
      '</div>'
    : '';
  return (
    run +
    '<div class="ml-auto flex flex-wrap items-center gap-1.5">' +
    iconButton('toggle-theme', 'Switch to ' + next + ' mode', 'Switch to ' + next + ' mode', ICON[next]) +
    iconButton('refresh', 'Refresh', 'Reload the results and check the bug tracker again', ICON.refresh) +
    (add || tests ? '<span class="mx-1.5 h-6 w-px bg-line max-sm:hidden" aria-hidden="true"></span>' : '') +
    add +
    tests +
    '</div>'
  );
}

/** Which run the pages show: a button that opens the list of runs, newest first, with their results. */
function runPicker(tile: string): string {
  const { data } = state;
  const current = data.run?.id ?? '';
  const items = data.runs
    .map((r, i) => {
      const verdict = verdictOf(r.stats);
      const word = { passed: 'Passed', failed: 'Failed', flaky: 'Flaky', none: 'No results' }[verdict];
      return (
        '<li><button type="button" class="menu-item flex-row items-center gap-3 aria-[current=true]:bg-accent-soft" ' +
        act('pick-run', { id: r.id }) +
        (r.id === current ? ' aria-current="true"' : '') +
        '><span class="mark mark-' +
        verdict +
        '" aria-hidden="true"></span><span class="flex min-w-0 flex-1 flex-col leading-snug"><span class="font-semibold">' +
        esc(runLabel(r.id)) +
        (i === 0 ? '<span class="ml-2 text-xs font-semibold text-accent">Latest</span>' : '') +
        '</span><span class="text-[13px] text-muted">' +
        esc(runCounts(r.stats)) +
        '</span></span><span class="shrink-0 text-[13px] font-semibold st-' +
        verdict +
        '">' +
        word +
        '</span>' +
        (r.id === current
          ? '<span class="text-accent">' + ICON.check + '</span>'
          : '<span class="w-[18px]"></span>') +
        '</button></li>'
      );
    })
    .join('');
  return (
    '<div class="relative min-w-0">' +
    '<button type="button" id="run-picker-btn" class="flex min-h-11 max-w-full cursor-pointer items-center gap-2.5 rounded-lg border border-control bg-surface py-1 pl-1.5 pr-3 text-left text-ink hover:bg-subtle aria-expanded:border-accent max-sm:pl-3" aria-haspopup="true" aria-expanded="false" aria-controls="run-picker" ' +
    act('toggle-run-picker') +
    '>' +
    tile +
    '<span class="flex min-w-0 flex-col leading-tight"><span class="text-xs text-muted">Run</span><span class="truncate font-semibold">' +
    esc(data.run ? runLabel(data.run.id) : 'Choose a run') +
    '</span></span>' +
    ICON.chevron +
    '</button>' +
    '<div id="run-picker" hidden class="absolute left-0 top-full z-30 mt-1.5 w-[min(380px,calc(100vw-32px))] max-sm:fixed max-sm:inset-x-4 max-sm:mt-0 max-sm:w-auto overflow-hidden rounded-xl border border-line bg-surface shadow-xl">' +
    '<div class="flex items-baseline justify-between px-4 pb-1 pt-3"><span class="font-bold">Runs</span><span class="text-[13px] text-muted">' +
    data.runs.length +
    ', newest first</span></div>' +
    '<ul aria-label="Runs" class="m-0 max-h-[min(420px,60vh)] list-none overflow-auto p-1.5">' +
    items +
    '</ul>' +
    (data.runs.length
      ? '<div class="border-t border-line p-1.5"><button type="button" class="menu-item text-fail-ink" ' +
        act('open-run-cleanup') +
        '>Delete old runs…</button></div>'
      : '') +
    '</div></div>'
  );
}

/** Create / update the bug-fix plan of the selected run, and open it once it exists. */
export function planButtons(cls = 'btn'): string {
  const { data } = state;
  const pl = data.plan;
  if (!pl || !pl.failures) return '';
  const busy = data.job?.status === 'running';
  return (
    '<button type="button" class="' +
    cls +
    '"' +
    (busy ? ' disabled' : '') +
    ' title="' +
    esc(
      busy
        ? data.job!.label + '…'
        : 'The AI reads your code and writes a plan for fixing the bugs behind the ' +
            plural(pl.failures, 'failed test') +
            ' to ' +
            pl.file,
    ) +
    '" ' +
    act('create-plan') +
    '>' +
    (pl.exists ? 'Update fix plan' : 'Create fix plan') +
    '</button>' +
    (pl.exists
      ? '<button type="button" class="btn" ' +
        act('view-plan') +
        ' title="' +
        esc(pl.file) +
        '">View fix plan</button>'
      : '')
  );
}

/** Progress and outcome of the run or plan this page started (or found running). */
export function jobBanner(): string {
  const j = state.data.job;
  if (!j || !state.watched || j.startedAt !== state.watched) return '';
  const box = 'panel mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3';
  if (j.status === 'running') {
    return (
      '<section class="' +
      box +
      '" role="status" aria-live="polite">' +
      '<span class="size-2.5 animate-pulse rounded-full bg-accent-fill motion-reduce:animate-none" aria-hidden="true"></span>' +
      '<p class="m-0 font-semibold">' +
      esc(j.label + (j.detail ? ', ' + j.detail : '')) +
      '…</p><p class="m-0 text-muted">Started at ' +
      esc(new Date(j.startedAt).toLocaleTimeString()) +
      (j.kind === 'scenarios'
        ? '. Each page is saved when it is done.'
        : '. The result appears here when it is done.') +
      '</p>' +
      '<button type="button" class="btn btn-text btn-text-danger ml-auto" ' +
      act('cancel-job') +
      ' title="' +
      (j.kind === 'scenarios'
        ? 'Stop it now; pages already written are kept'
        : 'Stop it now; nothing is changed') +
      '">Cancel</button></section>'
    );
  }
  const ok = j.status === 'done';
  const needsTests =
    ok && (j.kind === 'scenarios' || j.kind === 'critical') && /needs? a new test/.test(j.message ?? '');
  const text =
    j.status === 'cancelled'
      ? j.label + ': ' + (j.message ?? '')
      : ok
        ? (j.message ?? '')
        : 'Could not finish: ' + (j.message ?? '');
  return (
    '<section class="' +
    box +
    (ok ? ' border-pass-line bg-pass-soft' : j.status === 'failed' ? ' border-fail-line bg-fail-soft' : '') +
    '" role="status">' +
    '<p class="m-0 min-w-0 flex-1 font-semibold ' +
    (ok ? 'text-pass-ink' : j.status === 'failed' ? 'text-fail-ink' : 'text-ink-2') +
    '">' +
    esc(text) +
    '</p>' +
    (ok && j.kind === 'plan' && j.file
      ? '<button type="button" class="btn" ' + act('view-plan') + '>View fix plan</button>'
      : '') +
    (needsTests
      ? '<a class="btn" href="' +
        routeHash('scenarios') +
        '" ' +
        act('set-only', { only: 'todo' }) +
        '>Show scenarios that need a test</a>'
      : '') +
    '<button type="button" class="btn btn-text" ' +
    act('dismiss-job') +
    '>Dismiss</button></section>'
  );
}

export function renderShell(): void {
  const { data } = state;
  $('#project').textContent = data.project.name;
  $('#project-mark').textContent = initials(data.project.name);
  const url = $('#url');
  url.textContent = shortUrl(data.project.baseUrl);
  url.title = data.project.baseUrl;
  $('#nav').innerHTML = nav(defectsOf(data).length);
  $('#run-card').innerHTML = runCard();
  $('#topbar').innerHTML = topbar();
  const title = {
    overview: 'Overview',
    defects: 'Defects',
    scenarios: 'Scenarios',
    project: 'Project',
    tracker: 'Bug tracker',
    storage: 'Storage',
  }[state.route.page];
  document.title = title + ' | ' + data.project.name + ' | AI QA Agent';
}

/** The Overview page: the report of the selected run, or how to get the first one. */
import { act } from './dom.js';
import {
  defectFor,
  defectsOf,
  esc,
  label,
  listModel,
  pageResults,
  plural,
  routeHash,
  statusOf,
  type Defect,
} from './logic.js';
import { planButtons } from './shell.js';
import { state } from './state.js';
import { longTable } from './table.js';
import { addButton, emptyBox, pageHeading as h1, severityChip, statusText } from './ui.js';

const panelHead = (id: string, title: string, text: string, linkHtml = ''): string =>
  '<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-6 pb-4 pt-5"><div class="flex flex-col gap-0.5"><h2 id="' +
  id +
  '" class="m-0 text-[17px] font-bold">' +
  title +
  '</h2><span class="text-muted">' +
  text +
  '</span></div>' +
  linkHtml +
  '</div>';

const command = (cmd: string): string =>
  '<div class="flex flex-wrap items-center gap-2"><code class="rounded-lg border border-line bg-subtle px-3 py-2.5 text-sm">' +
  esc(cmd) +
  '</code><button type="button" class="btn" ' +
  act('copy', { text: cmd }) +
  '>Copy</button></div>';

/** Before anything exists: what a first run does and how to start it. */
function firstVisit(): string {
  const step = (n: number, title: string, text: string) =>
    '<li class="flex gap-4 border-t border-divider py-4"><span aria-hidden="true" class="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft font-bold text-accent">' +
    n +
    '</span><div class="flex min-w-0 flex-col gap-0.5"><span class="font-semibold">' +
    title +
    '</span><span class="text-muted">' +
    text +
    '</span></div></li>';
  return (
    h1(
      'Test this app for the first time',
      'One run takes the app from source code to a report of what works and what does not. Nothing is sent to your bug tracker until you approve it.',
    ) +
    '<section aria-labelledby="steps-h" class="panel flex max-w-[760px] flex-col gap-5 p-7">' +
    '<h2 id="steps-h" class="m-0 text-[17px] font-bold">What the first run does</h2>' +
    '<ol class="m-0 flex list-none flex-col p-0">' +
    step(1, 'Reads the app', 'Finds the pages in your code and the journeys people take through them.') +
    step(
      2,
      'Writes scenarios',
      'Lists what should be tested on each page. You can edit, add or remove scenarios at any time.',
    ) +
    step(3, 'Creates the tests', 'Turns every scenario into an automated browser test.') +
    step(
      4,
      'Runs them and reports',
      'Runs the tests, then groups the failures into defects with screenshots and video.',
    ) +
    '</ol>' +
    '<div class="flex flex-col gap-3 border-t border-divider pt-5"><p class="m-0 font-semibold">Start it in a terminal, in the project folder:</p>' +
    command('npx ai-qa-agent run') +
    '<p class="m-0 text-muted">When it is done, select Refresh at the top of this page.</p>' +
    '<p class="m-0 flex flex-wrap items-center gap-3 text-muted">Or go step by step from here: <a class="btn" href="' +
    routeHash('project') +
    '">Open the Project page</a></p>' +
    (state.data.authoring.pages.length
      ? '<p class="m-0 flex flex-wrap items-center gap-3 text-muted">Or write a scenario yourself: ' +
        addButton() +
        '</p>'
      : '') +
    '</div></section>'
  );
}

/** Scenarios exist but nothing has run yet. */
function noRun(): string {
  const { data } = state;
  const withTest = data.scenarios.filter((sc) => sc.approved && data.testStates[sc.id] !== 'missing').length;
  return (
    h1('Overview', plural(data.scenarios.length, 'scenario') + ' are ready. No test has run yet.') +
    '<section class="panel flex max-w-[760px] flex-col items-start gap-4 p-7"><h2 class="m-0 text-[17px] font-bold">Run the tests</h2>' +
    (withTest
      ? '<p class="m-0 text-muted">' +
        plural(withTest, 'scenario has', 'scenarios have') +
        ' a test. The results appear on this page when the run is done.</p>' +
        '<button type="button" class="btn btn-primary"' +
        (data.job?.status === 'running' ? ' disabled' : '') +
        ' ' +
        act('start-job', { url: '/api/runs/all' }) +
        '>Run all tests</button>'
      : '<p class="m-0 text-muted">The scenarios have no tests yet. Create them in a terminal, in the project folder:</p>' +
        command('npx ai-qa-agent generate')) +
    '<a class="link" href="' +
    routeHash('scenarios') +
    '">Open the scenarios</a></section>'
  );
}

function results(notRun: number): string {
  const { data } = state;
  const run = data.run!;
  const s = run.stats;
  const ran = s.passed + s.failed + s.flaky;
  const seg = (n: number, cls: string) =>
    n ? '<span class="h-full rounded-sm ' + cls + '" style="flex:' + n + ' 1 0"></span>' : '';
  const count = (status: 'passed' | 'failed' | 'flaky' | 'none', n: number) =>
    '<div class="flex flex-col gap-0.5"><span class="flex items-center gap-2 text-muted"><span class="mark mark-' +
    status +
    ' size-3" aria-hidden="true"></span>' +
    { passed: 'Passed', failed: 'Failed', flaky: 'Flaky', none: 'Not run' }[status] +
    '</span><span class="font-display text-[32px] font-bold leading-tight ' +
    (status === 'failed' && n ? 'text-fail-ink' : '') +
    '">' +
    n +
    '</span></div>';
  const target = run.app
    ? 'on a ' +
      (run.app.mode === 'production' ? 'production build' : 'development server') +
      ' at <span class="font-mono text-[13px]">' +
      esc(run.app.url) +
      '</span>'
    : 'against <span class="font-mono text-[13px]">' + esc(data.project.baseUrl) + '</span>';
  return (
    '<section aria-labelledby="results-h" class="panel flex flex-col gap-5 p-6">' +
    '<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><h2 id="results-h" class="m-0 text-[17px] font-bold">Test results</h2>' +
    '<span class="text-muted">' +
    plural(ran, 'test') +
    ', ' +
    target +
    '</span></div>' +
    '<div class="flex h-4 gap-[3px] overflow-hidden rounded-full bg-neutral-soft" role="img" aria-label="' +
    s.passed +
    ' passed, ' +
    s.failed +
    ' failed, ' +
    s.flaky +
    ' flaky">' +
    seg(s.passed, 'bg-pass') +
    seg(s.flaky, 'bg-flaky') +
    seg(s.failed, 'bg-fail') +
    '</div>' +
    '<div class="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-x-6 gap-y-4">' +
    count('passed', s.passed) +
    count('failed', s.failed) +
    count('flaky', s.flaky) +
    count('none', notRun) +
    '</div></section>'
  );
}

function defectList(defects: Defect[]): string {
  const shown = defects.slice(0, 6);
  return (
    '<section aria-labelledby="defects-h" class="panel overflow-hidden">' +
    panelHead(
      'defects-h',
      'Defects to review',
      'Failed tests grouped by cause, most severe first.',
      '<a class="link" href="' +
        routeHash('defects') +
        '">Open all ' +
        (defects.length > shown.length ? defects.length + ' ' : '') +
        'defects</a>',
    ) +
    '<ul class="m-0 list-none p-0">' +
    shown
      .map(
        (d) =>
          '<li class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-divider px-6 py-2">' +
          '<span class="w-[104px] shrink-0">' +
          severityChip(d) +
          '</span>' +
          '<span class="min-w-0 flex-[999_1_260px] font-semibold">' +
          esc(d.title) +
          '</span>' +
          '<span class="w-[150px] shrink-0 text-muted">' +
          esc(d.kind) +
          '</span>' +
          '<span class="w-[64px] shrink-0 text-muted">' +
          plural(d.scenarioIds.length, 'test') +
          '</span>' +
          '<a class="link" href="' +
          routeHash('defects', d.id) +
          '" aria-label="Review: ' +
          esc(d.title) +
          '">Review</a></li>',
      )
      .join('') +
    '</ul></section>'
  );
}

function pagesPanel(): string {
  const t = longTable(pageResults(state.data), {
    id: 'results',
    noun: ['page', 'pages'],
    placeholder: 'Find a page by route or name',
    attentionLabel: 'With failures',
    text: (p) => p.route + ' ' + (p.name ?? ''),
    needsAttention: (p) => p.failed > 0,
  });
  return (
    '<section aria-labelledby="pages-h" class="panel overflow-hidden">' +
    panelHead(
      'pages-h',
      'Results by page',
      state.data.model ? 'Pages found in the code, most important first.' : 'Pages that have scenarios.',
      '<a class="link" href="' +
        routeHash('scenarios') +
        '" ' +
        act('view-page', { page: '' }) +
        '>Open all scenarios</a>',
    ) +
    t.tools +
    '<ul class="m-0 list-none p-0">' +
    t.rows
      .map((p) => {
        const ran = p.passed + p.failed;
        return (
          '<li class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-divider px-6 py-2">' +
          '<span class="flex min-w-0 flex-[999_1_200px] flex-col"><span class="font-mono text-sm font-medium break-all">' +
          esc(p.route) +
          '</span>' +
          (p.name ? '<span class="text-[13px] text-muted">' + esc(p.name) + '</span>' : '') +
          '</span>' +
          '<span class="w-[96px] shrink-0 text-muted">' +
          (p.importance ? label(p.importance) : '') +
          '</span>' +
          '<span aria-hidden="true" class="flex h-2.5 w-[140px] shrink-0 gap-0.5 overflow-hidden rounded-full bg-neutral-soft">' +
          (p.passed ? '<span class="h-full bg-pass" style="flex:' + p.passed + ' 1 0"></span>' : '') +
          (p.failed ? '<span class="h-full bg-fail" style="flex:' + p.failed + ' 1 0"></span>' : '') +
          '</span>' +
          '<span class="w-[190px] shrink-0">' +
          (ran
            ? p.passed + ' passed, ' + p.failed + ' failed' + (p.notRun ? ', ' + p.notRun + ' not run' : '')
            : '<span class="text-muted">Not in this run</span>') +
          '</span>' +
          '<a class="link" href="' +
          routeHash('scenarios') +
          '" ' +
          act('view-page', { page: p.route }) +
          ' aria-label="View the scenarios of ' +
          esc(p.route) +
          '">View</a></li>'
        );
      })
      .join('') +
    '</ul>' +
    t.empty +
    t.pager +
    '</section>'
  );
}

function criticalPanel(defects: Defect[]): string {
  const { data } = state;
  const flows = data.scenarios.filter((sc) => sc.critical);
  const body = flows.length
    ? '<ul class="m-0 flex list-none flex-col p-0">' +
      flows
        .map((sc) => {
          const status = statusOf(data, sc.id);
          const why = status === 'failed' || status === 'flaky' ? defectFor(defects, sc.id) : undefined;
          return (
            '<li class="flex flex-col gap-1 border-t border-divider py-3"><span class="text-[13px]">' +
            statusText(status) +
            '</span><a class="font-semibold text-ink underline-offset-2 hover:underline" href="' +
            routeHash('scenarios', sc.id) +
            '">' +
            esc(sc.title) +
            '</a>' +
            (why ? '<span class="text-sm text-muted">' + esc(why.title) + '</span>' : '') +
            '</li>'
          );
        })
        .join('') +
      '</ul>'
    : '<div class="flex flex-col items-start gap-3 border-t border-divider pt-3"><p class="m-0 text-muted">No critical flow has been chosen yet. The AI picks them from the main journeys of the application.</p>' +
      '<a class="btn" href="' +
      routeHash('project') +
      '">Choose critical flows</a></div>';
  return (
    '<section aria-labelledby="flows-h" class="panel flex flex-col gap-3.5 px-6 py-5">' +
    '<div class="flex flex-col gap-0.5"><h2 id="flows-h" class="m-0 text-[17px] font-bold">Critical flows</h2><span class="text-muted">The journeys this app cannot do without.</span></div>' +
    body +
    '</section>'
  );
}

function nextPanel(defects: Defect[], failed: number, todo: number): string {
  const { data } = state;
  const busy = data.job?.status === 'running';
  const steps: string[] = [];
  if (defects.length)
    steps.push(
      '<span>Review the ' +
        plural(defects.length, 'defect') +
        (data.tracker.configured ? ' and log the real ones in ' + esc(data.tracker.name) + '.' : '.') +
        '</span><a class="btn btn-primary self-start" href="' +
        routeHash('defects') +
        '">Review defects</a>',
    );
  if (data.plan?.failures)
    steps.push(
      '<span>' +
        (data.plan.exists
          ? 'A fix plan for the developers is in <code class="break-all">' + esc(data.plan.file) + '</code>.'
          : 'Create a fix plan for the developers.') +
        '</span><div class="flex flex-wrap gap-2">' +
        planButtons() +
        '</div>',
    );
  if (failed)
    steps.push(
      '<span>After the fixes, run the ' +
        plural(failed, 'failed test') +
        ' again.</span><button type="button" class="btn self-start"' +
        (busy ? ' disabled' : '') +
        ' ' +
        act('start-job', { url: '/api/runs/failed' }) +
        '>Run failed tests</button>',
    );
  if (todo)
    steps.push(
      '<span>' +
        plural(todo, 'scenario needs', 'scenarios need') +
        ' a new test.</span><a class="btn self-start" href="' +
        routeHash('scenarios') +
        '" ' +
        act('set-only', { only: 'todo' }) +
        '>Open them</a>',
    );
  return (
    '<section aria-labelledby="next-h" class="panel flex flex-col gap-3.5 px-6 py-5"><h2 id="next-h" class="m-0 text-[17px] font-bold">What to do next</h2>' +
    (steps.length
      ? '<ol class="m-0 flex list-none flex-col gap-4 p-0">' +
        steps
          .map(
            (html, i) =>
              '<li class="flex gap-2"><span class="w-5 shrink-0 font-bold" aria-hidden="true">' +
              (i + 1) +
              '.</span><div class="flex min-w-0 flex-col gap-2">' +
              html +
              '</div></li>',
          )
          .join('') +
        '</ol>'
      : '<p class="m-0 text-muted">Nothing. Every test in this run passed.</p>') +
    '</section>'
  );
}

export function overviewPage(banner: string): string {
  const { data } = state;
  if (!data.scenarios.length) return banner + firstVisit();
  if (!data.run) return banner + noRun();
  const m = listModel(data, { page: '', only: 'all', type: '', q: '' });
  const defects = defectsOf(data);
  const s = data.run.stats;
  const ran = s.passed + s.failed + s.flaky;
  const failed = s.failed + s.flaky;
  const sentence = !ran
    ? 'No test ran in this run.'
    : failed
      ? failed +
        ' of ' +
        plural(ran, 'test') +
        ' failed in this run. ' +
        plural(defects.length, 'defect is', 'defects are') +
        ' waiting for a decision.'
      : 'All ' + plural(ran, 'test') + ' passed in this run.';
  return (
    h1('Overview', sentence) +
    banner +
    '<div class="flex flex-col gap-6">' +
    results(m.notRun) +
    '<div class="flex flex-wrap items-start gap-6">' +
    '<div class="flex min-w-0 flex-[999_1_560px] flex-col gap-6">' +
    (defects.length ? defectList(defects) : emptyBox('No defects. Nothing failed in this run.')) +
    pagesPanel() +
    '</div>' +
    '<div class="flex min-w-0 flex-[1_1_320px] flex-col gap-6">' +
    criticalPanel(defects) +
    nextPanel(defects, m.failed, m.todo) +
    '</div></div></div>'
  );
}

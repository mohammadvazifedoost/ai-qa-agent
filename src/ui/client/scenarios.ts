/** The Scenarios page: every test case in one list, and the selected one's steps, result and evidence. */
import { act, sideBySide } from './dom.js';
import {
  defectFor,
  defectsOf,
  esc,
  failedStepText,
  failureFor,
  isFailing,
  label,
  listModel,
  mediaDeleteLabel,
  outcomesFor,
  paginate,
  routeHash,
  statusOf,
  type MediaWhat,
  type Outcome,
  type ScenarioView,
  type View,
} from './logic.js';
import { state } from './state.js';
import {
  addButton,
  emptyBox,
  evidence,
  pageHeading,
  pageName,
  scenarioChips,
  statusPill,
  statusText,
  trackerAction,
} from './ui.js';

export const PER_PAGE = 25;

const TAB_LABEL: Record<View['only'], string> = {
  all: 'All',
  failed: 'Failed',
  passed: 'Passed',
  notrun: 'Not run',
  todo: 'Needs a test',
};

const options = (list: ReadonlyArray<readonly [string, string]>, selected: string): string =>
  list
    .map(
      ([value, text]) =>
        '<option value="' +
        esc(value) +
        '"' +
        (value === selected ? ' selected' : '') +
        '>' +
        esc(text) +
        '</option>',
    )
    .join('');

function toolbar(m: ReturnType<typeof listModel>): string {
  const { view, data } = state;
  const tabs: View['only'][] = [
    'all',
    'failed',
    'passed',
    ...(data.run ? (['notrun'] as const) : []),
    ...(m.todo ? (['todo'] as const) : []),
  ];
  return (
    '<div class="flex flex-col gap-3 px-6 py-4"><div class="flex flex-wrap gap-2.5">' +
    '<input id="search" type="search" class="field min-w-0 flex-[999_1_220px]" placeholder="Search by name or ID" aria-label="Search scenarios" value="' +
    esc(view.q) +
    '" data-filter="q">' +
    '<select id="flt-page" class="field flex-[1_1_150px]" aria-label="Page" data-filter="page">' +
    options([['', 'All pages'], ...m.pages.map((p) => [p, pageName(p)] as const)], view.page) +
    '</select>' +
    '<select id="flt-type" class="field flex-[1_1_150px]" aria-label="Type" data-filter="type">' +
    options([['', 'All types'], ...m.types.map((t) => [t, label(t)] as const)], view.type) +
    '</select></div>' +
    '<div role="group" aria-label="Result" class="flex flex-wrap gap-2">' +
    tabs
      .map(
        (k) =>
          '<button type="button" id="tab-' +
          k +
          '" class="tab" aria-pressed="' +
          (m.only === k) +
          '" ' +
          act('set-only', { only: k }) +
          '>' +
          TAB_LABEL[k] +
          '<span class="font-medium">' +
          m.counts[k] +
          '</span></button>',
      )
      .join('') +
    '</div>' +
    runNotRun(m) +
    '</div>'
  );
}

/** On the Not run tab: run every listed scenario that has a test, and add the results to this run. */
function runNotRun(m: ReturnType<typeof listModel>): string {
  const { data } = state;
  if (m.only !== 'notrun') return '';
  const ids = m.rows
    .filter((x) => x.sc.approved && data.testStates[x.sc.id] !== 'missing')
    .map((x) => x.sc.id);
  const skipped = m.rows.length - ids.length;
  return (
    '<div class="flex flex-wrap items-center gap-x-3 gap-y-2">' +
    (ids.length
      ? '<button type="button" id="run-not-run" class="btn btn-primary"' +
        (data.job?.status === 'running' ? ' disabled' : '') +
        ' ' +
        act('start-job', { url: '/api/runs/not-run', extra: JSON.stringify({ ids }) }) +
        ' title="Adds their results to this run">' +
        (ids.length === 1 ? 'Run this test' : 'Run these ' + ids.length + ' tests') +
        '</button>'
      : '') +
    (skipped
      ? '<span class="text-[13px] text-muted">' +
        (skipped === 1
          ? '1 scenario cannot run: it has no test or is not approved.'
          : skipped + ' scenarios cannot run: they have no test or are not approved.') +
        '</span>'
      : '') +
    '</div>'
  );
}

/**
 * The columns of the header and of every row. They follow the width of the list, not of the
 * window: a narrow list shows the result and the name, a wider one adds the ID, then type and priority.
 */
const GRID =
  'grid grid-cols-[92px_minmax(0,1fr)] items-center gap-x-4 px-6 @lg:grid-cols-[92px_124px_minmax(0,1fr)] @3xl:grid-cols-[92px_124px_minmax(0,1fr)_104px_64px]';

function row(sc: ScenarioView, shown: string): string {
  const status = statusOf(state.data, sc.id);
  return (
    '<li class="border-t border-divider"><a id="row-' +
    esc(sc.id) +
    '" class="row-link" href="' +
    routeHash('scenarios', sc.id) +
    '"' +
    (sc.id === shown ? ' aria-current="true"' : '') +
    '><span class="' +
    GRID +
    ' min-h-[60px] py-2.5">' +
    '<span>' +
    statusText(status) +
    '</span>' +
    '<span class="hidden font-mono text-[13px] @lg:block">' +
    esc(sc.id) +
    '</span>' +
    '<span class="flex min-w-0 flex-col gap-0.5"><span class="font-medium break-words">' +
    esc(sc.title) +
    '</span><span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">' +
    '<span class="font-mono @lg:hidden">' +
    esc(sc.id) +
    '</span><span>' +
    esc(pageName(sc.page)) +
    '</span><span class="@3xl:hidden">' +
    label(sc.category) +
    '</span><span class="@3xl:hidden">' +
    label(sc.priority) +
    ' priority</span>' +
    scenarioChips(sc) +
    '</span></span>' +
    '<span class="hidden text-muted @3xl:block">' +
    label(sc.category) +
    '</span>' +
    '<span class="hidden text-muted @3xl:block">' +
    label(sc.priority) +
    '</span></span></a></li>'
  );
}

function list(m: ReturnType<typeof listModel>, shown: string): string {
  const page = paginate(m.rows, state.pageNo, PER_PAGE);
  state.pageNo = page.page;
  const head = (text: string, cls = '') => '<span class="' + cls + '">' + text + '</span>';
  return (
    '<section aria-label="Scenario list" class="split-list panel @container min-w-0 flex-1 overflow-hidden">' +
    toolbar(m) +
    '<div aria-hidden="true" class="' +
    GRID +
    ' border-t border-divider bg-subtle py-2 text-[13px] font-semibold text-muted">' +
    head('Result') +
    head('ID', 'hidden @lg:block') +
    head('Scenario') +
    head('Type', 'hidden @3xl:block') +
    head('Priority', 'hidden @3xl:block') +
    '</div>' +
    (page.total
      ? '<ul class="m-0 list-none p-0">' + page.items.map((x) => row(x.sc, shown)).join('') + '</ul>'
      : '<div class="flex flex-col items-start gap-3 border-t border-divider px-6 py-8"><span class="font-semibold">No scenarios match these filters.</span>' +
        '<button type="button" class="btn" ' +
        act('clear-filters') +
        '>Clear filters</button></div>') +
    '<div class="flex flex-wrap items-center justify-between gap-2.5 border-t border-divider px-6 py-3"><span class="text-muted" role="status">' +
    (page.total ? page.from + ' to ' + page.to + ' of ' + page.total : '0 scenarios') +
    '</span><div class="flex gap-2">' +
    '<button type="button" id="page-prev" class="btn"' +
    (page.page === 0 ? ' disabled' : '') +
    ' ' +
    act('page', { to: String(page.page - 1) }) +
    '>Previous</button>' +
    '<button type="button" id="page-next" class="btn"' +
    (page.page >= page.pages - 1 ? ' disabled' : '') +
    ' ' +
    act('page', { to: String(page.page + 1) }) +
    '>Next</button></div></div></section>'
  );
}

/* ---------- the selected scenario ---------- */
const section = (title: string, body: string): string =>
  '<div class="flex flex-col gap-2"><h3 class="h-section">' + title + '</h3>' + body + '</div>';

/** Stable id from the result key (e.g. `A-001@chromium-desktop` → `a-001-chromium-desktop`), never a list index. */
const mediaSlug = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export interface MediaTarget {
  /** The scenario whose detail is shown. */
  id: string;
  /** The result (outcome key) the media belongs to. */
  key: string;
  what: MediaWhat;
  /** Project-relative path of the file; empty for `all`. */
  file: string;
  /** For a video: the 1-based page it belongs to (a test can open several pages). */
  page?: number;
}

/** A media target as `data-*` attributes for `act()` (see mediaTarget in main.ts). */
export const mediaArgs = (t: MediaTarget): Record<string, string> => ({
  id: t.id,
  key: t.key,
  what: t.what,
  file: t.file,
  ...(t.page ? { page: String(t.page) } : {}),
});

export function mediaButton(t: MediaTarget): string {
  return (
    '<button type="button" class="btn btn-text btn-text-danger" data-testid="media-delete-' +
    t.what +
    '" aria-label="' +
    esc(mediaDeleteLabel(t.what, t.key, t.page)) +
    '" ' +
    act('ask-media-delete', mediaArgs(t)) +
    '>' +
    (t.what === 'all' ? 'Delete all media' : 'Delete ' + t.what) +
    '</button>'
  );
}

const mediaArea = (t: MediaTarget): string =>
  '<div id="media-del-' +
  mediaSlug(t.key) +
  '-' +
  t.what +
  (t.page && t.page > 1 ? '-' + t.page : '') +
  '" class="mt-1 flex flex-wrap items-center gap-2">' +
  mediaButton(t) +
  '</div>';

/** What happened to one result of the scenario (one per browser project it ran in). */
function resultBlock(sc: ScenarioView, o: Outcome, many: boolean): string {
  const { data } = state;
  const f = failureFor(data, o.key);
  const defect = defectsOf(data).find((d) => d.keys.includes(o.key));
  let html = many ? '<h3 class="h-section">' + esc(o.project) + '</h3>' : '';
  if (o.rerunAt)
    html +=
      '<p class="m-0 text-[13px] text-muted">Run on its own at ' +
      esc(new Date(o.rerunAt).toLocaleString()) +
      (o.status === 'passed' ? '' : '. The AI has not analyzed this result yet') +
      '.</p>';
  if (o.status === 'passed') {
    html +=
      '<div class="flex items-center gap-2.5 rounded-[10px] border border-pass-line bg-pass-soft px-4 py-3.5 font-semibold text-pass-ink"><span class="mark mark-passed size-3" aria-hidden="true"></span>Passed' +
      (o.attempts > 1 ? ' after ' + o.attempts + ' attempts' : '') +
      '</div>';
  } else if (o.status !== 'skipped') {
    const step = failedStepText(o);
    html +=
      '<div class="flex flex-col gap-1.5 rounded-[10px] border border-fail-line bg-fail-soft px-4 py-3.5">' +
      '<span class="text-[13px] font-bold text-fail-ink">Why it failed</span>' +
      (step ? '<span class="text-ink-2">Stopped at ' + esc(step) + '</span>' : '') +
      (defect
        ? '<span class="font-semibold">' +
          esc(defect.title) +
          '</span><span class="text-ink-2">' +
          esc(defect.analysis ? defect.analysis.category : defect.kind) +
          (defect.confidence !== null ? ', confidence ' + Math.round(defect.confidence * 100) + '%' : '') +
          '</span>' +
          (defect.analysis?.fix.summary
            ? '<span class="text-ink-2">Fix: ' + esc(defect.analysis.fix.summary) + '</span>'
            : '') +
          (defect.actual ? '<span class="text-ink-2">' + esc(defect.actual) + '</span>' : '') +
          '<a class="link self-start" href="' +
          routeHash('defects', defect.id) +
          '">Open the defect</a>'
        : '<span class="font-semibold">' +
          esc(f?.summary ?? 'Not analyzed yet.') +
          '</span>' +
          (f
            ? ''
            : '<span class="text-ink-2">Run <code>npx ai-qa-agent triage</code> to find the cause.</span>')) +
      '</div>';
  }
  if (o.error)
    html +=
      '<details class="disclosure"><summary>Test error</summary><pre class="m-0 mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-subtle p-3 font-mono text-xs">' +
      esc(o.error.message) +
      '</pre></details>';
  const media = evidence(o, (what, file = '', page) =>
    mediaArea({ id: sc.id, key: o.key, what, file, page }),
  );
  if (media) html += section('Evidence', media);
  return html;
}

/** Create, rewrite and run this scenario's test. */
function testArea(sc: ScenarioView): string {
  if (!sc.approved) return '';
  const t = state.data.testStates[sc.id];
  const ran = statusOf(state.data, sc.id) !== 'none';
  const hint =
    t === 'missing'
      ? 'This scenario has no test yet.'
      : t === 'outdated'
        ? 'The scenario changed after its test was written.'
        : '';
  const run =
    t === 'missing'
      ? ''
      : '<button type="button" id="run-btn" class="btn ' +
        (t ? '' : 'btn-primary') +
        '" ' +
        act('run-test', { id: sc.id }) +
        ' title="Run only this test and update its result in this run">' +
        (ran ? 'Run this test again' : 'Run this test') +
        '</button>';
  const write =
    '<button type="button" id="test-btn" class="btn ' +
    (t ? 'btn-primary' : '') +
    '" ' +
    act('write-test', { id: sc.id }) +
    ' title="The AI writes only this scenario&#39;s test; the other tests in the file are not changed">' +
    (t === 'missing' ? 'Create test' : 'Rewrite test') +
    '</button>';
  return (
    '<div class="flex flex-col gap-2"><div class="flex flex-wrap gap-2">' +
    (t ? write + run : run + write) +
    '</div><p id="test-status" class="m-0 text-[13px] text-muted" aria-live="polite">' +
    hint +
    '</p></div>'
  );
}

export function deleteArea(id: string): string {
  return (
    '<div id="del-area" class="flex flex-wrap items-center gap-2">' +
    '<button type="button" class="btn" ' +
    act('open-editor', { id }) +
    '>Edit</button>' +
    '<button type="button" class="btn btn-text btn-text-danger" ' +
    act('ask-delete', { id }) +
    '>Remove</button></div>'
  );
}

function detail(sc: ScenarioView): string {
  const { data } = state;
  const status = statusOf(data, sc.id);
  const outs = outcomesFor(data, sc.id);
  const notice = state.notice?.id === sc.id ? state.notice.text : '';
  const meta = (name: string, value: string) =>
    '<div class="flex flex-col"><dt class="text-[13px] text-muted">' +
    name +
    '</dt><dd class="m-0 font-semibold break-words">' +
    value +
    '</dd></div>';
  const defect = isFailing(status) ? defectFor(defectsOf(data), sc.id) : undefined;
  const failing = outs.filter((o) => o.status === 'failed' || o.status === 'flaky').map((o) => o.key);
  const tracker = defect
    ? trackerAction(defect.keys, defect.body)
    : failing.length
      ? trackerAction(failing, { failureKey: failing[0]! })
      : '';
  return (
    '<div class="flex flex-col gap-2.5"><div class="flex flex-wrap items-center gap-2">' +
    '<span class="font-mono text-[13px] text-muted">' +
    esc(sc.id) +
    '</span>' +
    statusPill(status) +
    scenarioChips(sc) +
    '</div><h2 id="detail-title" tabindex="-1" class="m-0 text-[19px] font-bold leading-snug outline-none">' +
    esc(sc.title) +
    '</h2></div>' +
    (notice
      ? '<p class="m-0 rounded-[10px] bg-accent-soft px-4 py-3 font-semibold text-accent" role="status">' +
        esc(notice) +
        '</p>'
      : '') +
    '<dl class="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(130px,100%),1fr))] gap-x-4 gap-y-3">' +
    meta('Page', esc(pageName(sc.page))) +
    meta('Type', label(sc.category)) +
    meta('Priority', label(sc.priority)) +
    meta('Screen size', label(sc.viewport)) +
    '</dl>' +
    (data.run && !outs.length
      ? '<p class="m-0 rounded-[10px] border border-line bg-subtle px-4 py-3.5 text-ink-2">This scenario was not part of the selected run.</p>'
      : '') +
    outs.map((o) => resultBlock(sc, o, outs.length > 1)).join('') +
    (sc.preconditions.length
      ? section(
          'Before you start',
          '<ul class="m-0 flex list-disc flex-col gap-1.5 pl-5 text-ink-2">' +
            sc.preconditions.map((x) => '<li>' + esc(x) + '</li>').join('') +
            '</ul>',
        )
      : '') +
    section(
      'Steps',
      '<ol class="m-0 flex list-none flex-col p-0">' +
        sc.steps
          .map(
            (x, i) =>
              '<li class="flex gap-2.5 border-t border-divider py-2"><span class="w-6 shrink-0 font-semibold text-muted">' +
              (i + 1) +
              '.</span><span class="min-w-0 break-words">' +
              esc(x) +
              '</span></li>',
          )
          .join('') +
        '</ol>',
    ) +
    section(
      'Expected results',
      '<ul class="m-0 flex list-disc flex-col gap-1.5 pl-5 text-ink-2">' +
        sc.expectedResults.map((x) => '<li class="break-words">' + esc(x) + '</li>').join('') +
        '</ul>',
    ) +
    '<div class="flex flex-col gap-4 border-t border-divider pt-4">' +
    testArea(sc) +
    (tracker
      ? '<div class="flex flex-wrap items-center gap-x-3 gap-y-2">' +
        tracker +
        (defect?.confirmed
          ? ''
          : '<span class="basis-full text-[13px] text-muted">The analyzer did not confirm this as a product bug, so the ' +
            data.tracker.noun +
            ' is labelled needs-verification.</span>') +
        '</div>'
      : '') +
    deleteArea(sc.id) +
    '</div>'
  );
}

/** The scenario the detail panel shows: the open one, else the first of the list when both fit. */
export function shownScenario(): string {
  const { data, route } = state;
  if (route.page !== 'scenarios') return '';
  if (route.id && data.scenarios.some((s) => s.id === route.id)) return route.id;
  if (!sideBySide.matches) return '';
  const m = listModel(data, state.view);
  return paginate(m.rows, state.pageNo, PER_PAGE).items[0]?.sc.id ?? '';
}

export function scenariosPage(banner: string): string {
  const { data, route } = state;
  const heading = pageHeading(
    'Scenarios',
    'Every test case for this app. Select one to see its steps and its last result.',
  );
  if (!data.scenarios.length) {
    return (
      heading +
      banner +
      emptyBox(
        'No scenarios yet. Run <code>npx ai-qa-agent scenarios</code> in the project folder, or write your own.' +
          (data.authoring.pages.length
            ? '<p class="mb-0 mt-4">' + addButton('btn btn-primary') + '</p>'
            : ''),
      )
    );
  }
  const m = listModel(data, state.view);
  state.view.only = m.only;
  const shown = shownScenario();
  const sc = data.scenarios.find((s) => s.id === shown);
  const open = !!route.id && !!sc;
  return (
    heading +
    banner +
    '<div class="split flex items-start gap-6" data-detail="' +
    (open ? 'open' : 'closed') +
    '">' +
    list(m, shown) +
    '<section id="detail" aria-label="Selected scenario" class="split-detail panel flex min-w-0 flex-col gap-5 p-6 max-xl:flex-1 xl:sticky xl:top-[84px] xl:max-h-[calc(100vh-100px)] xl:w-[380px] xl:shrink-0 xl:overflow-auto">' +
    '<a class="link self-start xl:hidden" href="' +
    routeHash('scenarios') +
    '">Back to all scenarios</a>' +
    (sc
      ? detail(sc)
      : '<p class="m-0 text-muted">Select a scenario to see its steps and its last result.</p>') +
    '</section></div>'
  );
}

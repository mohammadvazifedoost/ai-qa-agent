/** The Defects page: failed tests grouped by cause, with what to decide about each. */
import { act, sideBySide } from './dom.js';
import { defectsOf, esc, plural, routeHash, type Defect } from './logic.js';
import { planButtons } from './shell.js';
import { state } from './state.js';
import { emptyBox, evidence, pageHeading, scenarioLink, severityChip, trackerAction } from './ui.js';

const section = (title: string, body: string): string =>
  '<div class="flex flex-col gap-2"><h3 class="h-section">' + title + '</h3>' + body + '</div>';

/** Whether a tracker item exists for the defect, from the tracker check of the selected run. */
function logged(d: Defect): string {
  const run = state.data.run;
  if (!run || run.tasksPending) return '';
  const task = d.keys.map((k) => run.tasks[k]).find((t) => t?.exists);
  return task ? 'Logged as ' + task.taskId : '';
}

function listItem(d: Defect, shown: string): string {
  const state_ = logged(d);
  return (
    '<li class="border-t border-divider"><a id="defect-' +
    esc(d.id) +
    '" class="row-link" href="' +
    routeHash('defects', d.id) +
    '"' +
    (d.id === shown ? ' aria-current="true"' : '') +
    '><span class="flex flex-col items-start gap-1.5 px-5 py-3.5">' +
    '<span class="flex flex-wrap items-center gap-2">' +
    severityChip(d) +
    '<span class="text-[13px] font-semibold ' +
    (state_ ? 'text-pass-ink' : 'text-muted') +
    '">' +
    esc(state_ || 'To review') +
    '</span></span>' +
    '<span class="font-semibold">' +
    esc(d.title) +
    '</span><span class="text-sm text-muted">' +
    esc(d.kind) +
    ', ' +
    plural(d.scenarioIds.length, 'failed test') +
    '</span></span></a></li>'
  );
}

function detail(d: Defect): string {
  const { data } = state;
  const run = data.run!;
  const box = (title: string, text: string, cls: string, ink: string) =>
    '<div class="flex flex-col gap-1 rounded-[10px] border px-4 py-3.5 ' +
    cls +
    '"><span class="text-[13px] font-bold ' +
    ink +
    '">' +
    title +
    '</span><span class="break-words">' +
    esc(text) +
    '</span></div>';
  const tests = d.keys
    .map((k) => run.outcomes.find((o) => o.key === k))
    .filter((o) => !!o)
    .map((o) => {
      const sc = data.scenarios.find((s) => s.id === o.scenarioId);
      return (
        '<li class="flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5 border-t border-divider py-2">' +
        '<span class="w-[124px] shrink-0 font-mono text-[13px]">' +
        esc(o.scenarioId ?? '') +
        '</span><span class="min-w-0 flex-[999_1_260px]">' +
        (sc ? scenarioLink(sc.id, sc.title) : esc(o.title)) +
        (d.keys.length > d.scenarioIds.length
          ? ' <span class="text-muted">(' + esc(o.project) + ')</span>'
          : '') +
        '</span></li>'
      );
    })
    .join('');
  const first = run.outcomes.find((o) => o.key === d.keys[0]);
  const media = first ? evidence(first) : '';
  const tracker = trackerAction(d.keys, d.body);
  return (
    '<div class="flex flex-col gap-2.5"><div class="flex flex-wrap items-center gap-x-3 gap-y-2">' +
    severityChip(d) +
    '<span class="font-semibold">' +
    esc(d.kind) +
    '</span>' +
    (d.confidence !== null
      ? '<span class="text-muted">Confidence ' + Math.round(d.confidence * 100) + '%</span>'
      : '') +
    '</div><h2 id="detail-title" tabindex="-1" class="m-0 font-display text-2xl font-bold leading-tight tracking-tight outline-none">' +
    esc(d.title) +
    '</h2>' +
    (d.summary ? '<p class="m-0 max-w-[68ch] text-base text-ink-2">' + esc(d.summary) + '</p>' : '') +
    '</div>' +
    (d.expected || d.actual
      ? '<div class="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-4">' +
        (d.expected ? box('Expected', d.expected, 'border-pass-line bg-pass-soft', 'text-pass-ink') : '') +
        (d.actual ? box('What happened', d.actual, 'border-fail-line bg-fail-soft', 'text-fail-ink') : '') +
        '</div>'
      : '') +
    (d.cause
      ? section(
          d.causeTitle,
          '<p class="m-0 max-w-[68ch] rounded-[10px] border border-line bg-subtle px-4 py-3 font-mono text-[13px] leading-relaxed break-words">' +
            esc(d.cause) +
            '</p>',
        )
      : d.kind === 'Not analyzed'
        ? '<p class="m-0 rounded-[10px] border border-line bg-subtle px-4 py-3.5 text-ink-2">The AI has not analyzed this failure yet. Run <code>npx ai-qa-agent triage</code> in the project folder to find the cause, then select Refresh.</p>'
        : '') +
    (d.reasoning
      ? '<details class="disclosure"><summary>How the analyzer decided</summary><p class="m-0 mt-1 max-w-[68ch] text-ink-2">' +
        esc(d.reasoning) +
        '</p></details>'
      : '') +
    (d.steps.length
      ? section(
          'Steps to reproduce',
          '<ol class="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-ink-2">' +
            d.steps.map((x) => '<li class="break-words">' + esc(x) + '</li>').join('') +
            '</ol>',
        )
      : '') +
    section(
      d.scenarioIds.length === 1
        ? 'The test that found it'
        : 'The ' + d.scenarioIds.length + ' tests that found it',
      '<ul class="m-0 list-none p-0">' + tests + '</ul>',
    ) +
    (media ? section('Evidence', media) : '') +
    '<div class="flex flex-col gap-3 border-t border-divider pt-5"><h3 class="h-section">Your decision</h3>' +
    (tracker
      ? '<div class="flex flex-wrap items-center gap-x-3 gap-y-2">' + tracker + '</div>'
      : '<p class="m-0 text-muted">No bug tracker is set up. Add a <code>clickup</code> or <code>jira</code> section to <code>.qa/config.ts</code> to log defects from here.</p>') +
    (d.confirmed
      ? d.note
        ? '<p class="m-0 text-[13px] text-muted">The analyzer would not log this on its own: ' +
          esc(d.note) +
          '.</p>'
        : ''
      : tracker
        ? '<p class="m-0 text-[13px] text-muted">The analyzer did not confirm this as a product bug, so the ' +
          data.tracker.noun +
          ' is labelled needs-verification.</p>'
        : '') +
    '</div>'
  );
}

/** The defect the detail panel shows: the open one, else the first of the list when both fit. */
export function shownDefect(defects: readonly Defect[]): string {
  const { route } = state;
  if (route.page !== 'defects') return '';
  const open = defects.find((d) => d.id === route.id);
  return open?.id ?? (sideBySide.matches ? (defects[0]?.id ?? '') : '');
}

export function defectsPage(banner: string): string {
  const { data, route } = state;
  const defects = defectsOf(data);
  const run = data.run;
  const open = defects.filter((d) => !logged(d)).length;
  const text = !run
    ? 'No test has run yet.'
    : !defects.length
      ? 'Nothing failed in this run.'
      : plural(defects.length, 'defect') +
        ' found in this run. ' +
        (run.tasksPending || !data.tracker.configured
          ? ''
          : open
            ? plural(open, 'is', 'are') + ' not logged in ' + esc(data.tracker.name) + ' yet.'
            : 'All of them are logged in ' + esc(data.tracker.name) + '.');
  const heading =
    '<div class="flex flex-wrap items-start justify-between gap-x-4">' +
    pageHeading('Defects', text) +
    (defects.length
      ? '<div class="mb-6 flex flex-wrap gap-2">' +
        planButtons() +
        '<button type="button" class="btn"' +
        (data.job?.status === 'running' ? ' disabled' : '') +
        ' ' +
        act('start-job', { url: '/api/runs/failed' }) +
        '>Run failed tests</button></div>'
      : '') +
    '</div>';
  if (!defects.length) {
    return (
      heading +
      banner +
      emptyBox(
        run
          ? 'No defects. Every test in this run passed.'
          : 'Defects appear here after a test run. <a class="link" href="' +
              routeHash('overview') +
              '">Go to the overview</a>',
      )
    );
  }
  const shown = shownDefect(defects);
  const d = defects.find((x) => x.id === shown);
  return (
    heading +
    banner +
    '<div class="split flex items-start gap-6" data-detail="' +
    (d && d.id === route.id ? 'open' : 'closed') +
    '">' +
    '<section aria-label="Defect list" class="split-list panel min-w-0 overflow-hidden max-xl:flex-1 xl:w-[360px] xl:shrink-0">' +
    '<div class="bg-subtle px-5 py-3 text-[13px] font-semibold text-muted">Most severe first</div>' +
    '<ul class="m-0 list-none p-0">' +
    defects.map((x) => listItem(x, shown)).join('') +
    '</ul></section>' +
    '<section id="detail" aria-label="Selected defect" class="split-detail panel flex min-w-0 flex-1 flex-col gap-6 p-5 md:p-7">' +
    '<a class="link self-start xl:hidden" href="' +
    routeHash('defects') +
    '">Back to all defects</a>' +
    (d ? detail(d) : '') +
    '</section></div>'
  );
}

/** Small pieces of HTML shared by the pages: result marks, chips, the evidence block. */
import { act, fileUrl, link } from './dom.js';
import { esc, label, routeHash, type Defect, type Outcome, type ScenarioView, type Status } from './logic.js';
import { state } from './state.js';

export const STATUS_LABEL: Record<Status, string> = {
  passed: 'Passed',
  failed: 'Failed',
  flaky: 'Flaky',
  none: 'Not run',
};

/** The shape that goes with a result; always shown next to its label. */
export const mark = (status: Status): string =>
  '<span class="mark mark-' + status + '" aria-hidden="true"></span>';

/** Result as plain coloured text with its mark (list rows, counts). */
export const statusText = (status: Status): string =>
  '<span class="inline-flex items-center gap-2 font-semibold st-' +
  status +
  '">' +
  mark(status) +
  STATUS_LABEL[status] +
  '</span>';

/** Result as a filled chip (headers). */
export const statusPill = (status: Status, cls = ''): string =>
  '<span class="chip pill-' + status + ' ' + cls + '">' + mark(status) + STATUS_LABEL[status] + '</span>';

export const severityChip = (d: Pick<Defect, 'severity' | 'confirmed'>): string =>
  d.severity
    ? '<span class="chip sev-' + d.severity + '">' + label(d.severity) + '</span>'
    : '<span class="chip chip-outline">Unconfirmed</span>';

const TEST_STATE = { missing: 'No test yet', outdated: 'Test out of date' } as const;

/** Chips that say what kind of scenario this is and whether its test needs work. */
export function scenarioChips(sc: ScenarioView): string {
  const t = state.data.testStates[sc.id];
  return (
    (sc.critical
      ? '<span class="chip chip-accent" title="A core journey; part of the critical-flow tests">Critical flow</span>'
      : '') +
    (sc.origin === 'person'
      ? '<span class="chip chip-neutral" title="Written or edited by a person; the AI will not change or remove it">Yours</span>'
      : '') +
    (t ? '<span class="chip chip-warn">' + TEST_STATE[t] + '</span>' : '')
  );
}

export const addButton = (cls = 'btn'): string =>
  state.data.authoring.pages.length
    ? '<button type="button" class="' + cls + '" ' + act('open-editor') + '>Add scenario</button>'
    : '';

export const emptyBox = (html: string): string =>
  '<div class="rounded-xl border border-dashed border-control px-6 py-12 text-center text-muted">' +
  html +
  '</div>';

/** A page's name with its route, e.g. `Checkout (/checkout)`; just the route when unnamed. */
export function pageName(route: string): string {
  const name = state.data.model?.pages.find((p) => p.route === route)?.name;
  return name ? name + ' (' + route + ')' : route;
}

/** The link to the tracker item of a failed result, or the button that creates it. */
export function trackerAction(keys: readonly string[], body: Defect['body']): string {
  const { data } = state;
  const tr = data.tracker;
  if (!data.run || !keys.length) return '';
  if (!tr.configured) return '';
  if (data.run.tasksPending)
    return '<span class="text-muted" aria-live="polite">Checking ' + esc(tr.name) + '…</span>';
  const task = keys.map((k) => data.run!.tasks[k]).find((t) => t?.exists);
  if (task) {
    return (
      '<a class="btn" href="' +
      esc(task.url || '#') +
      '" target="_blank" rel="noopener">Open ' +
      (tr.noun === 'issue' ? '' : 'task ') +
      esc(task.taskId) +
      ' in ' +
      esc(tr.name) +
      '</a>' +
      (task.status ? '<span class="text-muted">Status: ' + esc(task.status) + '</span>' : '')
    );
  }
  return (
    '<button type="button" class="btn btn-primary"' +
    (tr.tokenPresent ? '' : ' disabled') +
    ' ' +
    act('file-bug', { body: JSON.stringify(body) }) +
    '>Create ' +
    tr.noun +
    ' in ' +
    esc(tr.name) +
    '</button>' +
    (tr.tokenPresent
      ? ''
      : '<a class="link" href="' + routeHash('tracker') + '">Connect ' + esc(tr.name) + ' to file bugs</a>')
  );
}

/** Screenshot, video and files of one result. `controls` adds markup under each (delete buttons). */
export function evidence(
  o: Outcome,
  controls: (what: 'screenshot' | 'video' | 'all', file?: string) => string = () => '',
): string {
  const a = o.artifacts;
  const shot = a.screenshots[0];
  if (!shot && !a.video) return '';
  const links =
    link(a.trace, 'Trace') +
    link(a.logs, 'Console and network', true) +
    link(a.errorContext, 'Page snapshot', true) +
    a.design.map((d) => link(d, label((d.split('_design-').pop() ?? d).replace('.png', '')), true)).join('');
  return (
    '<div class="flex flex-col gap-3">' +
    (shot
      ? '<div><a href="' +
        fileUrl(shot) +
        '" target="_blank" rel="noopener"><img class="block max-h-[480px] max-w-full rounded-[10px] border border-line" loading="lazy" src="' +
        fileUrl(shot) +
        '" alt="Screenshot at the end of ' +
        esc(o.key) +
        '"></a>' +
        controls('screenshot', shot) +
        '</div>'
      : '') +
    (a.video
      ? '<div><video class="block w-full rounded-[10px] bg-black" controls preload="metadata" src="' +
        fileUrl(a.video) +
        '" aria-label="Video of ' +
        esc(o.key) +
        '"></video>' +
        controls('video', a.video) +
        '</div>'
      : '') +
    (a.screenshots.length + (a.video ? 1 : 0) > 1 ? controls('all') : '') +
    (links ? '<div class="flex flex-wrap gap-x-5">' + links + '</div>' : '') +
    '</div>'
  );
}

export const scenarioLink = (id: string, text: string): string =>
  '<a class="font-semibold underline-offset-2 hover:underline" href="' +
  routeHash('scenarios', id) +
  '">' +
  esc(text) +
  '</a>';

/** The heading of a page with the sentence under it. The heading takes focus when the page changes. */
export const pageHeading = (title: string, text: string): string =>
  '<div class="mb-6 flex flex-col gap-1"><h1 id="page-title" tabindex="-1" class="m-0 font-display text-[30px] font-bold leading-tight tracking-tight outline-none">' +
  title +
  '</h1><p class="m-0 max-w-[64ch] text-base text-muted">' +
  text +
  '</p></div>';

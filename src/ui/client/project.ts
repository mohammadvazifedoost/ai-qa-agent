/**
 * The Project page: what the agent knows about the application (analysis, scenarios, critical
 * flows), what is out of date, and the AI steps that update it. A step is confirmed in the dialog
 * first, because it takes minutes and is billed by the AI provider.
 */
import { $, act, toast } from './dom.js';
import { startJob } from './jobs.js';
import {
  esc,
  label,
  plural,
  projectSummary,
  routeHash,
  runLabel,
  scenarioTargets,
  type Project,
  type StepKind,
} from './logic.js';
import { modalHeader } from './modal.js';
import { state } from './state.js';
import { longTable } from './table.js';
import { pageHeading as h1, pageName } from './ui.js';

type Tone = 'good' | 'warn' | 'neutral';
const TONE: Record<Tone, string> = {
  good: 'pill-passed',
  warn: 'chip-warn',
  neutral: 'chip-neutral',
};
const chip = (tone: Tone, text: string): string =>
  '<span class="chip ' + TONE[tone] + '">' + text + '</span>';

const when = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  // The same shape as a run's name, so both read alike.
  return runLabel(
    d.getFullYear() +
      '-' +
      p(d.getMonth() + 1) +
      '-' +
      p(d.getDate()) +
      '_' +
      p(d.getHours()) +
      '-' +
      p(d.getMinutes()) +
      '-00',
  );
};

const busy = (): boolean => state.data.job?.status === 'running';

/** A button that opens the confirm dialog of a step. */
const stepButton = (text: string, args: Record<string, string>, cls = 'btn', off = false): string =>
  '<button type="button" class="' +
  cls +
  '"' +
  (off || busy() ? ' disabled' : '') +
  ' ' +
  act('ask-step', args) +
  '>' +
  text +
  '</button>';

const fact = (name: string, value: string): string =>
  '<div class="flex flex-col"><dt class="text-[13px] text-muted">' +
  name +
  '</dt><dd class="m-0 font-semibold">' +
  value +
  '</dd></div>';

const facts = (items: string[]): string =>
  '<dl class="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-x-6 gap-y-3">' +
  items.join('') +
  '</dl>';

/** The frame of one step: its number, name, state, what it is, then rows and buttons. */
function step(
  n: number,
  id: string,
  title: string,
  state_: string,
  text: string,
  body: string,
  rows: string,
  foot: string,
): string {
  return (
    '<section aria-labelledby="' +
    id +
    '" class="panel overflow-hidden"><div class="flex flex-col gap-4 p-6">' +
    '<div class="flex flex-wrap items-center gap-x-3 gap-y-2"><span aria-hidden="true" class="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-bold text-surface">' +
    n +
    '</span><h2 id="' +
    id +
    '" class="m-0 text-[19px] font-bold">' +
    title +
    '</h2>' +
    state_ +
    '</div><p class="m-0 max-w-[72ch] text-ink-2">' +
    text +
    '</p>' +
    body +
    '</div>' +
    rows +
    (foot
      ? '<div class="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-divider px-6 py-4">' +
        foot +
        '</div>'
      : '') +
    '</section>'
  );
}

const hint = (text: string): string =>
  '<span class="min-w-0 flex-[1_1_280px] text-muted">' + text + '</span>';

const head = (cols: Array<[string, string]>): string =>
  '<div aria-hidden="true" class="flex gap-4 border-t border-divider bg-subtle px-6 py-2 text-[13px] font-semibold text-muted max-md:hidden">' +
  cols.map(([text, cls]) => '<span class="' + cls + '">' + text + '</span>').join('') +
  '</div>';

const pageCell = (route: string, name: string): string =>
  '<span class="flex min-w-0 flex-[999_1_200px] flex-col"><span class="font-mono text-sm font-medium break-all">' +
  esc(route) +
  '</span><span class="text-[13px] text-muted">' +
  esc(name) +
  '</span></span>';

const CODE: Record<Project['pages'][number]['code'], [Tone, string]> = {
  unchanged: ['neutral', 'Not changed'],
  changed: ['warn', 'Changed'],
  new: ['warn', 'New page'],
  removed: ['warn', 'Removed from the code'],
};

function analysisStep(p: Project): string {
  const sum = projectSummary(p);
  const a = p.analysis;
  if (!a) {
    return step(
      1,
      'analysis-h',
      'Application analysis',
      chip('warn', 'Not done yet'),
      'The agent reads the source code and records every page, what it does and the journeys through the application. Scenarios and tests are written from this.',
      '',
      '',
      stepButton('Analyze the application', { step: 'analyze', all: '1' }, 'btn btn-primary') +
        hint('Reads the whole application' + (p.design.configured ? ' and the Figma design.' : '.')),
    );
  }
  const parts = [
    p.code.toAnalyze.length ? plural(p.code.toAnalyze.length, 'page') + ' changed or new' : '',
    p.code.removed.length ? plural(p.code.removed.length, 'page') + ' removed' : '',
    p.code.shared.length
      ? plural(p.code.shared.length, 'shared file') +
        ' changed (' +
        esc(p.code.shared.slice(0, 3).join(', ')) +
        (p.code.shared.length > 3 ? ', …' : '') +
        ')'
      : '',
  ].filter(Boolean);
  const t = longTable(p.pages, {
    id: 'analysis',
    noun: ['page', 'pages'],
    placeholder: 'Find a page by route or name',
    attentionLabel: 'Changed',
    text: (x) => x.route + ' ' + x.name,
    needsAttention: (x) => x.code !== 'unchanged',
  });
  const rows =
    t.tools +
    '<div role="table" aria-label="Pages in the analysis">' +
    head([
      ['Page', 'flex-[999_1_200px]'],
      ['Importance', 'w-[110px] shrink-0'],
      ['Code since the last analysis', 'w-[220px] shrink-0'],
    ]) +
    t.rows
      .map((x) => {
        const [tone, text] = CODE[x.code];
        return (
          '<div role="row" class="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-1 border-t border-divider px-6 py-2">' +
          '<span role="cell" class="contents">' +
          pageCell(x.route, x.name || 'Not analyzed yet') +
          '</span><span role="cell" class="w-[110px] shrink-0 text-muted">' +
          label(x.importance) +
          '</span><span role="cell" class="w-[220px] shrink-0">' +
          chip(tone, text) +
          '</span></div>'
        );
      })
      .join('') +
    '</div>' +
    t.empty +
    t.pager;
  return step(
    1,
    'analysis-h',
    'Application analysis',
    sum.analysis === 'current' ? chip('good', 'Up to date') : chip('warn', 'Out of date'),
    'The agent reads the source code and records every page, what it does and the journeys through the application. Scenarios and tests are written from this.',
    facts([
      fact('Last analyzed', when(a.analyzedAt)),
      fact('Pages', String(a.pages)),
      fact('Journeys', a.journeys + ', of which ' + a.criticalJourneys + ' critical'),
      fact(
        'Design file',
        !p.design.configured
          ? 'Not connected'
          : p.design.extractedAt
            ? 'Figma, read ' + when(p.design.extractedAt)
            : 'Figma, not read yet',
      ),
    ]) +
      (sum.analysis === 'old'
        ? '<p class="m-0 rounded-[10px] bg-flaky-soft px-4 py-3 text-ink"><strong>This analysis was made by an older version of the agent.</strong> It does not rank the journeys, so scenarios cannot be written from it. Analyze the application again.</p>'
        : sum.analysis === 'outdated'
          ? '<p class="m-0 rounded-[10px] bg-flaky-soft px-4 py-3 text-ink"><strong>The code changed after the last analysis.</strong> ' +
            parts.join(', ') +
            '.</p>'
          : '<p class="m-0 text-muted">The code has not changed since the last analysis.</p>'),
    rows,
    (sum.analysis === 'old'
      ? ''
      : stepButton(
          'Update the analysis',
          { step: 'analyze' },
          sum.analysis === 'outdated' ? 'btn btn-primary' : 'btn',
          sum.analysis !== 'outdated',
        )) +
      stepButton(
        'Analyze everything again',
        { step: 'analyze', all: '1' },
        sum.analysis === 'old' ? 'btn btn-primary' : 'btn',
      ) +
      hint(
        sum.analysis === 'old'
          ? 'Reads the whole application.'
          : sum.analysis === 'outdated'
            ? sum.toAnalyze
              ? 'Update reads only the ' +
                plural(sum.toAnalyze, 'page') +
                ' that changed. Analyze everything again reads the whole application.'
              : 'Update records the change without reading any page again.'
            : 'Nothing to update. Analyze everything again reads the whole application.',
      ),
  );
}

const SET: Record<'current' | 'outdated' | 'none', [Tone, string]> = {
  current: ['good', 'Up to date'],
  outdated: ['warn', 'Out of date'],
  none: ['warn', 'None yet'],
};

function scenariosStep(p: Project): string {
  const text =
    'The test cases of each page, written by the AI from the analysis. Scenarios you wrote or edited are never changed, and scenarios you removed are not brought back.';
  if (!p.analysis?.usable) {
    return step(
      2,
      'sets-h',
      'Scenarios',
      chip('neutral', 'Waiting for step 1'),
      text,
      '',
      '',
      hint('Analyze the application first. Scenarios are written from the analysis.'),
    );
  }
  const todo = scenarioTargets(p, false);
  const analyzed = p.pages.filter((x) => x.scenarioState !== null);
  const t = longTable(analyzed, {
    id: 'sets',
    noun: ['page', 'pages'],
    placeholder: 'Find a page by route or name',
    attentionLabel: 'Out of date',
    text: (x) => x.route + ' ' + x.name,
    needsAttention: (x) => x.scenarioState !== 'current',
  });
  const rows =
    t.tools +
    '<div role="table" aria-label="Scenarios per page">' +
    head([
      ['Page', 'flex-[999_1_200px]'],
      ['Scenarios', 'w-[90px] shrink-0'],
      ['Status', 'w-[130px] shrink-0'],
      ['Action', 'w-[120px] shrink-0'],
    ]) +
    t.rows
      .map((x) => {
        const [tone, word] = SET[x.scenarioState!];
        const verb =
          x.scenarioState === 'current' ? 'Regenerate' : x.scenarioState === 'none' ? 'Write' : 'Update';
        return (
          '<div role="row" class="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-1 border-t border-divider px-6 py-1">' +
          '<span role="cell" class="contents">' +
          pageCell(x.route, x.name) +
          '</span><span role="cell" class="w-[90px] shrink-0"><span class="md:hidden text-muted">Scenarios: </span>' +
          x.scenarios +
          '</span><span role="cell" class="w-[130px] shrink-0">' +
          chip(tone, word) +
          '</span><span role="cell" class="w-[120px] shrink-0"><button type="button" class="btn btn-text -ml-3 text-accent"' +
          (busy() || x.code === 'removed' ? ' disabled' : '') +
          ' aria-label="' +
          verb +
          ' the scenarios of ' +
          esc(pageName(x.route)) +
          '" ' +
          act('ask-step', { step: 'scenarios', page: x.route }) +
          '>' +
          verb +
          '</button></span></div>'
        );
      })
      .join('') +
    '</div>' +
    t.empty +
    t.pager;
  return step(
    2,
    'sets-h',
    'Scenarios',
    todo.length ? chip('warn', plural(todo.length, 'page') + ' out of date') : chip('good', 'Up to date'),
    text,
    facts([
      fact('Scenarios', p.scenarios.total + ' on ' + plural(analyzed.length, 'page')),
      fact('Yours', p.scenarios.person ? p.scenarios.person + ', kept as written' : 'None'),
      fact('Removed by you', p.scenarios.removed ? p.scenarios.removed + ', stay removed' : 'None'),
    ]),
    rows,
    stepButton(
      'Update scenarios',
      { step: 'scenarios' },
      todo.length ? 'btn btn-primary' : 'btn',
      !todo.length,
    ) +
      stepButton('Regenerate all scenarios', { step: 'scenarios', all: '1' }) +
      hint(
        todo.length
          ? 'Update writes only the ' +
              plural(todo.length, 'page') +
              ' that ' +
              (todo.length === 1 ? 'is' : 'are') +
              ' out of date. Regenerate all writes every page again.'
          : 'Nothing to update. Regenerate all writes every page again.',
      ),
  );
}

function criticalStep(p: Project): string {
  const text =
    'A few end-to-end journeys the application cannot do without, such as signing in or placing an order. They run on their own as a quick check: Run tests, then Critical flows.';
  if (!p.analysis?.usable) {
    return step(
      3,
      'crit-h',
      'Critical flows',
      chip('neutral', 'Waiting for step 1'),
      text,
      '',
      '',
      hint('Analyze the application first. Critical flows are chosen from its journeys.'),
    );
  }
  const c = p.critical;
  const rows = c.chosen.length
    ? '<ul class="m-0 list-none p-0">' +
      c.chosen
        .map(
          (s) =>
            '<li class="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-1 border-t border-divider px-6 py-2"><span class="w-[150px] shrink-0 font-mono text-[13px]">' +
            esc(s.id) +
            '</span><a class="link min-w-0 flex-[999_1_260px]" href="' +
            routeHash('scenarios', s.id) +
            '">' +
            esc(s.title) +
            '</a><span class="w-[110px] shrink-0 text-muted">' +
            (s.hasTest ? 'Has a test' : 'No test yet') +
            '</span></li>',
        )
        .join('') +
      '</ul>'
    : '';
  return step(
    3,
    'crit-h',
    'Critical flows',
    c.chosen.length ? chip('good', c.chosen.length + ' chosen') : chip('neutral', 'None chosen'),
    text,
    '<p class="m-0 text-muted">' +
      (c.journeys
        ? 'The analysis ranks ' +
          plural(c.journeys, 'journey') +
          ' as critical. Each one gets one scenario' +
          (c.max ? ', up to ' + c.max + ' (set in the config).' : '.')
        : 'The analysis ranks no journey as critical, so there is nothing to choose from. Analyze everything again in step 1.') +
      '</p>',
    rows,
    stepButton(
      c.chosen.length ? 'Choose critical flows again' : 'Choose critical flows',
      { step: 'critical' },
      c.chosen.length ? 'btn' : 'btn btn-primary',
      !c.journeys,
    ) +
      hint(
        c.chosen.length
          ? 'Use this after the analysis changed, or to choose a different number of flows.'
          : 'Takes the critical journeys from the analysis and writes one scenario for each.',
      ),
  );
}

export function projectPage(banner: string): string {
  const p = state.project;
  return (
    h1(
      'Project',
      'What the agent knows about your application. After the application changes, bring these three steps up to date, from top to bottom.',
    ) +
    (banner ? '<div class="max-w-[1080px]">' + banner + '</div>' : '') +
    '<div class="flex max-w-[1080px] flex-col gap-6">' +
    '<p class="m-0 flex items-start gap-3 rounded-xl border border-line bg-accent-soft px-4 py-3.5"><svg aria-hidden="true" class="mt-0.5 shrink-0 text-accent" width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="2"></circle><path d="M10 9v5M10 6.2v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>' +
    '<span class="max-w-[80ch]">These steps use AI. Each one takes a few minutes and is billed by your AI provider. One runs at a time, you can keep using the dashboard meanwhile, and you can cancel it.</span></p>' +
    (p
      ? analysisStep(p) + scenariosStep(p) + criticalStep(p)
      : '<p class="m-0 text-muted" role="status">' +
        (state.projectError ? esc(state.projectError) : 'Checking the project…') +
        '</p>') +
    '</div>'
  );
}

/* ---------- the confirm dialog ---------- */

interface Plan {
  title: string;
  sub: string;
  changes: string[];
  stays: string[];
  /** An extra control above the lists (a checkbox or a number field). */
  field: string;
  cost: string;
  go: string;
  url: string;
  body: Record<string, unknown>;
}

const routesText = (routes: string[]): string =>
  routes.length <= 3
    ? routes.join(', ')
    : routes.slice(0, 3).join(', ') + ' and ' + (routes.length - 3) + ' more';

function planFor(p: Project, kind: StepKind, args: { all: boolean; page: string }): Plan {
  const yours = p.scenarios.person
    ? 'Your ' + plural(p.scenarios.person, 'scenario') + ', exactly as written.'
    : 'Scenarios you write or edit yourself.';
  const removed = p.scenarios.removed
    ? 'The ' +
      plural(p.scenarios.removed, 'scenario') +
      ' you removed stay' +
      (p.scenarios.removed === 1 ? 's' : '') +
      ' removed.'
    : '';
  if (kind === 'analyze') {
    const first = !p.analysis;
    const all = args.all || first;
    const n = p.code.toAnalyze.length;
    return {
      title: first ? 'Analyze the application?' : all ? 'Analyze everything again?' : 'Update the analysis?',
      sub: all
        ? 'The AI reads the whole application.'
        : n
          ? 'The AI reads the ' + plural(n, 'page') + ' whose code changed.'
          : 'No page needs to be read again; the change is only recorded.',
      changes: all
        ? [
            'The description of every page and the list of journeys.',
            ...(first ? [] : ['Scenarios of pages whose description changed are marked out of date.']),
          ]
        : [
            n
              ? 'The description of ' + esc(routesText(p.code.toAnalyze)) + ', and the list of journeys.'
              : 'The record of which files the analysis was made from.',
            ...(p.code.removed.length
              ? ['Removed from the analysis: ' + esc(routesText(p.code.removed)) + '.']
              : []),
            ...(n ? ['Scenarios of those pages are marked out of date.'] : []),
          ],
      stays: first
        ? []
        : [(all ? 'Every' : 'The other pages, every') + ' scenario, every test and all results.'],
      field:
        p.design.configured && !first
          ? '<label class="flex min-h-11 items-start gap-2.5 rounded-[10px] border border-line px-3 py-2.5"><input id="step-design" type="checkbox" class="mt-1 size-[18px]"><span class="flex flex-col"><span class="font-semibold">Also read the Figma design again</span><span class="text-[13px] text-muted">Only needed when the design file changed.</span></span></label>'
          : '',
      cost: all || n ? 'Uses AI: a few minutes, billed by your AI provider.' : 'Does not use AI.',
      go: first ? 'Analyze the application' : all ? 'Analyze everything again' : 'Update the analysis',
      url: '/api/project/analyze',
      body: { all },
    };
  }
  if (kind === 'scenarios') {
    const routes = args.page ? [args.page] : scenarioTargets(p, args.all);
    const one = routes.length === 1;
    const title = args.page
      ? 'Write the scenarios of ' + esc(pageName(args.page)) + ' again?'
      : args.all
        ? 'Regenerate all scenarios?'
        : 'Update scenarios?';
    return {
      title,
      sub:
        'The AI writes the scenarios of ' +
        (one ? esc(routes[0]!) : plural(routes.length, 'page')) +
        ' from the current analysis.',
      changes: [
        'The scenarios the AI wrote for ' +
          (one ? 'this page' : 'these pages') +
          ' can change, appear or disappear.',
        'A changed scenario shows Test out of date until its test is rewritten.',
      ],
      stays: [yours, removed, 'Test files and the results of earlier runs.'].filter(Boolean),
      field: '',
      cost: 'Uses AI: a few minutes per page, billed by your AI provider.',
      go: args.page ? 'Write the scenarios' : args.all ? 'Regenerate all scenarios' : 'Update scenarios',
      url: '/api/project/scenarios',
      body: args.page ? { page: args.page } : { all: args.all },
    };
  }
  const c = p.critical;
  const limit = c.max ? Math.min(c.max, c.journeys) : c.journeys;
  return {
    title: c.chosen.length ? 'Choose critical flows again?' : 'Choose critical flows?',
    sub: 'The AI writes one scenario for each critical journey of the analysis.',
    changes: [
      c.chosen.length
        ? 'The critical flows the AI wrote are replaced.'
        : 'Up to ' +
          plural(limit, 'critical flow') +
          (limit === 1 ? ' is' : ' are') +
          ' added to the scenarios.',
    ],
    stays: ['Critical flows you wrote or edited, and every other scenario.'],
    field:
      '<div class="flex flex-col gap-1.5"><label for="step-max" class="font-semibold">How many flows at most</label>' +
      '<input id="step-max" type="number" min="1" step="1" inputmode="numeric" class="field w-36" placeholder="' +
      (limit === c.journeys ? 'All ' : '') +
      limit +
      '" aria-describedby="step-max-hint"><span id="step-max-hint" class="text-[13px] text-muted">Leave empty to take ' +
      (c.max ? 'the ' + c.max + ' set in the config.' : 'every journey the analysis ranks as critical.') +
      '</span></div>',
    cost: 'Uses AI: a few minutes, billed by your AI provider.',
    go: 'Choose critical flows',
    url: '/api/project/critical',
    body: {},
  };
}

const list = (title: string, items: string[]): string =>
  items.length
    ? '<div class="flex flex-col gap-1.5"><h3 class="h-section">' +
      title +
      '</h3><ul class="m-0 flex list-disc flex-col gap-1 pl-5 text-ink-2">' +
      items.map((x) => '<li>' + x + '</li>').join('') +
      '</ul></div>'
    : '';

/** The step waiting in the dialog for its Start button. */
let pending: Plan | null = null;

/** Ask before a step starts: what changes, what stays, and that it uses AI. */
export function askStep(kind: StepKind, args: { all: boolean; page: string }): void {
  const p = state.project;
  if (!p) return;
  const plan = planFor(p, kind, args);
  pending = plan;
  const m = $<HTMLDialogElement>('#modal');
  m.dataset.id = '';
  m.dataset.mode = 'confirm';
  m.innerHTML =
    modalHeader(plan.title, plan.sub) +
    '<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-5 md:px-6">' +
    plan.field +
    list('What changes', plan.changes) +
    list('What stays', plan.stays) +
    '<p class="m-0 rounded-[10px] bg-accent-soft px-3.5 py-2.5 text-sm">' +
    plan.cost +
    '</p></div>' +
    '<div class="flex flex-wrap justify-end gap-2.5 border-t border-line px-5 py-4 md:px-6">' +
    '<button type="button" class="btn" ' +
    act('close-modal') +
    '>Cancel</button><button type="button" class="btn btn-primary" id="step-go" ' +
    act('start-step') +
    '>' +
    plan.go +
    '</button></div>';
  if (!m.open) m.showModal();
}

/** Start the step the dialog asked about, with the choices made in it. */
export function startStep(): void {
  const plan = pending;
  if (!plan) return;
  const body = { ...plan.body };
  const max = document.querySelector<HTMLInputElement>('#step-max');
  if (max && max.value.trim()) {
    const n = Number(max.value);
    if (!Number.isInteger(n) || n < 1) {
      toast('Enter a whole number, 1 or more, or leave the field empty.');
      max.focus();
      return;
    }
    body.max = n;
  }
  const design = document.querySelector<HTMLInputElement>('#step-design');
  if (design) body.design = design.checked;
  pending = null;
  $<HTMLDialogElement>('#modal').close();
  void startJob(plan.url, body);
}

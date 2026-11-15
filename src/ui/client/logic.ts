/**
 * Pure dashboard logic: joins between scenarios and run results, list filtering and counts.
 * No DOM access, so it is unit-tested directly (test/ui-logic.test.ts).
 */
import type { ProjectStatus } from '../project.js';
import type { Overview } from '../server.js';

export type Data = Overview;
export type Project = ProjectStatus;
export type ScenarioView = Overview['scenarios'][number];
export type Outcome = NonNullable<Overview['run']>['outcomes'][number];
export type Status = 'passed' | 'failed' | 'flaky' | 'none';
/** Which media of a result a delete control removes. */
export type MediaWhat = 'screenshot' | 'video' | 'all';

/**
 * Every video of a result, first page first. A test that opens popups or new tabs has one video per
 * page; results written before `videos` existed have only `video`.
 */
export const videosOf = (a: { video: string | null; videos?: string[] }): string[] =>
  a.videos?.length ? a.videos : a.video ? [a.video] : [];

/**
 * Accessible name of the control that deletes a result's media. `page` (1-based) tells the videos
 * of a test that opened several pages apart; the first page's video keeps the plain name.
 */
export const mediaDeleteLabel = (what: MediaWhat, key: string, page = 1): string =>
  what === 'all'
    ? 'Delete all screenshots and videos of ' + key
    : what === 'screenshot'
      ? 'Delete final screenshot of ' + key
      : page > 1
        ? 'Delete video of page ' + page + ' of ' + key
        : 'Delete video of ' + key;

export interface View {
  page: string;
  only: 'all' | 'failed' | 'passed' | 'notrun' | 'todo';
  type: string;
  q: string;
}

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const fmtRun = (id: string): string => id.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A run id (`2026-09-24_15-24-46`) as a date people read: `24 Sep 2026, 15:24`. */
export function runLabel(id: string): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)/.exec(id);
  if (!m) return id;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}, ${m[4]}:${m[5]}`;
}

/** `functional` → `Functional`, `PRODUCT_BUG` → `Product bug`. */
export const label = (s: string | null | undefined): string => {
  const t = String(s ?? '')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;

/* ---------- routes: #/overview, #/defects/<id>, #/scenarios/<id> ---------- */
export type PageName = 'overview' | 'defects' | 'scenarios' | 'project' | 'tracker';
export interface Route {
  page: PageName;
  /** The defect or scenario shown in the detail panel; empty for none. */
  id: string;
}

export function parseRoute(hash: string): Route {
  const [page, ...rest] = hash.replace(/^#\/?/, '').split('/');
  const name: PageName =
    page === 'defects' || page === 'scenarios' || page === 'project' || page === 'tracker'
      ? page
      : 'overview';
  let id = rest.join('/');
  try {
    id = decodeURIComponent(id);
  } catch {
    id = '';
  }
  return { page: name, id: name === 'defects' || name === 'scenarios' ? id : '' };
}

export const routeHash = (page: PageName, id = ''): string =>
  '#/' + page + (id ? '/' + encodeURIComponent(id) : '');

/* ---------- long tables: find, filter, one page at a time ---------- */

/** What one long table shows: the search text, all rows or only those that need attention, the page. */
export interface TableView {
  q: string;
  only: 'all' | 'attention';
  pageNo: number;
}

/** Rows a table shows for `view`, the ones that need attention first (otherwise in their order). */
export function filterTable<T>(
  rows: readonly T[],
  view: Pick<TableView, 'q' | 'only'>,
  text: (row: T) => string,
  needsAttention: (row: T) => boolean,
): { rows: T[]; total: number; attention: number } {
  const q = view.q.trim().toLowerCase();
  const attention = rows.filter(needsAttention).length;
  const matching = rows.filter(
    (r) => (!q || text(r).toLowerCase().includes(q)) && (view.only === 'all' || needsAttention(r)),
  );
  const first = matching.filter(needsAttention);
  const rest = matching.filter((r) => !needsAttention(r));
  return { rows: [...first, ...rest], total: rows.length, attention };
}

/** A run's counts in words: `24 passed, 18 failed, 2 flaky`. */
export function runCounts(
  stats: { passed: number; failed: number; flaky: number } | null | undefined,
): string {
  if (!stats) return 'No results';
  const parts = [
    stats.passed ? stats.passed + ' passed' : '',
    stats.failed ? stats.failed + ' failed' : '',
    stats.flaky ? stats.flaky + ' flaky' : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No results';
}

/* ---------- the Project page: what is out of date ---------- */

/** The AI steps of the Project page. */
export type StepKind = 'analyze' | 'scenarios' | 'critical';

export interface ProjectSummary {
  /**
   * `none`: never analyzed. `old`: made by an older version of the agent, so it has to be made
   * again. `outdated`: the code changed since the analysis.
   */
  analysis: 'none' | 'old' | 'outdated' | 'current';
  /** Pages an update of the analysis reads again (changed and new). */
  toAnalyze: number;
  /** Analyzed pages whose scenarios are out of date or missing. */
  scenarioPages: number;
  /** Something in step 1 or 2 needs an update. */
  outdated: boolean;
}

export function projectSummary(p: Project): ProjectSummary {
  const changed = p.code.toAnalyze.length + p.code.removed.length + p.code.shared.length;
  const analysis = !p.analysis ? 'none' : !p.analysis.usable ? 'old' : changed ? 'outdated' : 'current';
  // Scenarios are written from a usable analysis; before that there is nothing to update.
  const scenarioPages = p.analysis?.usable ? scenarioTargets(p, false).length : 0;
  return {
    analysis,
    toAnalyze: p.code.toAnalyze.length,
    scenarioPages,
    outdated: analysis === 'old' || analysis === 'outdated' || scenarioPages > 0,
  };
}

/** The pages a scenario step writes: every analyzed page (`all`), or those out of date or without any. */
export function scenarioTargets(p: Project, all: boolean): string[] {
  return p.pages
    .filter((x) => x.scenarioState !== null && x.code !== 'removed')
    .filter((x) => all || x.scenarioState !== 'current')
    .map((x) => x.route);
}

/** Non-empty trimmed lines of a textarea. */
export const lines = (v: string): string[] =>
  v
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

export const outcomesFor = (data: Data, id: string): Outcome[] =>
  data.run ? data.run.outcomes.filter((o) => o.scenarioId === id) : [];

/** A test run again on its own after the analysis: the analysis describes an earlier failure. */
const rerunOf = (data: Data, key: string): string | undefined =>
  data.run?.outcomes.find((o) => o.key === key)?.rerunAt;

export const failureFor = (data: Data, key: string) =>
  rerunOf(data, key) ? undefined : data.run?.failures.find((f) => f.key === key);

export const issueFor = (data: Data, key: string) =>
  rerunOf(data, key) ? undefined : data.run?.issues.find((i) => i.failureKeys.includes(key));

export function statusOf(data: Data, id: string): Status {
  const s = outcomesFor(data, id).map((o) => o.status);
  if (!s.length) return 'none';
  if (s.includes('failed')) return 'failed';
  if (s.includes('flaky')) return 'flaky';
  return s.every((x) => x === 'skipped') ? 'none' : 'passed';
}

export const isFailing = (s: Status): boolean => s === 'failed' || s === 'flaky';

export function failingOutcome(data: Data, sc: ScenarioView): Outcome | null {
  const outs = outcomesFor(data, sc.id).filter((o) => o.status === 'failed' || o.status === 'flaky');
  return outs.find((o) => issueFor(data, o.key)) ?? outs[0] ?? null;
}

export function classificationOf(data: Data, sc: ScenarioView): string | null {
  const f = outcomesFor(data, sc.id)
    .map((o) => failureFor(data, o.key))
    .find(Boolean);
  return f ? f.classification : null;
}

export const isBug = (c: string): boolean => c === 'PRODUCT_BUG' || c === 'DESIGN_MISMATCH';
export const human = (c: string | null | undefined): string => (c ? c.replace('_', ' ').toLowerCase() : '');

export interface Row {
  sc: ScenarioView;
  status: Status;
}

/** Everything the list and toolbar need, derived from the loaded data and the view filters. */
export function listModel(data: Data, view: View) {
  const all: Row[] = data.scenarios.map((sc) => ({ sc, status: statusOf(data, sc.id) }));
  const inRun = all.filter((x) => x.status !== 'none');
  const pages = [...new Set(all.map((x) => x.sc.page))].sort();
  const todo = all.filter((x) => data.testStates[x.sc.id]).length;
  const notRun = data.run ? all.length - inRun.length : 0;
  /** Not-run scenarios that can run: approved and with a test. */
  const notRunWithTest = all.filter(
    (x) => x.status === 'none' && x.sc.approved && data.testStates[x.sc.id] !== 'missing',
  ).length;
  const failed = inRun.filter((x) => isFailing(x.status)).length;
  const only: View['only'] =
    (view.only === 'todo' && !todo) || (view.only === 'notrun' && !notRun) ? 'all' : view.only;
  const q = view.q.trim().toLowerCase();
  /** What the page, type and search filters leave; the result tabs count and filter these. */
  const scoped = all.filter(
    (x) =>
      (!view.page || x.sc.page === view.page) &&
      (!view.type || x.sc.category === view.type) &&
      (!q || x.sc.id.toLowerCase().includes(q) || x.sc.title.toLowerCase().includes(q)),
  );
  const matches: Record<View['only'], (x: Row) => boolean> = {
    all: () => true,
    failed: (x) => isFailing(x.status),
    passed: (x) => x.status === 'passed',
    notrun: (x) => x.status === 'none',
    todo: (x) => !!data.testStates[x.sc.id],
  };
  const counts = {
    all: scoped.length,
    failed: scoped.filter(matches.failed).length,
    passed: scoped.filter(matches.passed).length,
    notrun: data.run ? scoped.filter(matches.notrun).length : 0,
    todo: scoped.filter(matches.todo).length,
  };
  // Scenarios with a result come first, so a run of a few tests does not hide them among the rest.
  const picked = scoped.filter(matches[only]);
  const rows = [...picked.filter((x) => x.status !== 'none'), ...picked.filter((x) => x.status === 'none')];
  const types = [...new Set(all.map((x) => x.sc.category))].sort();
  return { all, inRun, pages, rows, counts, todo, notRun, notRunWithTest, failed, only, types };
}

/** One page of a list, and the numbers its pager shows. `pageNo` is clamped to the last page. */
export function paginate<T>(rows: readonly T[], pageNo: number, per: number) {
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const page = Math.min(Math.max(0, pageNo), pages - 1);
  const from = page * per;
  return {
    items: rows.slice(from, from + per),
    page,
    pages,
    from: rows.length ? from + 1 : 0,
    to: Math.min(from + per, rows.length),
    total: rows.length,
  };
}

/** The run in one word: any failure makes it failed, else any flaky test makes it flaky. */
/**
 * The share of the tests that ran which passed, as a whole percentage. It only says 100 when every
 * test passed and only 0 when none did. `null` when nothing ran.
 */
export function passRate(
  stats: { passed: number; failed: number; flaky: number } | null | undefined,
): { ran: number; pct: number } | null {
  if (!stats) return null;
  const ran = stats.passed + stats.failed + stats.flaky;
  if (!ran) return null;
  const pct = Math.round((stats.passed / ran) * 100);
  return { ran, pct: stats.passed === ran ? 100 : stats.passed === 0 ? 0 : Math.min(99, Math.max(1, pct)) };
}

/** Two letters that stand for a project in the menu: `demo-shop` gives `DS`, `blog` gives `BL`. */
export function initials(name: string): string {
  // A scoped package name (`@scope/name`) is known by its last part.
  const words = (name.split('/').pop() ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const first = (word: string | undefined) => Array.from(word ?? '');
  const letters = words.length > 1 ? [first(words[0])[0], first(words[1])[0]] : first(words[0]).slice(0, 2);
  return letters.join('').toUpperCase();
}

/** An address as shown in the menu: without the protocol and the closing slash. */
export const shortUrl = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

export function verdictOf(
  stats: { passed: number; failed: number; flaky: number } | null | undefined,
): Status {
  if (!stats || stats.passed + stats.failed + stats.flaky === 0) return 'none';
  return stats.failed ? 'failed' : stats.flaky ? 'flaky' : 'passed';
}

/** Results of the selected run per page, most important page first (from the application model). */
export function pageResults(data: Data) {
  const rank = { essential: 0, secondary: 1, optional: 2 } as const;
  const known = new Map((data.model?.pages ?? []).map((p) => [p.route, p]));
  const routes = [...new Set(data.scenarios.map((s) => s.page))];
  return routes
    .map((route) => {
      const statuses = data.scenarios.filter((s) => s.page === route).map((s) => statusOf(data, s.id));
      const page = known.get(route);
      return {
        route,
        name: page?.name ?? '',
        importance: page?.importance ?? null,
        total: statuses.length,
        passed: statuses.filter((s) => s === 'passed').length,
        failed: statuses.filter(isFailing).length,
        notRun: statuses.filter((s) => s === 'none').length,
      };
    })
    .sort(
      (a, b) =>
        (a.importance ? rank[a.importance] : 3) - (b.importance ? rank[b.importance] : 3) ||
        a.route.localeCompare(b.route),
    );
}

/* ---------- defects: failed tests grouped by cause ---------- */
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Defect {
  /** The issue id, or `test:<outcome key>` for a failure the analyzer did not confirm as a defect. */
  id: string;
  /** True for a product bug or design mismatch the analyzer consolidated into an issue. */
  confirmed: boolean;
  title: string;
  severity: Severity | null;
  /** `Product bug`, `Design mismatch`, `Test problem`, `Not analyzed`... */
  kind: string;
  /** 0..1, or null when the failure was not analyzed. */
  confidence: number | null;
  summary: string;
  expected: string;
  actual: string;
  /** Suspected root cause, or what is wrong with the test for a test problem. */
  cause: string;
  causeTitle: string;
  reasoning: string;
  steps: string[];
  /** Why the analyzer would not file it on its own; empty when it would. */
  note: string;
  /** Failed results (outcome keys) this defect explains. */
  keys: string[];
  scenarioIds: string[];
  /** What POST /api/file needs to create its tracker item. */
  body: { issueId: string } | { failureKey: string };
  /** The structured analysis of the defect's first failure; null when there is none. */
  analysis: DefectAnalysis | null;
  /** The named step the first failed test stopped at, from the run (no AI). */
  failedStep: string;
  /** The scenarios' expected results plus the conditions the analysis adds. */
  acceptance: string[];
}

export interface DefectAnalysis {
  category: string;
  failurePoint: string;
  difference: string;
  timing: string;
  rootCauseStatus: 'verified' | 'hypothesis' | 'unconfirmed';
  facts: string[];
  hypotheses: string[];
  missing: string[];
  investigation: string[];
  /** Code locations the engine verified, as "path:line — note". */
  locations: string[];
  fix: {
    target: string;
    summary: string;
    changes: string[];
    steps: string[];
    alternatives: string[];
    sideEffects: string;
    expectedAfterFix: string;
    verification: string[];
    regression: string[];
  };
  engineNotes: string[];
}

const CATEGORY: Record<string, string> = {
  APP_FUNCTIONAL: 'Application functional bug',
  UI_RENDERING: 'UI / rendering issue',
  BACKEND_API: 'Backend / API failure',
  DATA_INTEGRITY: 'Data validation or integrity issue',
  AUTH: 'Authentication / authorization issue',
  NAVIGATION: 'Navigation / routing issue',
  STATE_MANAGEMENT: 'State management issue',
  PERFORMANCE_TIMEOUT: 'Performance / timeout issue',
  TEST_IMPLEMENTATION: 'Test implementation issue',
  ENVIRONMENT_INFRA: 'Test environment / infrastructure issue',
  FLAKY: 'Flaky or intermittent failure',
  UNKNOWN: 'Unknown / insufficient evidence',
};

type Failure = NonNullable<Overview['run']>['failures'][number];

/** The analysis of a failure as the dashboard shows it. */
export function analysisOf(f: Failure | undefined): DefectAnalysis | null {
  const a = f?.analysis;
  if (!a) return null;
  return {
    category: CATEGORY[a.category] ?? label(a.category),
    failurePoint: a.failurePoint,
    difference: a.difference,
    timing:
      (a.timing.suspected ? 'Possibly timing-related: ' : 'Not timing-related: ') + a.timing.explanation,
    rootCauseStatus: a.rootCause.status,
    facts: a.rootCause.facts,
    hypotheses: a.rootCause.hypotheses,
    missing: a.rootCause.missingEvidence,
    investigation: a.rootCause.investigation,
    locations: a.rootCause.locations.map(
      (l) => l.file + (l.line !== null ? ':' + l.line : '') + (l.note ? ' — ' + l.note : ''),
    ),
    fix: {
      target: a.fix.target,
      summary: a.fix.summary,
      changes: a.fix.requiredChanges,
      steps: a.fix.implementationSteps,
      alternatives: a.fix.alternatives,
      sideEffects: a.fix.sideEffects,
      expectedAfterFix: a.fix.expectedAfterFix,
      verification: a.fix.verificationSteps,
      regression: [...a.fix.regressionScenarioIds, ...a.fix.regressionAreas],
    },
    engineNotes: f.engineNotes ?? [],
  };
}

/** Where a result stopped, from its recorded steps. */
export function failedStepText(o: Outcome | undefined): string {
  const steps = o?.steps ?? [];
  const i = steps.findIndex((s) => s.status === 'failed');
  if (i < 0) return '';
  const st = steps[i]!;
  return 'Step ' + (i + 1) + ' of ' + steps.length + ': ' + [st.title, ...(st.failedPath ?? [])].join(' › ');
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const KIND: Record<string, string> = {
  PRODUCT_BUG: 'Product bug',
  DESIGN_MISMATCH: 'Design mismatch',
  TEST_BUG: 'Test problem',
  ENVIRONMENT_FAILURE: 'Environment problem',
  INFRASTRUCTURE_FAILURE: 'Infrastructure problem',
  UNKNOWN: 'Cause not confirmed',
};

/**
 * Everything that failed in the selected run, one entry per cause: the analyzer's issues first
 * (most severe first), then the failed tests it did not turn into an issue, one per scenario.
 */
export function defectsOf(data: Data): Defect[] {
  const run = data.run;
  if (!run) return [];
  const failing = run.outcomes.filter((o) => o.status === 'failed' || o.status === 'flaky');
  const live = new Set(failing.map((o) => o.key));
  const defects: Defect[] = [];
  const covered = new Set<string>();

  for (const issue of run.issues) {
    // A test that was run again since the analysis no longer belongs to the issue.
    const keys = issue.failureKeys.filter((k) => live.has(k) && issueFor(data, k)?.id === issue.id);
    if (!keys.length) continue;
    keys.forEach((k) => covered.add(k));
    const first = failureFor(data, keys[0]!);
    defects.push({
      id: issue.id,
      confirmed: true,
      title: issue.bug.title,
      severity: issue.bug.severity,
      kind: KIND[issue.classification]!,
      confidence: issue.confidence,
      summary: first && first.summary !== issue.bug.title ? first.summary : '',
      expected: issue.bug.expectedResult,
      actual: issue.bug.actualResult,
      cause: issue.bug.suspectedRootCause,
      causeTitle: 'Likely cause',
      reasoning: first?.reasoning ?? '',
      steps: issue.bug.stepsToReproduce,
      note: issue.fileable ? '' : (issue.notFiledReason ?? ''),
      keys,
      scenarioIds: [...new Set(keys.map((k) => run.outcomes.find((o) => o.key === k)?.scenarioId ?? k))],
      body: { issueId: issue.id },
      analysis: analysisOf(first),
      failedStep: failedStepText(run.outcomes.find((o) => o.key === keys[0])),
      acceptance: unique([
        ...keys.flatMap(
          (k) =>
            data.scenarios.find((s) => s.id === run.outcomes.find((o) => o.key === k)?.scenarioId)
              ?.expectedResults ?? [],
        ),
        ...(first?.analysis?.fix.acceptanceCriteria ?? []),
      ]),
    });
  }

  const rest = new Map<string, Defect>();
  for (const o of failing) {
    if (covered.has(o.key)) continue;
    const group = o.scenarioId ?? o.key;
    const seen = rest.get(group);
    if (seen) {
      seen.keys.push(o.key);
      continue;
    }
    const f = failureFor(data, o.key);
    const sc = data.scenarios.find((s) => s.id === o.scenarioId);
    const error = o.error?.message.split('\n\n')[0] ?? '';
    rest.set(group, {
      id: 'test:' + o.key,
      confirmed: false,
      title: f?.bug?.title ?? f?.summary ?? sc?.title ?? o.title,
      severity: null,
      kind: f ? (KIND[f.classification] ?? label(f.classification)) : 'Not analyzed',
      confidence: f ? f.confidence : null,
      summary: f?.bug && f.summary !== f.bug.title ? f.summary : '',
      expected: f?.bug?.expectedResult ?? sc?.expectedResults.join('; ') ?? '',
      actual: f?.bug?.actualResult ?? error,
      cause: f?.testProblem ?? f?.bug?.suspectedRootCause ?? '',
      causeTitle: f?.testProblem ? 'What is wrong with the test' : 'Likely cause',
      reasoning: f?.reasoning ?? '',
      steps: f?.bug?.stepsToReproduce ?? [],
      note: '',
      keys: [o.key],
      scenarioIds: [group],
      body: { failureKey: o.key },
      analysis: analysisOf(f),
      failedStep: failedStepText(o),
      acceptance: unique([...(sc?.expectedResults ?? []), ...(f?.analysis?.fix.acceptanceCriteria ?? [])]),
    });
  }

  const order = (d: Defect): number => (d.severity ? SEVERITY_RANK[d.severity] : 9);
  defects.sort((a, b) => order(a) - order(b) || (b.confidence ?? 0) - (a.confidence ?? 0));
  return [...defects, ...rest.values()];
}

/** A defect as Markdown, for pasting into a chat, a pull request or a tracker without an integration. */
export function bugReportText(d: Defect): string {
  const list = (title: string, xs: readonly string[]): string[] =>
    xs.length ? ['', '## ' + title, ...xs.map((x) => '- ' + x)] : [];
  const a = d.analysis;
  return [
    '# ' + d.title,
    '',
    '- Kind: ' + d.kind + (a ? ' (' + a.category + ')' : ''),
    ...(d.severity ? ['- Severity: ' + label(d.severity)] : []),
    ...(d.confidence !== null ? ['- Confidence: ' + Math.round(d.confidence * 100) + '%'] : []),
    '- Tests: ' + d.scenarioIds.join(', '),
    ...(d.failedStep ? ['- Failed at: ' + d.failedStep] : []),
    ...(d.summary ? ['', d.summary] : []),
    ...(d.expected ? ['', '## Expected', d.expected] : []),
    ...(d.actual ? ['', '## Actual', d.actual] : []),
    ...(a?.difference ? ['', '## Difference', a.difference] : []),
    ...(d.cause ? ['', '## ' + d.causeTitle, d.cause] : []),
    ...list('Steps to reproduce', d.steps),
    ...(a ? ['', '## Fix', a.fix.summary, ...a.fix.changes.map((x) => '- ' + x)] : []),
    ...list('Acceptance criteria', d.acceptance),
  ].join('\n');
}

/** The defect that explains a scenario's failure in the selected run, if any. */
export const defectFor = (defects: readonly Defect[], scenarioId: string): Defect | undefined =>
  defects.find((d) => d.scenarioIds.includes(scenarioId));

/* ---------- deleting old runs ---------- */
/** Runs offered for deletion, newest first; every run but the latest starts selected. */
export function runCleanupChoices(
  runs: Data['runs'],
  busyRunId: string | null,
): Array<{ id: string; selected: boolean; locked: boolean; latest: boolean }> {
  return runs.map((r, i) => {
    const locked = r.id === busyRunId || r.status === 'running';
    return { id: r.id, latest: i === 0, locked, selected: i > 0 && !locked };
  });
}

/** 1536 → "1.5 KB". */
export function formatBytes(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return (u === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0)) + ' ' + units[u];
}

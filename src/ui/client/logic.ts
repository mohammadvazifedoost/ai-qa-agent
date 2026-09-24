/**
 * Pure dashboard logic: joins between scenarios and run results, list filtering and counts.
 * No DOM access, so it is unit-tested directly (test/ui-logic.test.ts).
 */
import type { Overview } from '../server.js';

export type Data = Overview;
export type ScenarioView = Overview['scenarios'][number];
export type Outcome = NonNullable<Overview['run']>['outcomes'][number];
export type Status = 'passed' | 'failed' | 'flaky' | 'none';

export interface View {
  page: string;
  only: 'all' | 'failed' | 'passed' | 'notrun' | 'todo';
  type: string;
  q: string;
}

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const fmtRun = (id: string): string => id.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2');

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
  const rows = all.filter(
    (x) =>
      (!view.page || x.sc.page === view.page) &&
      (only === 'all'
        ? true
        : only === 'failed'
          ? isFailing(x.status)
          : only === 'todo'
            ? !!data.testStates[x.sc.id]
            : only === 'notrun'
              ? x.status === 'none'
              : x.status === 'passed') &&
      (!view.type || x.sc.category === view.type) &&
      (!q || x.sc.id.toLowerCase().includes(q) || x.sc.title.toLowerCase().includes(q)) &&
      // Not-run scenarios show under Not run; elsewhere only your own and ones waiting for a test.
      (!data.run ||
        only === 'notrun' ||
        x.status !== 'none' ||
        x.sc.origin === 'person' ||
        !!data.testStates[x.sc.id]),
  );
  const types = [...new Set(all.map((x) => x.sc.category))].sort();
  return { all, inRun, pages, rows, todo, notRun, notRunWithTest, failed, only, types };
}

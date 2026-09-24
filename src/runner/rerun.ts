import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { runDir } from '../core/paths.js';
import { specPath } from '../generate/playwright.js';
import type { QaContext } from '../pipeline/context.js';
import { loadAllScenarios } from '../scenarios/generate.js';
import { normalizeId } from '../scenarios/manage.js';
import { listTestIds } from '../scenarios/spec-edit.js';
import { TestRunResultSchema, type TestOutcome, type TestRunResult } from './results.js';
import { runTests, type TestFilter } from './run.js';

const log = logger('test');

export type Runner = (
  ctx: QaContext,
  runId: string,
  filter: TestFilter,
  dir?: string,
  signal?: AbortSignal,
) => Promise<TestRunResult>;

const statsOf = (outcomes: readonly TestOutcome[]): TestRunResult['stats'] => ({
  passed: outcomes.filter((o) => o.status === 'passed').length,
  failed: outcomes.filter((o) => o.status === 'failed').length,
  flaky: outcomes.filter((o) => o.status === 'flaky').length,
  skipped: outcomes.filter((o) => o.status === 'skipped').length,
});

/** Replace scenarios' outcomes in a run with fresh ones from running them again, and recount. */
export function mergeRerun(
  target: TestRunResult,
  fresh: readonly TestOutcome[],
  scenarioIds: string | readonly string[],
  at: string,
): TestRunResult {
  const ids = new Set(typeof scenarioIds === 'string' ? [scenarioIds] : scenarioIds);
  const replaced = (o: TestOutcome): boolean => o.scenarioId !== null && ids.has(o.scenarioId);
  const outcomes = [
    ...target.outcomes.filter((o) => !replaced(o)),
    ...fresh.filter(replaced).map((o) => ({ ...o, rerunAt: at })),
  ];
  return { ...target, outcomes, stats: statsOf(outcomes) };
}

export interface ScenarioRun {
  runId: string;
  /** True when the results were merged into an existing run, false when a new run was started. */
  merged: boolean;
  /** Outcomes of the scenarios that ran. */
  outcomes: TestOutcome[];
  /** Requested scenarios Playwright reported no result for. */
  missing: string[];
}

/**
 * Run the tests of some scenarios. With `runId` (a run that has results) their results replace
 * the scenarios' results in that run, keeping the evidence under `<run>/reruns/`; otherwise a new
 * run is started with just these tests.
 */
export async function runScenarioTests(
  ctx: QaContext,
  rawIds: readonly string[],
  opts: { runId?: string; runner?: Runner; signal?: AbortSignal } = {},
): Promise<ScenarioRun> {
  const ids = [...new Set(rawIds.map(normalizeId))];
  if (ids.length === 0) throw new Error('No scenario to run.');
  const runner = opts.runner ?? runTests;
  const scenarios = loadAllScenarios(ctx);
  const specs = new Set<string>();
  for (const id of ids) {
    const scenario = scenarios.find((s) => s.id === id);
    if (!scenario) throw new Error(`Unknown scenario ${id}.`);
    const spec = specPath(ctx, scenario.page);
    if (!fs.existsSync(spec) || !listTestIds(fs.readFileSync(spec, 'utf8')).includes(id)) {
      throw new Error(`${id} has no test yet; create its test first.`);
    }
    specs.add(spec);
  }
  const filter: TestFilter = { scenarioIds: ids, files: [...specs] };
  const label = ids.length === 1 ? ids[0]! : `${ids.length} tests`;
  const ranOf = (res: TestRunResult) => {
    const outcomes = res.outcomes.filter((o) => o.scenarioId !== null && ids.includes(o.scenarioId));
    if (outcomes.length === 0) {
      throw new Error(`${label} did not run: ${res.globalErrors[0] ?? 'Playwright reported no result.'}`);
    }
    return { outcomes, missing: ids.filter((id) => !outcomes.some((o) => o.scenarioId === id)) };
  };

  const targetFile = opts.runId ? path.join(runDir(ctx.paths, opts.runId), 'results.json') : undefined;
  const target = targetFile ? readJson(targetFile, TestRunResultSchema) : undefined;
  if (!target) {
    const record = ctx.state.startRun({ command: 'test', grep: ids.join(' ') });
    try {
      const res = await runner(ctx, record.id, filter, undefined, opts.signal);
      ctx.state.finishRun(record, 'completed');
      return { runId: record.id, merged: false, ...ranOf(res) };
    } catch (err) {
      if (record.status === 'running') ctx.state.finishRun(record, 'failed', (err as Error).message);
      throw err;
    }
  }

  const at = new Date().toISOString();
  const name = `${ids.length === 1 ? ids[0] : 'batch'}_${at.replace(/[:.]/g, '-')}`;
  const res = await runner(
    ctx,
    target.runId,
    filter,
    path.join(runDir(ctx.paths, target.runId), 'reruns', name),
    opts.signal,
  );
  const { outcomes, missing } = ranOf(res);
  const ran = [...new Set(outcomes.map((o) => o.scenarioId!))];
  // Re-read: the run may have changed while the tests ran.
  const merged = mergeRerun(readJson(targetFile!, TestRunResultSchema) ?? target, outcomes, ran, at);
  writeJson(targetFile!, merged);
  log.info(
    `Re-ran ${label} in run ${target.runId}: ${outcomes.map((o) => `${o.scenarioId} ${o.status}`).join(', ')}`,
  );
  return {
    runId: target.runId,
    merged: true,
    outcomes: merged.outcomes.filter((o) => o.scenarioId !== null && ran.includes(o.scenarioId)),
    missing,
  };
}

/** Run one scenario's test; see {@link runScenarioTests}. */
export function runScenarioTest(
  ctx: QaContext,
  id: string,
  opts: { runId?: string; runner?: Runner; signal?: AbortSignal } = {},
): Promise<ScenarioRun> {
  return runScenarioTests(ctx, [id], opts);
}

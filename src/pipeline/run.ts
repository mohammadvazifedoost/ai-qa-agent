import path from 'node:path';
import { analyzeApp } from '../analyze/app.js';
import { fileBugs, FilingSummarySchema, type FilingSummary } from '../bugs/file.js';
import { readJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { rel, runDir } from '../core/paths.js';
import { extractDesign } from '../design/figma.js';
import { generateTests } from '../generate/playwright.js';
import { writeReport } from '../report/report.js';
import { TestRunResultSchema, type TestRunResult } from '../runner/results.js';
import { runTests, type TestFilter } from '../runner/run.js';
import { generateScenarios } from '../scenarios/generate.js';
import type { RunRecord, Stage } from '../state/state.js';
import { TriageResultSchema, type TriageResult } from '../triage/schema.js';
import { triageRun } from '../triage/triage.js';
import type { QaContext } from './context.js';

const log = logger('run');

export interface RunOptions {
  page?: string;
  filter: TestFilter;
  resume?: boolean;
  refresh?: boolean;
  file: boolean;
}

export interface PipelineResult {
  run: RunRecord;
  test: TestRunResult;
  triage: TriageResult;
  filing: FilingSummary;
  report: { markdown: string; html: string };
}

/**
 * The full pipeline: analyze → design → scenarios → generate → test → triage → file → report.
 * Analysis/scenario/test generation are incremental (skipped when inputs are unchanged).
 * Every stage of a run is checkpointed in .qa/state.json; `--resume` continues an unfinished run.
 */
export async function runPipeline(ctx: QaContext, opts: RunOptions): Promise<PipelineResult> {
  const resumable = opts.resume ? ctx.state.resumableRun() : undefined;
  if (opts.resume && !resumable) log.info('No unfinished run to resume; starting a new one');
  const scope: Record<string, string> = {};
  if (opts.page) scope.page = opts.page;
  if (opts.filter.tags) scope.tags = opts.filter.tags.join(',');
  const run = resumable ?? ctx.state.startRun(scope);
  if (resumable) log.info(`Resuming run ${run.id} (completed: ${run.completedStages.join(', ') || 'none'})`);
  else log.info(`Starting run ${run.id}`);
  const dir = runDir(ctx.paths, run.id);

  const stage = async <T>(name: Stage, fn: () => Promise<T>, load?: () => T | undefined): Promise<T> => {
    if (run.completedStages.includes(name) && load) {
      const cached = load();
      if (cached !== undefined) {
        log.info(`[${name}] already completed in this run`);
        return cached;
      }
    }
    log.info(`[${name}]`);
    const value = await fn();
    ctx.state.completeRunStage(run, name);
    return value;
  };

  try {
    await stage('analyze', () => analyzeApp(ctx, { force: opts.refresh }));
    await stage('design', () => extractDesign(ctx, { force: opts.refresh }));
    await stage('scenarios', () => generateScenarios(ctx, { page: opts.page }));
    await stage('generate', () => generateTests(ctx, { page: opts.page }));
    const test = await stage(
      'test',
      () => runTests(ctx, run.id, opts.filter),
      () => readJson(path.join(dir, 'results.json'), TestRunResultSchema),
    );
    const triage = await stage(
      'triage',
      () => triageRun(ctx, test),
      () => readJson(path.join(dir, 'triage.json'), TriageResultSchema),
    );
    const filing = await stage(
      'file',
      () => fileBugs(ctx, test, triage, { enabled: opts.file }),
      () => readJson(path.join(dir, 'filing.json'), FilingSummarySchema),
    );
    const report = await stage('report', async () =>
      writeReport(ctx, test, triage, filing, ctx.ai.totalCostUsd),
    );
    ctx.state.finishRun(run, 'completed');
    log.info(`Report: ${rel(ctx.root, report.markdown)} (and report.html)`);
    return { run, test, triage, filing, report };
  } catch (err) {
    ctx.state.finishRun(run, 'failed', (err as Error).message);
    log.error(
      `Run ${run.id} stopped: ${(err as Error).message}. Fix the cause and use \`ai-qa run --resume\`.`,
    );
    throw err;
  }
}

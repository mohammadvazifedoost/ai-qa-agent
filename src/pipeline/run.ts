import path from 'node:path';
import { analyzeApp } from '../analyze/app.js';
import { FilingSummarySchema, recordPendingBugs, type FilingSummary } from '../bugs/file.js';
import {
  describeChanges,
  detectCodeChanges,
  detectDesignChanges,
  routesToAnalyze,
} from '../changes/detect.js';
import { readJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { rel, runDir } from '../core/paths.js';
import { extractDesign } from '../design/figma.js';
import { generateTests } from '../generate/playwright.js';
import { writeReport } from '../report/report.js';
import { TestRunResultSchema, type TestRunResult } from '../runner/results.js';
import { runTests, type TestFilter } from '../runner/run.js';
import { generateScenarios, loadDesign, pageSlug } from '../scenarios/generate.js';
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
  /** Only new/changed pages (and, with `design`, changed Figma frames). */
  changed?: boolean;
  /** Inspect Figma for changes as part of `changed` (costs Figma MCP calls). */
  design?: boolean;
}

export interface PipelineResult {
  run: RunRecord;
  test: TestRunResult | null;
  triage: TriageResult | null;
  filing: FilingSummary | null;
  report: { markdown: string; html: string } | null;
  /** Set when `changed` found nothing to do. */
  nothingChanged?: boolean;
}

/**
 * The full pipeline: analyze → design → scenarios → generate → test → triage → report.
 * Confirmed defects are recorded as pending; ClickUp tasks are only ever created from the dashboard.
 * Analysis/scenario/test generation are incremental (skipped when inputs are unchanged).
 * Every stage of a run is checkpointed in .qa/state.json; `--resume` continues an unfinished run.
 */
export async function runPipeline(ctx: QaContext, opts: RunOptions): Promise<PipelineResult> {
  const resumable = opts.resume ? ctx.state.resumableRun() : undefined;
  if (opts.resume && !resumable) log.info('No unfinished run to resume; starting a new one');

  // Scope to what changed, before anything else runs (deterministic; the design check is opt-in).
  let pages: string[] | undefined;
  let filter = opts.filter;
  let designChanged = false;
  if (opts.changed && !resumable) {
    const code = detectCodeChanges(ctx);
    const design =
      opts.design && loadDesign(ctx) ? await detectDesignChanges(ctx, loadDesign(ctx)!) : undefined;
    for (const line of describeChanges(code, design)) log.info(line);
    designChanged = !!design && (design.newScreens.length > 0 || design.changedPages.length > 0);
    pages = code.hasModel ? routesToAnalyze(code) : undefined;
    if (code.hasModel && pages!.length === 0 && !designChanged) {
      log.info(
        'Nothing changed — no tests to run. Use `ai-qa-agent run` (without --changed) for a full run.',
      );
      return {
        run: ctx.state.latestRun()!,
        test: null,
        triage: null,
        filing: null,
        report: null,
        nothingChanged: true,
      };
    }
    if (pages && pages.length) filter = { ...filter, files: pages.map((r) => `${pageSlug(r)}.spec.ts`) };
  }

  const scope: Record<string, string> = {};
  if (opts.page) scope.page = opts.page;
  if (pages) scope.pages = pages.join(',');
  if (opts.filter.tags) scope.tags = opts.filter.tags.join(',');
  const run = resumable ?? ctx.state.startRun(scope);
  if (resumable) {
    log.info(`Resuming run ${run.id} (completed: ${run.completedStages.join(', ') || 'none'})`);
    if (run.scope.pages) pages = run.scope.pages.split(',');
    if (pages) filter = { ...filter, files: pages.map((r) => `${pageSlug(r)}.spec.ts`) };
  } else log.info(`Starting run ${run.id}`);
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
    await stage('analyze', () => analyzeApp(ctx, { force: opts.refresh, routes: pages }));
    await stage('design', () => extractDesign(ctx, { force: opts.refresh || designChanged }));
    await stage('scenarios', () => generateScenarios(ctx, { page: opts.page, pages }));
    await stage('generate', () => generateTests(ctx, { page: opts.page, pages }));
    const test = await stage(
      'test',
      () => runTests(ctx, run.id, filter),
      () => readJson(path.join(dir, 'results.json'), TestRunResultSchema),
    );
    const triage = await stage(
      'triage',
      () => triageRun(ctx, test),
      () => readJson(path.join(dir, 'triage.json'), TriageResultSchema),
    );
    const filing = await stage(
      'file',
      () => recordPendingBugs(test, triage),
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
      `Run ${run.id} stopped: ${(err as Error).message}. Fix the cause and use \`ai-qa-agent run --resume\`.`,
    );
    throw err;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { runDir as runDirFor, rel } from '../core/paths.js';
import { run } from '../core/process.js';
import type { QaContext } from '../pipeline/context.js';
import { playwrightCli, writePlaywrightConfig } from './playwright-config.js';
import { collectOutcomes, PwReportSchema, stripAnsi, type TestRunResult } from './results.js';
export type { TestRunResult } from './results.js';
import { ensureApp } from './server.js';

const log = logger('test');

export interface TestFilter {
  /** Spec files (absolute or relative to .qa/tests). */
  files?: string[];
  /** Tags such as `@visual`, `@checkout`; combined with OR. */
  tags?: string[];
  /** Limit to scenario ids. */
  scenarioIds?: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildGrep(filter: TestFilter): string | undefined {
  const parts = [
    ...(filter.tags ?? []).map((t) => `${escapeRe(t.startsWith('@') ? t : `@${t}`)}\\b`),
    ...(filter.scenarioIds ?? []).map((id) => `^${escapeRe(id)}\\b|\\s${escapeRe(id)}:`),
  ];
  return parts.length ? parts.join('|') : undefined;
}

/**
 * Playwright treats file arguments as regular expressions, so absolute Windows paths (backslashes,
 * drive colons) never match. Pass the path relative to the test dir, forward slashes, regex-escaped.
 */
export function fileFilterArg(testsDir: string, file: string): string {
  const relative = path.isAbsolute(file) ? path.relative(testsDir, file) : file;
  return escapeRe(relative.split(path.sep).join('/'));
}

export function playwrightEnv(ctx: QaContext, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AI_QA_DIR: ctx.paths.qaDir,
    AI_QA_VISUAL: JSON.stringify(ctx.config.visual),
    FORCE_COLOR: '0',
    ...extra,
  };
}

/**
 * Run Playwright for the given filter, starting/stopping the app as needed. Evidence and
 * results.json go to the run's directory, or to `dir` when given (a single-test re-run).
 */
export async function runTests(
  ctx: QaContext,
  runId: string,
  filter: TestFilter = {},
  dir: string = runDirFor(ctx.paths, runId),
  signal?: AbortSignal,
): Promise<TestRunResult> {
  ensureDir(dir);
  const specs = fs.existsSync(ctx.paths.testsDir)
    ? fs.readdirSync(ctx.paths.testsDir).filter((f) => f.endsWith('.spec.ts'))
    : [];
  if (specs.length === 0) throw new Error('No tests in .qa/tests. Run `ai-qa-agent generate` first.');

  writePlaywrightConfig(ctx.paths, ctx.config);
  const app = await ensureApp(ctx.root, ctx.config, path.join(dir, 'logs', 'app-server.log'));
  const jsonReport = path.join(dir, 'playwright-report.json');
  try {
    const args = [playwrightCli(), 'test', '--config', ctx.paths.playwrightConfig];
    const grep = buildGrep(filter);
    if (grep) args.push('--grep', grep);
    for (const f of filter.files ?? []) args.push(fileFilterArg(ctx.paths.testsDir, f));
    log.info(
      `Running Playwright${grep ? ` (grep ${grep})` : ''}${filter.files?.length ? ` on ${filter.files.join(', ')}` : ''}`,
    );
    const proc = await run(process.execPath, args, {
      cwd: ctx.paths.qaDir,
      env: playwrightEnv(ctx, {
        AI_QA_OUTPUT_DIR: path.join(dir, 'playwright'),
        AI_QA_JSON_REPORT: jsonReport,
      }),
      onStdoutLine: (l) => log.debug(stripAnsi(l)),
      signal,
    });
    fs.writeFileSync(
      path.join(dir, 'logs', 'playwright-stdout.log'),
      stripAnsi(proc.stdout + '\n' + proc.stderr),
    );
    const report = readJson(jsonReport, PwReportSchema);
    if (!report) {
      throw new Error(
        `Playwright produced no JSON report (exit ${proc.code}). stderr: ${stripAnsi(proc.stderr).slice(0, 2000)}`,
      );
    }
    const outcomes = collectOutcomes(report, dir, ctx.root, ctx.paths.testsDir);
    const stats = {
      passed: outcomes.filter((o) => o.status === 'passed').length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
      flaky: outcomes.filter((o) => o.status === 'flaky').length,
      skipped: outcomes.filter((o) => o.status === 'skipped').length,
    };
    const globalErrors = report.errors.map((e) => stripAnsi(e.message ?? e.stack ?? 'unknown error'));
    const result: TestRunResult = { runId, runDir: dir, outcomes, globalErrors, exitCode: proc.code, stats };
    writeJson(path.join(dir, 'results.json'), result);
    log.info(
      `Tests: ${stats.passed} passed, ${stats.failed} failed, ${stats.flaky} flaky, ${stats.skipped} skipped — evidence in ${rel(ctx.root, dir)}`,
    );
    for (const e of globalErrors) log.error(`Playwright error: ${e.split('\n')[0]}`);
    return result;
  } finally {
    app.stop();
  }
}

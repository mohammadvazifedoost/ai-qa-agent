import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, writeJson } from '../core/fs.js';
import { rel } from '../core/paths.js';
import { environment, evidenceFor, renderBugMarkdown } from '../bugs/report.js';
import type { FilingSummary } from '../bugs/file.js';
import type { QaContext } from '../pipeline/context.js';
import type { TestRunResult } from '../runner/results.js';
import { describeTarget } from '../runner/server.js';
import { loadAllScenarios } from '../scenarios/generate.js';
import type { TriageResult } from '../triage/schema.js';
import { buildQaReport, type QaReport } from './model.js';
import { renderHtml, renderMarkdown } from './render.js';

export interface ReportFiles {
  markdown: string;
  html: string;
  json: string;
  bugsDir: string;
}

/** Run-level files worth linking from the report, when they exist. */
function runFiles(ctx: QaContext, run: TestRunResult): Array<{ label: string; path: string }> {
  return [
    ['Playwright JSON report', 'playwright-report.json'],
    ['Playwright console output', 'logs/playwright-stdout.log'],
    ['Application server log', 'logs/app-server.log'],
    ['Triage results', 'triage.json'],
  ]
    .map(([label, file]) => ({ label: label!, abs: path.join(run.runDir, file!) }))
    .filter((f) => fs.existsSync(f.abs))
    .map((f) => ({ label: f.label, path: rel(ctx.root, f.abs) }));
}

/** The structured report of a run, from the files on disk (no AI). */
export function buildReport(
  ctx: QaContext,
  run: TestRunResult,
  triage: TriageResult | null,
  filing: FilingSummary | null,
  aiCostUsd: number,
): QaReport {
  return buildQaReport({
    run,
    scenarios: loadAllScenarios(ctx),
    triage,
    filing,
    root: ctx.root,
    project: ctx.config.project.name,
    target: run.app ? describeTarget(run.app) : ctx.config.app.baseUrl,
    generatedAt: new Date().toISOString(),
    aiCostUsd,
    runFiles: runFiles(ctx, run),
  });
}

export function writeReport(
  ctx: QaContext,
  run: TestRunResult,
  triage: TriageResult | null,
  filing: FilingSummary | null,
  aiCostUsd: number,
): ReportFiles {
  const dir = path.join(ctx.paths.reportsDir, run.runId);
  const bugsDir = path.join(dir, 'bugs');
  ensureDir(bugsDir);
  const report = buildReport(ctx, run, triage, filing, aiCostUsd);
  // Links in the report are relative to its own folder.
  const base = rel(ctx.root, dir);
  const markdown = path.join(dir, 'report.md');
  const html = path.join(dir, 'report.html');
  const json = path.join(dir, 'report.json');
  fs.writeFileSync(markdown, renderMarkdown(report, base));
  fs.writeFileSync(html, renderHtml(report, base));
  writeJson(json, report);
  const env = environment(ctx, run.runId, run.app);
  for (const issue of triage?.issues ?? []) {
    fs.writeFileSync(
      path.join(bugsDir, `${issue.id}.md`),
      `# ${issue.id}: ${issue.bug.title}\n\n${renderBugMarkdown(issue, env, evidenceFor(issue, run))}\n`,
    );
  }
  if (triage) fs.writeFileSync(path.join(dir, 'bugs.json'), JSON.stringify(triage.issues, null, 2));
  // `latest.md` sits one folder up; its links point into the run's folder.
  fs.writeFileSync(
    path.join(ctx.paths.reportsDir, 'latest.md'),
    renderMarkdown(report, rel(ctx.root, ctx.paths.reportsDir)),
  );
  return { markdown, html, json, bugsDir };
}

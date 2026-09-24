import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { ClickUpClient, PRIORITY, type Fetch } from '../integrations/clickup.js';
import { runDir } from '../core/paths.js';
import type { QaContext } from '../pipeline/context.js';
import type { TestRunResult } from '../runner/results.js';
import type { FiledBug } from '../state/state.js';
import { TriageResultSchema, type Issue, type TriageResult } from '../triage/schema.js';
import { environment, evidenceFor, renderBugMarkdown } from './report.js';

const log = logger('file');

export const FilingResultSchema = z.object({
  issueId: z.string(),
  action: z.enum(['created', 'commented', 'skipped', 'failed']),
  reason: z.string().optional(),
  taskId: z.string().optional(),
  url: z.string().optional(),
  attachments: z.array(z.string()),
  filedAt: z.string().optional(),
});
export type FilingResult = z.infer<typeof FilingResultSchema>;

export const FilingSummarySchema = z.object({
  status: z.enum(['filed', 'pending', 'nothing-to-file', 'not-configured', 'missing-token', 'disabled']),
  message: z.string(),
  results: z.array(FilingResultSchema),
});
export type FilingSummary = z.infer<typeof FilingSummarySchema>;

export class FilingUnavailable extends Error {
  constructor(
    readonly status: 'not-configured' | 'missing-token',
    message: string,
  ) {
    super(message);
  }
}

/** Source files named in a suspected root cause, without line numbers. */
export function rootCauseFiles(text: string): string[] {
  const matches =
    text.match(/[\w@./-]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|sass|less|vue|svelte|astro|html)\b/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/^\.\//, '')))].sort();
}

/**
 * Find a bug filed in an earlier run for the same defect: either the same scenarios exposed it
 * (fingerprint), or a different test found the same classification/category pointing at the same
 * source files (e.g. a new page's button failing the same design tokens as every other button).
 */
export function previouslyFiled(ctx: QaContext, issue: Issue): FiledBug | undefined {
  const bugs = Object.values(ctx.state.data.bugs);
  const exact = bugs.find((b) => b.fingerprint === issue.fingerprint);
  if (exact) return exact;
  const files = rootCauseFiles(issue.bug.suspectedRootCause);
  if (files.length === 0) return undefined;
  return bugs.find(
    (b) =>
      b.classification === issue.classification &&
      b.category === issue.bug.category &&
      b.files.some((f) => files.includes(f)),
  );
}

/** Bugs filed before root-cause files were recorded: fill them in from their run's triage.json. */
function backfillBugRecords(ctx: QaContext): void {
  let changed = false;
  for (const bug of Object.values(ctx.state.data.bugs)) {
    if (bug.classification) continue;
    const triage = readJson(
      path.join(runDir(ctx.paths, bug.firstSeenRun), 'triage.json'),
      TriageResultSchema,
    );
    const issue = triage?.issues.find((i) => i.fingerprint === bug.fingerprint);
    if (!issue) continue;
    bug.classification = issue.classification;
    bug.category = issue.bug.category;
    bug.files = rootCauseFiles(issue.bug.suspectedRootCause);
    changed = true;
  }
  if (changed) ctx.state.save();
}

function filingFile(run: TestRunResult): string {
  return path.join(run.runDir, 'filing.json');
}

export function loadFiling(run: TestRunResult): FilingSummary | undefined {
  return readJson(filingFile(run), FilingSummarySchema);
}

/** Merge results into the run's filing.json (later results for the same issue replace earlier ones). */
export function recordFiling(
  run: TestRunResult,
  results: FilingResult[],
  status: FilingSummary['status'],
  message: string,
): FilingSummary {
  const existing = loadFiling(run)?.results ?? [];
  const merged = [...existing.filter((e) => !results.some((r) => r.issueId === e.issueId)), ...results];
  const summary: FilingSummary = { status, message, results: merged };
  writeJson(filingFile(run), summary);
  return summary;
}

function clickupClient(
  ctx: QaContext,
  fetchImpl?: Fetch,
): { client: ClickUpClient; cfg: NonNullable<QaContext['config']['clickup']> } {
  const cfg = ctx.config.clickup;
  if (!cfg) throw new FilingUnavailable('not-configured', 'No clickup section in .qa/config.ts');
  const token = process.env[cfg.tokenEnv];
  if (!token) throw new FilingUnavailable('missing-token', `Environment variable ${cfg.tokenEnv} is not set`);
  return { client: new ClickUpClient(token, fetchImpl), cfg };
}

/**
 * File the given issues in ClickUp (create task + attach evidence, or comment on the task filed
 * in an earlier run). Only called from the dashboard's "Log in ClickUp" button.
 */
export async function fileIssues(
  ctx: QaContext,
  run: TestRunResult,
  issues: Issue[],
  opts: { fetchImpl?: Fetch; extraTags?: string[]; force?: boolean } = {},
): Promise<FilingResult[]> {
  const { client, cfg } = clickupClient(ctx, opts.fetchImpl);
  const list = await client.getList(cfg.listId);
  log.info(`Filing ${issues.length} defect(s) into ClickUp list "${list.name}" (${list.id})`);
  const env = environment(ctx, run.runId);
  const results: FilingResult[] = [];
  backfillBugRecords(ctx);
  for (const issue of issues) {
    // `force` = a person explicitly asked for a task; always create one, even if a similar
    // defect was filed before.
    const prior = opts.force ? undefined : previouslyFiled(ctx, issue);
    const filedAt = new Date().toISOString();
    try {
      if (prior?.taskId) {
        await client.addComment(
          prior.taskId,
          `ai-qa run ${run.runId}: still failing (${issue.scenarioIds.join(', ')}) — ${issue.bug.title}`,
        );
        ctx.state.data.bugs[prior.fingerprint]!.lastSeenRun = run.runId;
        ctx.state.save();
        results.push({
          issueId: issue.id,
          action: 'commented',
          taskId: prior.taskId,
          url: prior.url,
          attachments: [],
          reason: 'already filed in an earlier run',
          filedAt,
        });
        log.info(`${issue.id}: already filed as ${prior.url ?? prior.taskId}; added a comment`);
        continue;
      }
      const evidence = evidenceFor(issue, run);
      const task = await client.createTask(cfg.listId, {
        name: `[ai-qa] ${issue.bug.title}`,
        markdown: renderBugMarkdown(issue, env, evidence),
        tags: [
          ...cfg.tags,
          issue.classification === 'DESIGN_MISMATCH' ? 'design-mismatch' : 'bug',
          issue.bug.category,
          ...(opts.extraTags ?? []),
        ],
        priority: PRIORITY[issue.bug.severity],
        status: cfg.status,
      });
      ctx.state.data.bugs[issue.fingerprint] = {
        fingerprint: issue.fingerprint,
        title: issue.bug.title,
        taskId: task.id,
        url: task.url,
        firstSeenRun: run.runId,
        lastSeenRun: run.runId,
        classification: issue.classification,
        category: issue.bug.category,
        files: rootCauseFiles(issue.bug.suspectedRootCause),
      };
      ctx.state.save();
      const attachments: string[] = [];
      if (cfg.attachEvidence) {
        // Evidence of the first failing test (screenshot, video, trace) plus any design diff images.
        const e = evidence[0];
        const files = [e?.screenshot, e?.video, e?.trace, ...(e?.design ?? [])].filter(
          (f): f is string => !!f,
        );
        for (const f of files) {
          const abs = path.join(ctx.root, f);
          if (!fs.existsSync(abs)) continue;
          try {
            await client.uploadAttachment(task.id, abs);
            attachments.push(f);
          } catch (err) {
            log.warn(`${issue.id}: could not attach ${f}: ${(err as Error).message}`);
          }
        }
      }
      results.push({
        issueId: issue.id,
        action: 'created',
        taskId: task.id,
        url: task.url,
        attachments,
        filedAt,
      });
      log.info(`${issue.id}: created ${task.url ?? task.id} with ${attachments.length} attachment(s)`);
    } catch (err) {
      results.push({
        issueId: issue.id,
        action: 'failed',
        reason: (err as Error).message,
        attachments: [],
        filedAt,
      });
      log.error(`${issue.id}: filing failed: ${(err as Error).message}`);
    }
  }
  return results;
}

/**
 * Pipeline stage: never files anything. It records the confirmed defects as pending so the report
 * and the dashboard can show them; a person creates the ClickUp task with the dashboard button.
 */
export async function recordPendingBugs(run: TestRunResult, triage: TriageResult): Promise<FilingSummary> {
  const fileable = triage.issues.filter((i) => i.fileable);
  const results: FilingResult[] = fileable.map((i) => ({
    issueId: i.id,
    action: 'skipped',
    reason: 'waiting for a person to log it from the dashboard',
    attachments: [],
  }));
  const message =
    fileable.length === 0
      ? 'No confirmed defects'
      : `${fileable.length} confirmed defect(s) — open \`ai-qa ui\` and use "Log in ClickUp" on the ones you want tracked`;
  const summary = recordFiling(run, results, fileable.length === 0 ? 'nothing-to-file' : 'pending', message);
  log.info(message);
  return summary;
}

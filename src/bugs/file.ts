import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { ClickUpClient, PRIORITY, type Fetch } from '../integrations/clickup.js';
import type { QaContext } from '../pipeline/context.js';
import type { TestRunResult } from '../runner/results.js';
import type { Issue, TriageResult } from '../triage/schema.js';
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
  status: z.enum(['filed', 'not-configured', 'missing-token', 'disabled', 'nothing-to-file']),
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

/** Find a bug filed in an earlier run for the same scenarios. */
function previouslyFiled(
  ctx: QaContext,
  issue: Issue,
): { fingerprint: string; taskId?: string; url?: string } | undefined {
  return Object.values(ctx.state.data.bugs).find((b) => b.fingerprint === issue.fingerprint);
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
 * in an earlier run). Used by the pipeline (`run --file`) and by the UI's "Log in ClickUp" button.
 */
export async function fileIssues(
  ctx: QaContext,
  run: TestRunResult,
  issues: Issue[],
  opts: { fetchImpl?: Fetch } = {},
): Promise<FilingResult[]> {
  const { client, cfg } = clickupClient(ctx, opts.fetchImpl);
  const list = await client.getList(cfg.listId);
  log.info(`Filing ${issues.length} defect(s) into ClickUp list "${list.name}" (${list.id})`);
  const env = environment(ctx, run.runId);
  const results: FilingResult[] = [];
  for (const issue of issues) {
    const prior = previouslyFiled(ctx, issue);
    const filedAt = new Date().toISOString();
    try {
      if (prior?.taskId) {
        await client.addComment(
          prior.taskId,
          `ai-qa run ${run.runId}: still failing (${issue.scenarioIds.join(', ')}).`,
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

/** Pipeline stage: files all fileable issues when enabled, otherwise records why nothing was filed. */
export async function fileBugs(
  ctx: QaContext,
  run: TestRunResult,
  triage: TriageResult,
  opts: { enabled: boolean; fetchImpl?: Fetch },
): Promise<FilingSummary> {
  const fileable = triage.issues.filter((i) => i.fileable);
  const skippedAll = (reason: string): FilingResult[] =>
    fileable.map((i) => ({ issueId: i.id, action: 'skipped', reason, attachments: [] }));
  const done = (status: FilingSummary['status'], message: string, results: FilingResult[]): FilingSummary => {
    const summary = recordFiling(run, results, status, message);
    log.info(message);
    return summary;
  };
  if (fileable.length === 0) return done('nothing-to-file', 'No confirmed defects to file', []);
  if (!opts.enabled) {
    return done(
      'disabled',
      `${fileable.length} confirmed defect(s) ready to file — review them in \`ai-qa ui\` or rerun with \`--file\``,
      skippedAll('automatic filing is off'),
    );
  }
  try {
    const results = await fileIssues(ctx, run, fileable, opts);
    const created = results.filter((r) => r.action === 'created').length;
    return done('filed', `ClickUp: ${created} created, ${results.length - created} other`, results);
  } catch (err) {
    if (err instanceof FilingUnavailable) {
      return done(
        err.status,
        `${fileable.length} confirmed defect(s) not filed: ${err.message}`,
        skippedAll(err.message),
      );
    }
    throw err;
  }
}

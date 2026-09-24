import path from 'node:path';
import { z } from 'zod';
import { writeJson } from '../core/fs.js';
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
});
export type FilingResult = z.infer<typeof FilingResultSchema>;

export const FilingSummarySchema = z.object({
  status: z.enum(['filed', 'not-configured', 'missing-token', 'disabled', 'nothing-to-file']),
  message: z.string(),
  results: z.array(FilingResultSchema),
});
export type FilingSummary = z.infer<typeof FilingSummarySchema>;

/** Find a bug filed in an earlier run for any of the same scenarios. */
function previouslyFiled(
  ctx: QaContext,
  issue: Issue,
): { fingerprint: string; taskId?: string; url?: string } | undefined {
  for (const bug of Object.values(ctx.state.data.bugs)) {
    if (bug.fingerprint === issue.fingerprint) return bug;
  }
  return undefined;
}

export async function fileBugs(
  ctx: QaContext,
  run: TestRunResult,
  triage: TriageResult,
  opts: { enabled: boolean; fetchImpl?: Fetch },
): Promise<FilingSummary> {
  const fileable = triage.issues.filter((i) => i.fileable);
  const done = (summary: FilingSummary): FilingSummary => {
    writeJson(path.join(run.runDir, 'filing.json'), summary);
    log.info(summary.message);
    return summary;
  };
  const skippedAll = (reason: string): FilingResult[] =>
    fileable.map((i) => ({ issueId: i.id, action: 'skipped', reason, attachments: [] }));

  if (fileable.length === 0)
    return done({ status: 'nothing-to-file', message: 'No confirmed defects to file', results: [] });
  if (!opts.enabled)
    return done({
      status: 'disabled',
      message: 'Bug filing disabled (--no-file)',
      results: skippedAll('filing disabled'),
    });
  const cfg = ctx.config.clickup;
  if (!cfg) {
    return done({
      status: 'not-configured',
      message: `${fileable.length} confirmed defect(s) not filed: no clickup section in .qa/config.ts`,
      results: skippedAll('ClickUp not configured'),
    });
  }
  const token = process.env[cfg.tokenEnv];
  if (!token) {
    return done({
      status: 'missing-token',
      message: `${fileable.length} confirmed defect(s) not filed: environment variable ${cfg.tokenEnv} is not set`,
      results: skippedAll(`${cfg.tokenEnv} not set`),
    });
  }

  const client = new ClickUpClient(token, opts.fetchImpl);
  const list = await client.getList(cfg.listId);
  log.info(`Filing ${fileable.length} defect(s) into ClickUp list "${list.name}" (${list.id})`);
  const env = environment(ctx, run.runId);
  const results: FilingResult[] = [];

  for (const issue of fileable) {
    const prior = previouslyFiled(ctx, issue);
    try {
      if (prior?.taskId) {
        await client.addComment(
          prior.taskId,
          `ai-qa run ${run.runId}: still failing (${issue.scenarioIds.join(', ')}).`,
        );
        const record = ctx.state.data.bugs[prior.fingerprint]!;
        record.lastSeenRun = run.runId;
        ctx.state.save();
        results.push({
          issueId: issue.id,
          action: 'commented',
          taskId: prior.taskId,
          url: prior.url,
          attachments: [],
          reason: 'already filed in an earlier run',
        });
        log.info(`${issue.id}: already filed as ${prior.url ?? prior.taskId}; added a comment`);
        continue;
      }
      const evidence = evidenceFor(issue, run);
      const markdown = renderBugMarkdown(issue, env, evidence);
      const task = await client.createTask(cfg.listId, {
        name: `[ai-qa] ${issue.bug.title}`,
        markdown,
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
          try {
            await client.uploadAttachment(task.id, path.join(ctx.root, f));
            attachments.push(f);
          } catch (err) {
            log.warn(`${issue.id}: could not attach ${f}: ${(err as Error).message}`);
          }
        }
      }
      results.push({ issueId: issue.id, action: 'created', taskId: task.id, url: task.url, attachments });
      log.info(`${issue.id}: created ${task.url ?? task.id} with ${attachments.length} attachment(s)`);
    } catch (err) {
      results.push({ issueId: issue.id, action: 'failed', reason: (err as Error).message, attachments: [] });
      log.error(`${issue.id}: filing failed: ${(err as Error).message}`);
    }
  }
  const created = results.filter((r) => r.action === 'created').length;
  return done({
    status: 'filed',
    message: `ClickUp: ${created} created, ${results.length - created} other`,
    results,
  });
}

/**
 * Bug-fix plans: turn the failed tests of a run into a document developers follow to fix the bugs
 * behind them, written into the host project (default `docs/bug-fix-plan/<run-id>-plan.md`). The AI reads the
 * source code to decide which failures are product bugs and how to fix them; what goes in, the
 * order and the Markdown are decided by code. No other analysis step is needed first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_SYSTEM, projectRules } from '../ai/context.js';
import { readJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { rel, runDir } from '../core/paths.js';
import type { QaContext } from '../pipeline/context.js';
import { TestRunResultSchema, type TestOutcome, type TestRunResult } from '../runner/results.js';
import { loadAllScenarios } from '../scenarios/generate.js';
import type { Scenario } from '../scenarios/schema.js';

const log = logger('plan');

/** A reason the plan cannot be made that the user can fix (no AI was called). */
export class PlanRefused extends Error {}

const failing = (o: TestOutcome): boolean => o.status === 'failed' || o.status === 'flaky';

/** One failed test as the AI sees it. */
export interface FailureInput {
  key: string;
  scenarioId: string | null;
  title: string;
  project: string;
  status: 'failed' | 'flaky';
  error: string | null;
  /** Project-relative path of the final screenshot, if any. */
  screenshot: string | null;
  scenario: Pick<Scenario, 'page' | 'category' | 'priority' | 'steps' | 'expectedResults'> | null;
}

export function collectFailures(run: TestRunResult, scenarios: readonly Scenario[]): FailureInput[] {
  return run.outcomes.filter(failing).map((o) => {
    const s = scenarios.find((x) => x.id === o.scenarioId);
    return {
      key: o.key,
      scenarioId: o.scenarioId,
      title: o.title,
      project: o.project,
      status: o.status as 'failed' | 'flaky',
      error: o.error?.message.slice(0, 1500) ?? null,
      screenshot: o.artifacts.screenshots[0] ?? null,
      scenario: s
        ? {
            page: s.page,
            category: s.category,
            priority: s.priority,
            steps: s.steps,
            expectedResults: s.expectedResults,
          }
        : null,
    };
  });
}

export const PlanBugSchema = z.object({
  id: z.string().describe('BUG-1, BUG-2, ...'),
  title: z.string().describe('Short, specific, user-facing: what is wrong where'),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  page: z.string().describe('Route(s) where it shows'),
  failureKeys: z.array(z.string()).min(1).describe('Keys of the failed tests this bug explains'),
  expected: z.string().describe('The correct behaviour'),
  actual: z.string().describe('What happens instead, with values'),
  rootCause: z.string().describe('Why the bug happens, in plain words for a developer'),
  locations: z.array(z.string()).describe('Where the cause is, as "path/to/file.ts:line"'),
  fix: z.string().describe('What to change, in plain words'),
  codeHint: z.string().nullable().describe('A short code snippet showing the change, or null'),
  risks: z.string().describe('Side effects and other places that may break'),
  verify: z.array(z.string()).describe('Manual checks that show the bug is fixed'),
  effort: z.enum(['S', 'M', 'L']),
  relatedIds: z.array(z.string()).describe('Bugs with the same cause or to fix together'),
});
export type PlanBug = z.infer<typeof PlanBugSchema>;

export const PlanSchema = z.object({
  bugs: z.array(PlanBugSchema),
  order: z.array(z.string()).describe('Bug ids in the order they should be fixed'),
  notIncluded: z.array(
    z.object({
      failureKey: z.string(),
      kind: z.enum(['TEST_BUG', 'FLAKY', 'ENVIRONMENT', 'UNKNOWN']),
      reason: z.string(),
    }),
  ),
  notes: z.array(z.string()).describe('Cross-cutting remarks for the team; may be empty'),
});
export type Plan = z.infer<typeof PlanSchema>;

export interface NotIncluded {
  key: string;
  title: string;
  kind: string;
  reason: string;
}

export interface ReconciledPlan {
  bugs: PlanBug[];
  notIncluded: NotIncluded[];
  notes: string[];
}

/**
 * Trust the AI only where it is consistent with the run: a bug keeps the failures of this run it
 * explains (first bug wins), bugs explaining nothing are dropped, the order is the AI's for known
 * bugs, and every failure not explained by a bug is listed as not included.
 */
export function reconcilePlan(plan: Plan, failures: readonly FailureInput[]): ReconciledPlan {
  const known = new Map(failures.map((f) => [f.key, f]));
  const claimed = new Set<string>();
  const bugs = new Map<string, PlanBug>();
  for (const b of plan.bugs) {
    const keys = [...new Set(b.failureKeys)].filter((k) => known.has(k) && !claimed.has(k));
    if (keys.length === 0 || bugs.has(b.id)) {
      log.warn(
        `Dropping ${b.id} "${b.title}": ${bugs.has(b.id) ? 'duplicate id' : 'it explains no failed test of this run'}`,
      );
      continue;
    }
    for (const k of keys) claimed.add(k);
    bugs.set(b.id, { ...b, failureKeys: keys });
  }
  const order = [...new Set(plan.order.filter((id) => bugs.has(id)))];
  for (const id of bugs.keys()) if (!order.includes(id)) order.push(id);

  const notIncluded: NotIncluded[] = [];
  const explained = new Set<string>();
  for (const n of plan.notIncluded) {
    const f = known.get(n.failureKey);
    if (!f || claimed.has(f.key) || explained.has(f.key)) continue;
    explained.add(f.key);
    notIncluded.push({ key: f.key, title: f.title, kind: n.kind, reason: n.reason });
  }
  for (const f of failures) {
    if (!claimed.has(f.key) && !explained.has(f.key)) {
      notIncluded.push({
        key: f.key,
        title: f.title,
        kind: 'UNKNOWN',
        reason: 'The AI did not classify this failure.',
      });
    }
  }
  return { bugs: order.map((id) => bugs.get(id)!), notIncluded, notes: plan.notes };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const fmtRun = (id: string): string => id.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2');
const filesOf = (b: PlanBug): string[] => [
  ...new Set(b.locations.map((l) => l.replace(/:\d+(?::\d+)?$/, ''))),
];

export function renderPlan(args: {
  runId: string;
  baseUrl: string;
  generatedAt: string;
  plan: ReconciledPlan;
  failures: readonly FailureInput[];
  /** Folder of the plan file relative to the project root, for evidence links. */
  evidenceBase: string;
}): string {
  const { bugs, notIncluded, notes } = args.plan;
  const byKey = new Map(args.failures.map((f) => [f.key, f]));
  const n = new Map(bugs.map((b, k) => [b.id, k + 1]));
  const base = args.evidenceBase.split(path.sep).join('/');
  const out: string[] = [];
  out.push(`# Bug-fix plan: run ${fmtRun(args.runId)}`, '');
  out.push(
    `Generated by AI QA Agent on ${args.generatedAt.slice(0, 10)} from run \`${args.runId}\` against ${args.baseUrl}. ` +
      `${bugs.length} bug${bugs.length === 1 ? '' : 's'} to fix` +
      (notIncluded.length
        ? `; ${notIncluded.length} failed test${notIncluded.length === 1 ? '' : 's'} not included (see the end).`
        : '.'),
    '',
    'The fixes below are suggestions from reading the code; review each one before applying it.',
    '',
  );

  out.push('## Summary', '', '| # | Bug | Severity | Page | Effort | Files |', '|---|---|---|---|---|---|');
  for (const [k, b] of bugs.entries()) {
    const files = filesOf(b);
    out.push(
      `| ${k + 1} | [${cell(b.title)}](#bug-${k + 1}) | ${b.severity} | ${cell(b.page)} | ${b.effort} | ` +
        `${files.length ? files.map((f) => `\`${cell(f)}\``).join(', ') : '—'} |`,
    );
  }
  out.push('');
  if (notes.length) out.push('## Notes', '', ...notes.map((x) => `- ${x}`), '');

  for (const [k, b] of bugs.entries()) {
    const fails = b.failureKeys.map((key) => byKey.get(key)).filter((f): f is FailureInput => !!f);
    const scenarioIds = [...new Set(fails.map((f) => f.scenarioId).filter((id): id is string => !!id))];
    const steps = fails.find((f) => f.scenario?.steps.length)?.scenario?.steps ?? [];
    out.push(`<a id="bug-${k + 1}"></a>`, '', `## ${k + 1}. ${b.title}`, '');
    out.push(
      `**Severity:** ${b.severity} · **Page:** ${b.page} · **Effort:** ${b.effort} · ` +
        `**Tests:** ${scenarioIds.join(', ') || fails.map((f) => f.key).join(', ')}`,
      '',
    );
    out.push('### What is wrong', '', `- **Expected:** ${b.expected}`, `- **Actual:** ${b.actual}`, '');
    if (steps.length) out.push('### Steps to reproduce', '', ...steps.map((s, j) => `${j + 1}. ${s}`), '');
    out.push('### Root cause', '', b.rootCause, '');
    if (b.locations.length) out.push(`Where: ${b.locations.map((l) => `\`${l}\``).join(', ')}`, '');
    out.push('### Proposed fix', '', b.fix, '');
    if (b.codeHint) out.push('```', b.codeHint.trim(), '```', '');
    const files = filesOf(b);
    if (files.length) out.push('### Files to change', '', ...files.map((f) => `- \`${f}\``), '');
    if (b.risks) out.push('### Risks', '', b.risks, '');
    out.push(
      '### How to verify',
      '',
      ...b.verify.map((v) => `- ${v}`),
      ...scenarioIds.map((id) => `- Run its test: \`npx ai-qa-agent test --grep ${id}\``),
      '',
    );
    const related = b.relatedIds.filter((id) => n.has(id) && id !== b.id);
    if (related.length) {
      out.push(
        '### Related',
        '',
        ...related.map((id) => `- #${n.get(id)} ${bugs[n.get(id)! - 1]!.title}`),
        '',
      );
    }
    const shots = fails.filter((f) => f.screenshot);
    if (shots.length) {
      out.push(
        '### Evidence',
        '',
        ...shots.map(
          (f) => `- [${f.scenarioId ?? f.title} screenshot](${path.posix.relative(base, f.screenshot!)})`,
        ),
        '',
      );
    }
  }

  if (notIncluded.length) {
    out.push(
      '## Not included',
      '',
      'Failed tests that are not product bugs (or could not be classified), so they have no fix plan here.',
      '',
      '| Test | Title | Kind | Reason |',
      '|---|---|---|---|',
      ...notIncluded.map((x) => `| ${x.key} | ${cell(x.title)} | ${x.kind} | ${cell(x.reason)} |`),
      '',
    );
  }
  return out.join('\n');
}

function buildPrompt(ctx: QaContext, failures: readonly FailureInput[]): string {
  return `Developers need a plan to fix the bugs behind the failed end-to-end tests of this app. Read the source code (${ctx.config.source.include.join(', ')}) to work out, for each failure, whether the app is wrong (a product bug or a mismatch with the design) or the test is (test bug, flaky, environment), and how to fix the app.

## Failed tests
${JSON.stringify(failures, null, 2)}

## Instructions
- Group failures with the same cause into one bug; "failureKeys" lists the keys of the failed tests it explains. Every failure key must appear in exactly one bug or in "notIncluded".
- The expected results describe correct, intended behaviour: fix the app to match them, never the other way round. Put a failure in "notIncluded" only when the test itself is wrong (TEST_BUG), the failure is unstable (FLAKY), or it comes from the environment (ENVIRONMENT); say why in "reason".
- For every bug: a short user-facing title, severity, the page(s), expected vs actual (with values), the root cause in plain words, where it is ("path/to/file.ts:line", relative to the project root), the fix in plain words, a short code hint only if it helps, risks, manual checks to verify, effort (S = under an hour, M = a few hours, L = a day or more), and relatedIds for bugs to fix together.
- "order": all bug ids in the order to fix them: most severe and most user-facing first, shared causes together, quick wins before large refactors when severity is equal.
- "notes": anything that applies to several bugs (e.g. a shared component). Empty if nothing.
- The screenshot paths above can be opened with Read to see what the user saw.
- Do not modify any file. Only read.${projectRules(ctx)}`;
}

/** Plan file for a run: `<dir>/<run-id>-plan.md` in the project root (dir from --dir, config, default). */
export function planFile(ctx: QaContext, runId: string, dir?: string): string {
  return path.resolve(ctx.root, dir ?? ctx.config.plans.dir, `${runId}-plan.md`);
}

function latestRunId(ctx: QaContext): string | undefined {
  return [...ctx.state.data.runs]
    .reverse()
    .find((r) => fs.existsSync(path.join(runDir(ctx.paths, r.id), 'results.json')))?.id;
}

const loadRun = (ctx: QaContext, runId: string): TestRunResult | undefined =>
  readJson(path.join(runDir(ctx.paths, runId), 'results.json'), TestRunResultSchema);

/** What the dashboard needs to offer the plan button for a run (no AI, no network). */
export function planStatus(
  ctx: QaContext,
  runId: string,
): { failures: number; exists: boolean; file: string } {
  const run = loadRun(ctx, runId);
  const file = planFile(ctx, runId);
  return {
    failures: run ? run.outcomes.filter(failing).length : 0,
    exists: fs.existsSync(file),
    file: rel(ctx.root, file),
  };
}

export interface PlanResult {
  runId: string;
  /** Project-relative path of the written plan, or null when there was nothing to plan. */
  file: string | null;
  bugs: number;
  notIncluded: number;
  costUsd: number;
}

export async function writeBugFixPlan(
  ctx: QaContext,
  opts: { runId?: string; dir?: string; force?: boolean } = {},
): Promise<PlanResult> {
  const runId = opts.runId ?? latestRunId(ctx);
  if (!runId) throw new PlanRefused('No test run with results. Run `ai-qa-agent test` first.');
  const run = loadRun(ctx, runId);
  if (!run) throw new PlanRefused(`Run ${runId} has no results.`);
  const failures = collectFailures(run, loadAllScenarios(ctx));
  if (failures.length === 0) {
    log.info(`No failed tests in run ${runId}; nothing to plan.`);
    return { runId, file: null, bugs: 0, notIncluded: 0, costUsd: 0 };
  }
  const file = planFile(ctx, runId, opts.dir);
  if (fs.existsSync(file) && !opts.force) {
    throw new PlanRefused(`${rel(ctx.root, file)} already exists. Use --force to overwrite it.`);
  }

  log.info(`Planning fixes for the ${failures.length} failed test(s) of run ${runId}`);
  const res = await ctx.ai.run({
    name: `plan-${runId}`,
    cwd: ctx.root,
    system: BASE_SYSTEM,
    prompt: buildPrompt(ctx, failures),
    schema: PlanSchema,
    tools: ['Read', 'Glob', 'Grep'],
  });
  const plan = reconcilePlan(res.output, failures);
  const md = renderPlan({
    runId,
    baseUrl: ctx.config.app.baseUrl,
    generatedAt: new Date().toISOString(),
    plan,
    failures,
    evidenceBase: rel(ctx.root, path.dirname(file)),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, md);
  log.info(
    `Wrote ${rel(ctx.root, file)}: ${plan.bugs.length} bug(s), ${plan.notIncluded.length} not included`,
  );
  return {
    runId,
    file: rel(ctx.root, file),
    bugs: plan.bugs.length,
    notIncluded: plan.notIncluded.length,
    costUsd: res.costUsd,
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_SYSTEM, projectRules } from '../ai/context.js';
import { loadAppModel } from '../analyze/app.js';
import { sha256, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { rel } from '../core/paths.js';
import type { QaContext } from '../pipeline/context.js';
import type { TestOutcome, TestRunResult } from '../runner/results.js';
import { loadAllScenarios } from '../scenarios/generate.js';
import { classifyByRules } from './rules.js';
import {
  AiVerdictSchema,
  BugDraftSchema,
  type Issue,
  type TriagedFailure,
  type TriageResult,
} from './schema.js';

const log = logger('triage');

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const TRIAGE_SYSTEM = `${BASE_SYSTEM}

You are triaging a failed end-to-end test. Classify the ROOT CAUSE of the failure:
- PRODUCT_BUG: the application behaves incorrectly (wrong result, broken interaction, broken responsive layout, missing feedback). The test's expectation is legitimate.
- DESIGN_MISMATCH: the application works but its visual appearance deviates from the Figma design beyond normal rendering noise (wrong color, radius, size, typography, missing/extra UI element compared to the design).
- TEST_BUG: the test is wrong: bad locator, wrong assumption about the page, expectation not supported by the design or product conventions, timing problem in the test, measuring the wrong element.
- ENVIRONMENT_FAILURE: app not reachable, dev server error, missing test data or configuration.
- INFRASTRUCTURE_FAILURE: browser/runner crashed, resource exhaustion.
- UNKNOWN: evidence is insufficient to decide.
Judge the expectation itself too: an expectation that only restates an arbitrary guess (e.g. an exact pixel width that the design does not define) makes it a TEST_BUG, not a product bug.
Anti-aliasing, font hinting and sub-pixel differences are acceptable rendering differences, not design mismatches.
Be conservative: only PRODUCT_BUG / DESIGN_MISMATCH with evidence you actually inspected. Do not exaggerate severity.`;

function scenarioFor(ctx: QaContext, id: string | null): unknown {
  if (!id) return null;
  return loadAllScenarios(ctx).find((s) => s.id === id) ?? null;
}

function designExcerpt(ctx: QaContext): unknown {
  if (!fs.existsSync(ctx.paths.designSystem)) return null;
  const ds = JSON.parse(fs.readFileSync(ctx.paths.designSystem, 'utf8')) as Record<string, unknown>;
  return {
    colors: ds.colors,
    radius: ds.radius,
    typography: ds.typography,
    components: ds.components,
    screens: ds.screens,
  };
}

function buildPrompt(ctx: QaContext, o: TestOutcome): string {
  const scenario = scenarioFor(ctx, o.scenarioId) as { page?: string } | null;
  const page = loadAppModel(ctx)?.pages.find((p) => p.route === scenario?.page);
  const a = o.artifacts;
  return `Triage this failed Playwright test.

## Test
- Title: ${o.title}
- Project (browser-viewport): ${o.project}
- Spec: ${o.file}:${o.line}
- Attempts: ${o.attempts} (failed every time: ${o.status === 'failed'})

## Error
${o.error?.message ?? 'n/a'}
${o.error?.snippet ? `\nCode at failure:\n${o.error.snippet}` : ''}
${o.error?.location ? `Location: ${o.error.location}` : ''}

## Deterministic check results recorded by the helpers
${o.annotations.map((x) => `- ${x.type}: ${x.description ?? ''}`).join('\n') || '(none)'}

## Scenario the test implements
${JSON.stringify(scenario, null, 2)}

## Evidence files (read them — screenshots are images you can view with Read)
- Final screenshot: ${a.screenshots.join(', ') || 'none'}
- Accessibility/DOM snapshot at failure: ${a.errorContext ?? 'none'}
- Console + network log: ${a.logs ?? 'none'}
- Design comparison images (expected/actual/diff): ${a.design.join(', ') || 'none'}
- Video: ${a.video ?? 'none'} (binary; not readable, referenced in the bug)
- Trace: ${a.trace ?? 'none'} (binary; not readable, referenced in the bug)

## Source analysis of the page (the app's source code is in this repository; read files to confirm)
${JSON.stringify(page ?? null, null, 2)}

## Figma design data
${JSON.stringify(designExcerpt(ctx))}

## What to do
1. Read the test code around ${o.file}:${o.line} to see exactly what it asserts.
2. Look at the screenshot and the DOM snapshot to see the real state of the page.
3. Read the relevant application source to find the cause.
4. Decide the classification. For PRODUCT_BUG / DESIGN_MISMATCH fill "bug" (steps a human can follow, expected vs actual with concrete values, suspected root cause with file:line). For TEST_BUG explain the test problem in "testProblem".${projectRules(ctx)}`;
}

async function triageOne(ctx: QaContext, o: TestOutcome, cost: { usd: number }): Promise<TriagedFailure> {
  const base = {
    key: o.key,
    scenarioId: o.scenarioId,
    title: o.title,
    project: o.project,
    reproduced: o.status === 'failed',
    attempts: o.attempts,
  };
  const rule = classifyByRules(o);
  if (rule) {
    return {
      ...base,
      ...rule,
      method: 'rule',
      reasoning: 'Classified by deterministic rule from the error message / retry outcome.',
      evidenceReviewed: ['error message'],
      bug: null,
      testProblem: rule.classification === 'TEST_BUG' ? (o.error?.message.split('\n')[0] ?? null) : null,
    };
  }
  const res = await ctx.ai.run({
    name: `triage-${o.key.replace(/[^A-Za-z0-9-]/g, '_')}`,
    cwd: ctx.root,
    system: TRIAGE_SYSTEM,
    prompt: buildPrompt(ctx, o),
    schema: AiVerdictSchema,
    tools: ['Read', 'Glob', 'Grep'],
    // Providers that cannot open images with a read tool get the final screenshot attached.
    images: o.artifacts.screenshots.slice(0, 1).map((s) => path.join(ctx.root, s)),
  });
  cost.usd += res.costUsd;
  const v = res.output;
  if ((v.classification === 'PRODUCT_BUG' || v.classification === 'DESIGN_MISMATCH') && !v.bug) {
    log.warn(`${o.key}: ${v.classification} without bug details; downgrading to UNKNOWN`);
    return { ...base, ...v, classification: 'UNKNOWN', method: 'ai' };
  }
  return { ...base, ...v, method: 'ai' };
}

const ConsolidationSchema = z.object({
  issues: z.array(
    z.object({
      failureKeys: z.array(z.string()).min(1),
      bug: BugDraftSchema.describe('Canonical bug report for the whole group'),
      classification: z.enum(['PRODUCT_BUG', 'DESIGN_MISMATCH']),
    }),
  ),
});

/** Group failures that share one underlying defect so each defect is reported once. */
async function consolidate(
  ctx: QaContext,
  defects: TriagedFailure[],
  cost: { usd: number },
): Promise<z.infer<typeof ConsolidationSchema>['issues']> {
  const single = defects.map((d) => ({
    failureKeys: [d.key],
    bug: d.bug!,
    classification: d.classification as 'PRODUCT_BUG' | 'DESIGN_MISMATCH',
  }));
  if (defects.length < 2) return single;
  const res = await ctx.ai.run({
    name: 'triage-consolidate',
    cwd: ctx.root,
    system: BASE_SYSTEM,
    prompt: `These failed tests were each diagnosed as a defect. Several may be symptoms of the SAME underlying defect (same root cause, e.g. one CSS rule, one wrong calculation). Group them so each underlying defect is reported exactly once.

${JSON.stringify(
  defects.map((d) => ({ key: d.key, classification: d.classification, summary: d.summary, bug: d.bug })),
  null,
  2,
)}

Rules:
- Every key must appear in exactly one group.
- Only merge when the root cause is the same. Different symptoms of one cause belong together (e.g. missing mobile menu and horizontal overflow caused by the same breakpoint). Different causes stay separate.
- For each group write one canonical bug: combined expected/actual, the most useful reproduction steps, the highest justified severity (do not exaggerate).`,
    schema: ConsolidationSchema,
    tools: ['Read', 'Grep'],
  });
  cost.usd += res.costUsd;
  const keys = defects.map((d) => d.key).sort();
  const grouped = res.output.issues.flatMap((i) => i.failureKeys).sort();
  if (JSON.stringify(keys) !== JSON.stringify(grouped)) {
    log.warn('Consolidation did not cover every failure exactly once; keeping failures ungrouped');
    return single;
  }
  return res.output.issues;
}

export async function triageRun(ctx: QaContext, run: TestRunResult): Promise<TriageResult> {
  const failed = run.outcomes.filter((o) => o.status === 'failed' || o.status === 'flaky');
  const cost = { usd: 0 };
  log.info(`Triaging ${failed.length} failed/flaky test(s)`);
  const failures = await mapLimit(failed, 3, async (o) => {
    const t = await triageOne(ctx, o, cost);
    log.info(
      `${o.key}: ${t.classification} (${Math.round(t.confidence * 100)}%, ${t.method}) — ${t.summary}`,
    );
    return t;
  });

  const defects = failures.filter(
    (f) => f.classification === 'PRODUCT_BUG' || f.classification === 'DESIGN_MISMATCH',
  );
  const groups = await consolidate(ctx, defects, cost);
  const byKey = new Map(failures.map((f) => [f.key, f]));
  const issues: Issue[] = groups.map((g, i) => {
    const members = g.failureKeys.map((k) => byKey.get(k)!).filter(Boolean);
    const scenarioIds = [...new Set(members.map((m) => m.scenarioId ?? m.key))].sort();
    const confidence = Math.max(...members.map((m) => m.confidence));
    const reproduced = members.some((m) => m.reproduced);
    const notFiledReason = !reproduced
      ? 'Not reproduced on every attempt'
      : confidence < ctx.config.ai.minConfidenceToFile
        ? `Confidence ${confidence.toFixed(2)} below threshold ${ctx.config.ai.minConfidenceToFile}`
        : null;
    return {
      id: `BUG-${String(i + 1).padStart(3, '0')}`,
      // Stable across runs as long as the same scenarios expose the defect.
      fingerprint: sha256(scenarioIds.join('|')).slice(0, 16),
      classification: g.classification,
      bug: g.bug,
      failureKeys: g.failureKeys,
      scenarioIds,
      confidence,
      fileable: notFiledReason === null,
      notFiledReason,
    };
  });

  const result: TriageResult = { runId: run.runId, failures, issues, costUsd: cost.usd };
  const file = path.join(run.runDir, 'triage.json');
  writeJson(file, result);
  const counts = failures.reduce<Record<string, number>>(
    (m, f) => ((m[f.classification] = (m[f.classification] ?? 0) + 1), m),
    {},
  );
  log.info(
    `Triage: ${JSON.stringify(counts)} → ${issues.length} distinct defect(s), ${issues.filter((i) => i.fileable).length} fileable. Saved ${rel(ctx.root, file)}`,
  );
  return result;
}

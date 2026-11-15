import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { projectRules, systemPrompt } from '../ai/context.js';
import { loadAppModel } from '../analyze/app.js';
import { sha256, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { rel } from '../core/paths.js';
import type { QaContext } from '../pipeline/context.js';
import { videosOf, type TestOutcome, type TestRunResult } from '../runner/results.js';
import { describeTarget } from '../runner/server.js';
import { loadAllScenarios } from '../scenarios/generate.js';
import { scenarioRoutes, type Scenario } from '../scenarios/schema.js';
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

const TRIAGE_SYSTEM = `${systemPrompt('failure-triager')}

Classify the ROOT CAUSE of the failure:
- PRODUCT_BUG: the application behaves incorrectly (wrong result, broken interaction, broken responsive layout, missing feedback). The test's expectation is legitimate.
- DESIGN_MISMATCH: the application works but its visual appearance deviates from the Figma design beyond normal rendering noise (wrong color, radius, size, typography, missing/extra UI element compared to the design).
- TEST_BUG: the test is wrong: bad locator, wrong assumption about the page, expectation not supported by the scenario, the design or product conventions, timing problem in the test, measuring the wrong element.
- ENVIRONMENT_FAILURE: app not reachable, server error on start, missing test data or configuration.
- INFRASTRUCTURE_FAILURE: browser/runner crashed, resource exhaustion.
- UNKNOWN: evidence is insufficient to decide.

How to decide between PRODUCT_BUG and TEST_BUG:
- First establish that the test did what the scenario says: every earlier step really happened on the page (check the snapshot and screenshot), and the failing locator points at the element the scenario means. A step that silently did nothing, or a locator that matches another element, is a TEST_BUG even when the assertion looks like a product failure.
- Then judge the expectation. It is legitimate when it follows from the scenario and from what the UI promises. An expectation that only restates an arbitrary guess (an exact pixel width the design does not define, a text or URL that neither the scenario nor the app contains) is a TEST_BUG.
- Behaviour the app does not implement at all (a button without a handler, no confirmation after submitting) is a PRODUCT_BUG when the control exists and promises that behaviour, and the test asserted it in a generic way. It is a TEST_BUG when the test demands a specific text, route or element that nothing defines.
- Then find the cause in the application source. A PRODUCT_BUG names the file and line that produce the wrong behaviour, or says "unknown" when the code does not show it.

Other rules:
- Anti-aliasing, font hinting and sub-pixel differences are acceptable rendering differences, not design mismatches.
- Be conservative: PRODUCT_BUG / DESIGN_MISMATCH only with evidence you actually inspected. Confidence reflects that evidence: below 0.7 when you could not confirm the cause in the code or on the page.
- Severity follows what users lose, not how the failure looks. A failed critical flow (the scenario has "critical": true) that is a product bug is at least high.`;

function scenarioFor(ctx: QaContext, id: string | null): Scenario | null {
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

/** A design check, or a failure the design helpers reported: only then is the Figma data relevant. */
function isDesignRelated(o: TestOutcome, scenario: Scenario | null): boolean {
  return (
    scenario?.category === 'visual' ||
    scenario?.category === 'responsive' ||
    o.artifacts.design.length > 0 ||
    o.annotations.some((x) => /design/i.test(x.type))
  );
}

export function buildTriagePrompt(ctx: QaContext, o: TestOutcome, target?: string): string {
  const scenario = scenarioFor(ctx, o.scenarioId);
  // A scenario that crosses pages can fail on any of them: give the model of each.
  const routes = scenario ? scenarioRoutes(scenario) : [];
  const pages = (loadAppModel(ctx)?.pages ?? []).filter((p) => routes.includes(p.route));
  const a = o.artifacts;
  return `## Task
Triage this failed Playwright test: find the root cause and classify it.

## Test
- Title: ${o.title}
- Project (browser-viewport): ${o.project}
- Spec: ${o.file}:${o.line}
- Attempts: ${o.attempts} (failed every time: ${o.status === 'failed'})${target ? `\n- Ran against: ${target}` : ''}

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
- Video: ${videosOf(a).join(', ') || 'none'} (one per page the test opened, first page first; binary, not readable, referenced in the bug)
- Trace: ${a.trace ?? 'none'} (binary; not readable, referenced in the bug)

## Application model of the page(s) the scenario visits (from the application analysis; the source code is in this repository, read files to confirm)
${JSON.stringify(pages.length ? pages : null, null, 2)}

## Figma design data
${isDesignRelated(o, scenario) ? JSON.stringify(designExcerpt(ctx)) : '(not included: this failure is not a design check)'}

## Procedure
1. Read the whole test in ${o.file} (it starts near line ${o.line}) and the helpers it calls, to see what it did before the failure and exactly what it asserts.
2. Look at the screenshot and the DOM snapshot to see the real state of the page at the failure, and at the console/network log for errors.
3. Check that the test did what the scenario describes and that its locators point at the intended elements.
4. Judge whether the failing expectation is legitimate.
5. Read the relevant application source to find the cause.
6. Classify. For PRODUCT_BUG / DESIGN_MISMATCH fill "bug": steps a human can follow, expected vs actual with concrete values, suspected root cause with file:line. For TEST_BUG explain in "testProblem" what is wrong in the test and how to fix it. List in "evidenceReviewed" only what you actually opened.${projectRules(ctx)}`;
}

async function triageOne(
  ctx: QaContext,
  o: TestOutcome,
  cost: { usd: number },
  target?: string,
): Promise<TriagedFailure> {
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
    prompt: buildTriagePrompt(ctx, o, target),
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
    system: systemPrompt('defect-consolidator'),
    prompt: `## Task
These failed tests were each diagnosed as a defect by a triager. Several may be symptoms of the SAME underlying defect (same root cause, e.g. one CSS rule, one wrong calculation). Group them so each underlying defect is reported exactly once.

${JSON.stringify(
  defects.map((d) => ({ key: d.key, classification: d.classification, summary: d.summary, bug: d.bug })),
  null,
  2,
)}

## Procedure
1. Compare the suspected root causes. For candidates to merge, open the files they name and confirm it is the same code that is wrong.
2. Build the groups, then write one report per group.

## Rules
- Every key must appear in exactly one group.
- Only merge when the root cause is the same. Different symptoms of one cause belong together (e.g. missing mobile menu and horizontal overflow caused by the same breakpoint). Different causes stay separate, even on the same page. When you cannot confirm that two causes are the same, keep them separate.
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
  const target = run.app ? describeTarget(run.app) : undefined;
  const failures = await mapLimit(failed, 3, async (o) => {
    const t = await triageOne(ctx, o, cost, target);
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

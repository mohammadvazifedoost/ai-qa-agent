/**
 * The QA report as data. `buildQaReport` turns a run's stored files (results, scenarios, triage,
 * filing) into one structured report: one entry per scenario with its executions, evidence,
 * analysis, fix plan and acceptance criteria; the consolidated issues; fix priorities; regression
 * recommendations; statistics. It calls no AI and reads only artifacts on disk, so the report is
 * reproducible and stays consistent when some analysis or evidence is missing. Markdown, HTML and
 * the dashboard all render this model.
 */
import { z } from 'zod';
import type { FilingSummary } from '../bugs/file.js';
import { rel } from '../core/paths.js';
import { failedStepOf, type TestOutcome, type TestRunResult } from '../runner/results.js';
import { pageSlug } from '../scenarios/generate.js';
import type { Scenario } from '../scenarios/schema.js';
import { failurePointOf, ruleAnalysis } from '../triage/analysis.js';
import { classifyByRules } from '../triage/rules.js';
import {
  CATEGORY_LABEL,
  CATEGORY_ORIGIN,
  Classification,
  CodeLocationSchema,
  confidenceLevel,
  FailureAnalysisSchema,
  FailureCategory,
  FailureLayer,
  RejectedLocationSchema,
  Severity,
  type FailureAnalysis,
  type TriagedFailure,
  type TriageResult,
} from '../triage/schema.js';
import { evidenceOf, type EvidenceKind } from './evidence.js';
import { ExecutedStepSchema } from '../runner/results.js';

export const REPORT_VERSION = 1;

export const SCENARIO_STATUSES = ['passed', 'failed', 'blocked', 'skipped', 'error', 'not-run'] as const;
export const ScenarioStatus = z.enum(SCENARIO_STATUSES);
export type ScenarioStatus = z.infer<typeof ScenarioStatus>;
export const TestPriority = z.enum(['critical', 'high', 'medium', 'low']);
export type TestPriority = z.infer<typeof TestPriority>;
const Origin = z.enum(['application', 'test', 'environment', 'inconclusive']);

const EvidenceItemSchema = z.object({
  kind: z.string() as z.ZodType<EvidenceKind>,
  label: z.string(),
  path: z.string().optional(),
  detail: z.string().optional(),
});

export const ExecutionSchema = z.object({
  key: z.string(),
  project: z.string(),
  status: z.enum(['passed', 'failed', 'flaky', 'skipped']),
  /** What the execution counts as: an execution error when the check could not run at all. */
  result: z.enum(['passed', 'failed', 'error', 'skipped']),
  attempts: z.number(),
  durationMs: z.number(),
  /** Null when the result was written before steps were recorded. */
  steps: z.array(ExecutedStepSchema).nullable(),
  failedStep: z.object({ index: z.number(), title: z.string(), path: z.array(z.string()) }).nullable(),
  failurePoint: z.string().nullable(),
  error: z
    .object({ message: z.string(), location: z.string().nullable(), snippet: z.string().nullable() })
    .nullable(),
  evidence: z.object({ items: z.array(EvidenceItemSchema), missing: z.array(z.string()) }),
  /** Run again on its own after the analysis: the analysis (if any) is of an earlier result. */
  rerunAt: z.string().nullable(),
});
export type Execution = z.infer<typeof ExecutionSchema>;

/** What the run itself shows about a failure, without interpretation. */
export const ObservedSchema = z.object({
  failurePoint: z.string(),
  expected: z.string(),
  actual: z.string(),
  difference: z.string(),
});

export const AnalysisViewSchema = z.object({
  failureKey: z.string(),
  project: z.string(),
  method: z.enum(['rule', 'ai']),
  /** True for a triage.json written before structured analyses: only the verdict is known. */
  legacy: z.boolean(),
  classification: Classification,
  category: FailureCategory,
  categoryLabel: z.string(),
  origin: Origin,
  layer: FailureLayer,
  confidence: z.number(),
  confidenceLevel: z.enum(['high', 'medium', 'low']),
  summary: z.string(),
  reasoning: z.string(),
  failurePoint: z.string(),
  expected: z.string(),
  actual: z.string(),
  difference: z.string(),
  timing: z.object({ suspected: z.boolean(), explanation: z.string() }).nullable(),
  rootCause: FailureAnalysisSchema.shape.rootCause,
  severity: Severity.nullable(),
  bugTitle: z.string().nullable(),
  testProblem: z.string().nullable(),
  fix: FailureAnalysisSchema.shape.fix.nullable(),
  evidenceReviewed: z.array(z.string()),
  engineNotes: z.array(z.string()),
  rejectedLocations: z.array(RejectedLocationSchema),
});
export type AnalysisView = z.infer<typeof AnalysisViewSchema>;

export const ScenarioReportSchema = z.object({
  id: z.string(),
  title: z.string(),
  page: z.string().nullable(),
  feature: z.string().nullable(),
  category: z.string().nullable(),
  priority: TestPriority.nullable(),
  critical: z.boolean(),
  /** False when results name a scenario that is not in the scenario files (deleted or renamed). */
  known: z.boolean(),
  status: ScenarioStatus,
  statusReason: z.string().nullable(),
  objective: z.string(),
  preconditions: z.array(z.string()),
  steps: z.array(z.string()),
  expectedResults: z.array(z.string()),
  executions: z.array(ExecutionSchema),
  /** Passed scenarios: the behaviour the passing test checked. */
  verified: z.array(z.string()),
  observed: ObservedSchema.nullable(),
  analysisState: z.enum(['analyzed', 'not-analyzed', 'not-needed']),
  analysis: AnalysisViewSchema.nullable(),
  /** Verdicts of the scenario's other failed executions (other browsers / viewports). */
  otherAnalyses: z.array(
    z.object({
      failureKey: z.string(),
      project: z.string(),
      classification: Classification,
      summary: z.string(),
    }),
  ),
  issueId: z.string().nullable(),
  acceptanceCriteria: z.array(z.string()),
  verificationSteps: z.array(z.string()),
  regression: z.object({ scenarioIds: z.array(z.string()), areas: z.array(z.string()) }),
});
export type ScenarioReport = z.infer<typeof ScenarioReportSchema>;

export const ConsolidatedIssueSchema = z.object({
  id: z.string(),
  kind: z.enum(['application', 'test', 'environment', 'unconfirmed']),
  title: z.string(),
  category: FailureCategory,
  categoryLabel: z.string(),
  severity: Severity.nullable(),
  confidence: z.number().nullable(),
  scenarioIds: z.array(z.string()),
  failureKeys: z.array(z.string()),
  rootCause: z.string(),
  rootCauseStatus: z.enum(['verified', 'hypothesis', 'unconfirmed']),
  locations: z.array(CodeLocationSchema),
  fix: z
    .object({
      target: z.string(),
      summary: z.string(),
      requiredChanges: z.array(z.string()),
      implementationSteps: z.array(z.string()),
      sideEffects: z.string(),
    })
    .nullable(),
  groupedBy: z.enum(['consolidation', 'same-failure-location', 'same-environment-error', 'single']),
  groupReason: z.string().nullable(),
  /** Application issues only: whether the triage gates would file it, and the tracker item. */
  fileable: z.boolean().nullable(),
  notFiledReason: z.string().nullable(),
  tracker: z.object({ taskId: z.string(), url: z.string().nullable() }).nullable(),
  dependsOn: z.array(z.string()),
  related: z.array(z.object({ id: z.string(), reason: z.string() })),
  rank: z.number(),
  rankReason: z.string(),
});
export type ConsolidatedIssue = z.infer<typeof ConsolidatedIssueSchema>;

export const ReportSummarySchema = z.object({
  headline: z.string(),
  scenarios: z.object({
    /** Scenarios in the scope of this run; the pass rate is computed over these. */
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    blocked: z.number(),
    skipped: z.number(),
    error: z.number(),
    /** Approved scenarios this run did not include (other pages, not selected, no test). */
    notRun: z.number(),
    /** Scenarios not yet approved; they have no test. */
    drafts: z.number(),
  }),
  results: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    flaky: z.number(),
    skipped: z.number(),
  }),
  /** passed / total. Blocked, skipped and errored scenarios count as not passed. Null without scenarios. */
  passRate: z.number().nullable(),
  /** passed / (passed + failed + error): only scenarios whose checks ran. */
  executedPassRate: z.number().nullable(),
  findings: z.object({
    /** Distinct application defects confirmed by triage (product bugs and design mismatches). */
    applicationBugs: z.number(),
    applicationBugsFileable: z.number(),
    /** Failed scenarios per cause. */
    applicationScenarios: z.number(),
    testIssues: z.number(),
    environmentIssues: z.number(),
    unconfirmed: z.number(),
    intermittent: z.number(),
    notAnalyzed: z.number(),
  }),
  globalErrors: z.array(z.string()),
});
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

export const QaReportSchema = z.object({
  version: z.literal(REPORT_VERSION),
  runId: z.string(),
  generatedAt: z.string(),
  project: z.string(),
  target: z.string(),
  triaged: z.boolean(),
  aiCostUsd: z.number(),
  summary: ReportSummarySchema,
  criticalFindings: z.array(
    z.object({
      level: z.enum(['critical', 'high']),
      title: z.string(),
      detail: z.string(),
      issueId: z.string().nullable(),
      scenarioIds: z.array(z.string()),
    }),
  ),
  scenarios: z.array(ScenarioReportSchema),
  /** Approved scenarios outside this run, listed so nothing silently disappears from the report. */
  notRun: z.array(z.object({ id: z.string(), title: z.string(), page: z.string() })),
  issues: z.array(ConsolidatedIssueSchema),
  fixOrder: z.array(z.string()),
  regression: z.array(
    z.object({
      scenarioId: z.string(),
      title: z.string(),
      reasons: z.array(z.string()),
      issueIds: z.array(z.string()),
    }),
  ),
  artifacts: z.object({
    runDir: z.string(),
    files: z.array(z.object({ label: z.string(), path: z.string() })),
  }),
});
export type QaReport = z.infer<typeof QaReportSchema>;

// ------------------------------------------------------------------------------------------------

export interface BuildInput {
  run: TestRunResult;
  scenarios: readonly Scenario[];
  triage: TriageResult | null;
  filing: FilingSummary | null;
  root: string;
  project: string;
  target: string;
  generatedAt: string;
  aiCostUsd: number;
  /** Files of the run that exist (logs, reports), project-relative. */
  runFiles?: Array<{ label: string; path: string }>;
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

export const testPriorityOf = (s: Pick<Scenario, 'priority' | 'critical'>): TestPriority =>
  s.critical ? 'critical' : s.priority;

const firstLine = (s: string | undefined | null): string => (s ?? '').split('\n')[0]!.trim();

/** What an execution counts as. The verdict decides when the check could not run at all. */
function resultOf(o: TestOutcome, verdict: TriagedFailure | undefined): Execution['result'] {
  if (o.status === 'passed') return 'passed';
  if (o.status === 'skipped') return 'skipped';
  if (o.status === 'flaky') return 'failed';
  const cls = verdict?.classification ?? classifyByRules(o)?.classification;
  const ruleTestBug = (verdict ? verdict.method === 'rule' : true) && cls === 'TEST_BUG';
  return cls === 'ENVIRONMENT_FAILURE' || cls === 'INFRASTRUCTURE_FAILURE' || ruleTestBug
    ? 'error'
    : 'failed';
}

function execution(o: TestOutcome, verdict: TriagedFailure | undefined, root: string): Execution {
  const step = failedStepOf(o);
  const ev = evidenceOf(o, root);
  const failing = o.status === 'failed' || o.status === 'flaky';
  return {
    key: o.key,
    project: o.project,
    status: o.status,
    result: resultOf(o, verdict),
    attempts: o.attempts,
    durationMs: o.durationMs,
    steps: o.steps ?? null,
    failedStep: step ? { index: step.index, title: step.step.title, path: step.step.failedPath ?? [] } : null,
    failurePoint: failing ? failurePointOf(o) : null,
    error: o.error
      ? { message: o.error.message, location: o.error.location ?? null, snippet: o.error.snippet ?? null }
      : null,
    evidence: { items: ev.items, missing: ev.missing },
    rerunAt: o.rerunAt ?? null,
  };
}

/** Expected vs actual from the scenario and the Playwright error alone. */
function observedOf(
  o: TestOutcome,
  scenario: Scenario | undefined,
  root: string,
): z.infer<typeof ObservedSchema> {
  const a = evidenceOf(o, root).assertion;
  const error = firstLine(o.error?.message?.replace(/^Error:\s*/, ''));
  const expected = scenario?.expectedResults.join('; ') ?? 'The test completes its steps and assertions.';
  if (o.status === 'flaky') {
    return {
      failurePoint: 'Not recorded: only the final, passing attempt is kept.',
      expected,
      actual: `Failed on an earlier attempt, passed on attempt ${o.attempts}.`,
      difference: 'The result changes between attempts on the same build.',
    };
  }
  let difference = error || 'Not recorded.';
  if (a?.elementNotFound)
    difference = `No element matched ${a.locator ?? 'the locator'}${a.timeoutMs ? ` within ${a.timeoutMs} ms` : ''}.`;
  else if (a && a.expected !== null && a.received !== null)
    difference = `${a.message ? `${a.message}: e` : 'E'}xpected ${a.expected}${a.locator ? ` from ${a.locator}` : ''}, received ${a.received}.`;
  else if (a?.testTimeout) difference = 'The test ran out of time before finishing its steps.';
  return {
    failurePoint: failurePointOf(o),
    expected,
    actual:
      [a?.message, a && a.received !== null ? `received ${a.received}` : null].filter(Boolean).join('; ') ||
      error ||
      'Not recorded.',
    difference,
  };
}

function analysisView(
  f: TriagedFailure,
  o: TestOutcome,
  scenario: Scenario | undefined,
  root: string,
): AnalysisView {
  const a = f.analysis;
  const observed = observedOf(o, scenario, root);
  // A triage.json from before structured analyses: keep what it says, nothing more.
  const category: FailureCategory =
    a?.category ??
    (f.classification === 'TEST_BUG'
      ? 'TEST_IMPLEMENTATION'
      : f.classification === 'ENVIRONMENT_FAILURE' || f.classification === 'INFRASTRUCTURE_FAILURE'
        ? 'ENVIRONMENT_INFRA'
        : f.classification === 'DESIGN_MISMATCH'
          ? 'UI_RENDERING'
          : f.classification === 'PRODUCT_BUG'
            ? 'APP_FUNCTIONAL'
            : o.status === 'flaky'
              ? 'FLAKY'
              : 'UNKNOWN');
  const legacyCause = f.bug?.suspectedRootCause ?? f.testProblem ?? f.summary;
  return {
    failureKey: f.key,
    project: f.project,
    method: f.method,
    legacy: a === null,
    classification: f.classification,
    category,
    categoryLabel: CATEGORY_LABEL[category],
    origin: CATEGORY_ORIGIN[category],
    layer: a?.layer ?? 'unknown',
    confidence: f.confidence,
    confidenceLevel: confidenceLevel(f.confidence),
    summary: f.summary,
    reasoning: f.reasoning,
    failurePoint: a?.failurePoint ?? observed.failurePoint,
    expected: a?.expected ?? f.bug?.expectedResult ?? observed.expected,
    actual: a?.actual ?? f.bug?.actualResult ?? observed.actual,
    difference: a?.difference ?? observed.difference,
    timing: a?.timing ?? null,
    rootCause: a?.rootCause ?? {
      statement: legacyCause,
      // An old verdict never said whether it verified the cause.
      status: f.classification === 'UNKNOWN' ? 'unconfirmed' : 'hypothesis',
      facts: [],
      hypotheses: [],
      locations: [],
      missingEvidence: [
        'structured analysis (this run was triaged by an older version; run `ai-qa-agent triage` again)',
      ],
      investigation: [],
    },
    severity: f.bug?.severity ?? null,
    bugTitle: f.bug?.title ?? null,
    testProblem: f.testProblem,
    fix: a?.fix ?? null,
    evidenceReviewed: f.evidenceReviewed,
    engineNotes: f.engineNotes ?? [],
    rejectedLocations: f.rejectedLocations ?? [],
  };
}

/** A rule verdict computed on the spot for a run that was not triaged. */
function ruleView(
  o: TestOutcome,
  scenario: Scenario | undefined,
  target: string,
): TriagedFailure | undefined {
  const rule = classifyByRules(o);
  if (!rule) return undefined;
  return {
    key: o.key,
    scenarioId: o.scenarioId,
    title: o.title,
    project: o.project,
    method: 'rule',
    reproduced: o.status === 'failed',
    attempts: o.attempts,
    ...rule,
    reasoning: 'Classified by deterministic rule from the error message / retry outcome.',
    evidenceReviewed: ['error message'],
    bug: null,
    testProblem: rule.classification === 'TEST_BUG' ? firstLine(o.error?.message) : null,
    analysis: ruleAnalysis(rule, o, scenario ?? null, { target }) satisfies FailureAnalysis,
    engineNotes: [],
    rejectedLocations: [],
  };
}

const STATUS_RANK: Record<Execution['result'], number> = { failed: 0, error: 1, skipped: 2, passed: 3 };
const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

export function buildQaReport(input: BuildInput): QaReport {
  const { run, triage, filing, root } = input;
  const known = new Map(input.scenarios.map((s) => [s.id, s]));
  const knownIds = [...known.keys()];
  // An analysis describes the result it was made for; a test run again since then has a new result.
  const verdictOf = (o: TestOutcome): TriagedFailure | undefined =>
    o.rerunAt ? undefined : triage?.failures.find((f) => f.key === o.key);
  const issueOfKey = (key: string) => triage?.issues.find((i) => i.failureKeys.includes(key));

  // Group results by scenario, in the order of the scenario files, then results without a scenario.
  const byScenario = new Map<string, TestOutcome[]>();
  for (const o of run.outcomes) {
    const id = o.scenarioId ?? o.title;
    byScenario.set(id, [...(byScenario.get(id) ?? []), o]);
  }

  const globalText = run.globalErrors.join('\n');
  const blockedReason = (s: Scenario): string | null => {
    if (!run.globalErrors.length) return null;
    const spec = `${pageSlug(s.page)}.spec.ts`;
    if (globalText.includes(spec) || globalText.includes(s.id))
      return `Not executed: Playwright reported an error loading ${spec}: ${firstLine(run.globalErrors.find((e) => e.includes(spec) || e.includes(s.id)))}`;
    if (run.outcomes.length === 0)
      return `Not executed: the run executed no test because of an error outside the tests: ${firstLine(run.globalErrors[0])}`;
    return null;
  };

  const scenarios: ScenarioReport[] = [];
  const notRun: Scenario[] = [];
  const ordered = [
    ...input.scenarios.filter((s) => s.approved || byScenario.has(s.id)),
    ...[...byScenario.keys()].filter((id) => !known.has(id)).map((id) => ({ id }) as { id: string }),
  ];
  for (const entry of ordered) {
    const sc = known.get(entry.id);
    const outcomes = byScenario.get(entry.id) ?? [];
    const base = {
      id: entry.id,
      title: sc?.title ?? outcomes[0]?.title.replace(/^[A-Z0-9]+-\d{3}:\s*/, '') ?? entry.id,
      page: sc?.page ?? null,
      feature: sc?.feature ?? null,
      category: sc?.category ?? null,
      priority: sc ? testPriorityOf(sc) : null,
      critical: sc?.critical === true,
      known: !!sc,
      objective: sc
        ? `${sc.title}. ${sc.rationale}`.replace(/\.\.\s/, '. ')
        : 'Not in the scenario files (deleted or renamed after the run); only the test result is known.',
      preconditions: sc?.preconditions ?? [],
      steps: sc?.steps ?? [],
      expectedResults: sc?.expectedResults ?? [],
      otherAnalyses: [],
      regression: { scenarioIds: [], areas: [] },
      acceptanceCriteria: [],
      verificationSteps: [],
      verified: [],
      observed: null,
      analysis: null,
      issueId: null,
    } satisfies Partial<ScenarioReport>;

    if (outcomes.length === 0) {
      const reason = sc ? blockedReason(sc) : null;
      if (!reason) {
        if (sc) notRun.push(sc);
        continue;
      }
      scenarios.push({
        ...base,
        status: 'blocked',
        statusReason: reason,
        executions: [],
        analysisState: 'not-needed',
        verificationSteps: [`npx ai-qa-agent test --grep ${entry.id}`],
      });
      continue;
    }

    const execs = outcomes.map((o) => execution(o, verdictOf(o), root));
    const worst = execs.reduce((w, e) => (STATUS_RANK[e.result] < STATUS_RANK[w.result] ? e : w));
    const status: ScenarioStatus = worst.result;
    const mixed = new Set(execs.map((e) => e.result)).size > 1;
    const statusReason = mixed ? execs.map((e) => `${e.result} on ${e.project}`).join('; ') : null;

    if (status === 'passed' || status === 'skipped') {
      scenarios.push({
        ...base,
        status,
        statusReason:
          statusReason ??
          (status === 'skipped'
            ? 'Skipped by Playwright (test.skip, a skip annotation or a failed precondition).'
            : null),
        executions: execs,
        analysisState: 'not-needed',
        verified:
          status === 'passed'
            ? [
                ...base.expectedResults.map((r) => `Asserted: ${r}`),
                ...(execs[0]!.steps ?? []).map((st) => `Step passed: ${st.title}`),
              ]
            : [],
      });
      continue;
    }

    // Failed or errored: analyze the worst failing execution, mention the others.
    const failing = outcomes.filter((o) => o.status === 'failed' || o.status === 'flaky');
    const primary = failing.find((o) => o.key === worst.key) ?? failing[0]!;
    const verdict = verdictOf(primary) ?? ruleView(primary, sc, input.target);
    const view = verdict ? analysisView(verdict, primary, sc, root) : null;
    const others = failing
      .filter((o) => o.key !== primary.key)
      .map((o) => ({ o, v: verdictOf(o) ?? ruleView(o, sc, input.target) }))
      .filter((x): x is { o: TestOutcome; v: TriagedFailure } => !!x.v)
      .map(({ o, v }) => ({
        failureKey: o.key,
        project: o.project,
        classification: v.classification,
        summary: v.summary,
      }));
    const issue = issueOfKey(primary.key);
    const extraCriteria = view?.fix?.acceptanceCriteria ?? [];
    scenarios.push({
      ...base,
      status,
      statusReason,
      executions: execs,
      observed: observedOf(primary, sc, root),
      analysisState: view ? 'analyzed' : 'not-analyzed',
      analysis: view,
      otherAnalyses: others,
      issueId: issue?.id ?? null,
      // The scenario's expected results stay the acceptance criteria; the analysis can only add.
      acceptanceCriteria: [...new Set([...base.expectedResults, ...extraCriteria])],
      verificationSteps: [
        ...(view?.fix?.verificationSteps ?? []),
        `Re-run the scenario's test: npx ai-qa-agent test --grep ${entry.id}`,
      ],
      regression: {
        scenarioIds: (view?.fix?.regressionScenarioIds ?? []).filter(
          (id) => knownIds.includes(id) && id !== entry.id,
        ),
        areas: view?.fix?.regressionAreas ?? [],
      },
    });
  }

  const issues = consolidate(scenarios, triage, filing);
  // Every failed scenario belongs to exactly one consolidated issue; it keeps its own report.
  for (const s of scenarios) s.issueId = issues.find((x) => x.scenarioIds.includes(s.id))?.id ?? null;
  const summary = summarize(
    scenarios,
    run,
    triage,
    notRun.length,
    input.scenarios.filter((s) => !s.approved).length,
    issues,
  );
  return QaReportSchema.parse({
    version: REPORT_VERSION,
    runId: run.runId,
    generatedAt: input.generatedAt,
    project: input.project,
    target: input.target,
    triaged: !!triage,
    aiCostUsd: input.aiCostUsd,
    summary,
    criticalFindings: criticalFindings(scenarios, issues, run),
    scenarios,
    notRun: notRun.map((s) => ({ id: s.id, title: s.title, page: s.page })),
    issues,
    fixOrder: issues.map((i) => i.id),
    regression: regressionPlan(scenarios, issues, input.scenarios),
    artifacts: { runDir: rel(root, run.runDir) || run.runDir, files: input.runFiles ?? [] },
  } satisfies QaReport);
}

function consolidate(
  scenarios: ScenarioReport[],
  triage: TriageResult | null,
  filing: FilingSummary | null,
): ConsolidatedIssue[] {
  const failed = scenarios.filter(
    (s) => (s.status === 'failed' || s.status === 'error') && s.executions.length,
  );
  const out: Omit<ConsolidatedIssue, 'rank' | 'rankReason'>[] = [];
  const used = new Set<string>();
  const causeLocations = (views: AnalysisView[]) => {
    const seen = new Set<string>();
    return views
      .flatMap((v) => v.rootCause.locations)
      .filter((l) => {
        const k = `${l.file}:${l.line}`;
        return seen.has(k) ? false : (seen.add(k), true);
      });
  };
  const fixOf = (v: AnalysisView | null | undefined): ConsolidatedIssue['fix'] =>
    v?.fix
      ? {
          target: v.fix.target,
          summary: v.fix.summary,
          requiredChanges: v.fix.requiredChanges,
          implementationSteps: v.fix.implementationSteps,
          sideEffects: v.fix.sideEffects,
        }
      : null;

  // 1. Application defects, as the triage consolidated them.
  for (const issue of triage?.issues ?? []) {
    const members = failed.filter((s) => s.analysis && issue.failureKeys.includes(s.analysis.failureKey));
    if (!members.length) continue;
    members.forEach((m) => used.add(m.id));
    const views = members.map((m) => m.analysis!);
    const lead = views[0]!;
    const task = filing?.results.find((r) => r.issueId === issue.id && r.taskId);
    out.push({
      id: issue.id,
      kind: 'application',
      title: issue.bug.title,
      category: lead.category,
      categoryLabel: lead.categoryLabel,
      severity: issue.bug.severity,
      confidence: issue.confidence,
      scenarioIds: members.map((m) => m.id),
      failureKeys: issue.failureKeys,
      rootCause: lead.legacy ? issue.bug.suspectedRootCause : lead.rootCause.statement,
      rootCauseStatus: views.every((v) => v.rootCause.status === 'verified')
        ? 'verified'
        : views.some((v) => v.rootCause.status !== 'unconfirmed')
          ? 'hypothesis'
          : 'unconfirmed',
      locations: causeLocations(views),
      fix: fixOf(lead),
      groupedBy: members.length > 1 ? 'consolidation' : 'single',
      groupReason: members.length > 1 ? (issue.groupReason ?? 'Grouped by the defect consolidator.') : null,
      fileable: issue.fileable,
      notFiledReason: issue.notFiledReason,
      tracker: task?.taskId ? { taskId: task.taskId, url: task.url ?? null } : null,
      dependsOn: [],
      related: [],
    });
  }

  // 2. Everything else, grouped only where the run proves a shared cause.
  const rest = failed.filter((s) => !used.has(s.id));
  const kindOf = (s: ScenarioReport): ConsolidatedIssue['kind'] => {
    const a = s.analysis;
    if (!a) return 'unconfirmed';
    if (a.origin === 'test') return 'test';
    if (a.origin === 'environment') return 'environment';
    if (
      a.origin === 'application' &&
      (a.classification === 'PRODUCT_BUG' || a.classification === 'DESIGN_MISMATCH')
    )
      return 'application';
    return 'unconfirmed';
  };
  const groups = new Map<string, ScenarioReport[]>();
  for (const s of rest) {
    const kind = kindOf(s);
    const e = s.executions.find((x) => x.key === s.analysis?.failureKey) ?? s.executions[0]!;
    // Tests that fail at the same line (a shared helper) share that code; environment failures
    // with the same diagnosis share the environment. Anything else stays on its own.
    const key =
      kind === 'test' && e.error?.location
        ? `test|${e.error.location}`
        : kind === 'environment'
          ? `env|${s.analysis!.rootCause.statement}`
          : `single|${s.id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  // Numbered after sorting, so ids follow the fix order.
  const TEMP = '~';
  for (const [key, members] of groups) {
    const lead = members[0]!;
    const kind = kindOf(lead);
    const v = lead.analysis;
    const id = `${TEMP}${key}`;
    const several = members.length > 1;
    out.push({
      id,
      kind,
      title:
        kind === 'unconfirmed'
          ? `Unconfirmed failure: ${lead.title}`
          : (v?.bugTitle ?? (kind === 'test' ? `Test problem: ${lead.title}` : (v?.summary ?? lead.title))),
      category: v?.category ?? 'UNKNOWN',
      categoryLabel: v?.categoryLabel ?? CATEGORY_LABEL.UNKNOWN,
      severity: kind === 'application' ? (v?.severity ?? null) : null,
      confidence: v?.confidence ?? null,
      scenarioIds: members.map((m) => m.id),
      failureKeys: members.map((m) => m.analysis?.failureKey ?? m.executions[0]!.key),
      rootCause: v?.rootCause.statement ?? 'Not analyzed: run `ai-qa-agent triage` to find the cause.',
      rootCauseStatus: v?.rootCause.status ?? 'unconfirmed',
      locations: causeLocations(members.flatMap((m) => (m.analysis ? [m.analysis] : []))),
      fix: fixOf(v),
      groupedBy: !several
        ? 'single'
        : key.startsWith('test|')
          ? 'same-failure-location'
          : 'same-environment-error',
      groupReason: !several
        ? null
        : key.startsWith('test|')
          ? `All ${members.length} tests fail at the same line of test code: ${key.slice(5)}.`
          : `All ${members.length} tests failed with the same environment diagnosis.`,
      fileable: null,
      notFiledReason: null,
      tracker: null,
      dependsOn: [],
      related: [],
    });
  }

  // 3. Order: environment first (it hides results), then defects by severity and reach, then
  // test problems, then what still needs investigation.
  const scenarioPriority = (i: (typeof out)[number]) =>
    Math.min(
      ...i.scenarioIds.map((id) => PRIORITY_RANK[scenarios.find((s) => s.id === id)?.priority ?? 'low']),
    );
  const kindRank = { environment: 0, application: 1, test: 2, unconfirmed: 3 } as const;
  const sorted = [...out].sort(
    (a, b) =>
      kindRank[a.kind] - kindRank[b.kind] ||
      (a.severity ? SEVERITY_RANK[a.severity] : 4) - (b.severity ? SEVERITY_RANK[b.severity] : 4) ||
      scenarioPriority(a) - scenarioPriority(b) ||
      b.scenarioIds.length - a.scenarioIds.length ||
      (b.confidence ?? 0) - (a.confidence ?? 0),
  );
  // 4. Ids.
  const counters = { application: 0, test: 0, environment: 0, unconfirmed: 0 };
  const prefix = { application: 'APP', test: 'TEST', environment: 'ENV', unconfirmed: 'INV' } as const;
  for (const i of sorted)
    if (i.id.startsWith(TEMP)) i.id = `${prefix[i.kind]}-${String(++counters[i.kind]).padStart(3, '0')}`;

  // 5. Dependencies and relations that the data proves.
  const envIds = sorted.filter((i) => i.kind === 'environment').map((i) => i.id);
  for (const i of sorted) {
    if (i.kind !== 'environment' && envIds.length) {
      // Results of a run with environment failures are less certain until the environment is fixed.
      const projects = new Set(i.failureKeys.map((k) => k.split('@')[1]));
      i.dependsOn = sorted
        .filter((e) => e.kind === 'environment' && e.failureKeys.some((k) => projects.has(k.split('@')[1])))
        .map((e) => e.id);
    }
    const files = new Set(i.locations.filter((l) => l.role !== 'test').map((l) => l.file));
    i.related = sorted
      .filter((o) => o.id !== i.id && o.locations.some((l) => l.role !== 'test' && files.has(l.file)))
      .map((o) => ({
        id: o.id,
        reason: `Both involve ${o.locations.find((l) => files.has(l.file))!.file}; fix them together.`,
      }));
  }

  return sorted.map((i, k) => ({
    ...i,
    rank: k + 1,
    rankReason:
      i.kind === 'environment'
        ? `Fix first: ${i.scenarioIds.length} scenario(s) could not be checked at all.`
        : i.kind === 'application'
          ? `${i.severity ?? 'unrated'} severity application defect affecting ${i.scenarioIds.length} scenario(s)` +
            (scenarioPriority(i) === 0 ? ', including a critical flow' : '') +
            '.'
          : i.kind === 'test'
            ? `Test problem: until fixed, ${i.scenarioIds.length} scenario(s) give no verdict on the application.`
            : 'Cause not confirmed: investigate before planning a fix.',
  }));
}

function summarize(
  scenarios: ScenarioReport[],
  run: TestRunResult,
  triage: TriageResult | null,
  notRun: number,
  drafts: number,
  issues: ConsolidatedIssue[],
): ReportSummary {
  const count = (st: ScenarioStatus) => scenarios.filter((s) => s.status === st).length;
  const failing = scenarios.filter((s) => s.status === 'failed' || s.status === 'error');
  const by = (pred: (a: AnalysisView) => boolean) =>
    failing.filter((s) => s.analysis && pred(s.analysis)).length;
  const s = {
    total: scenarios.length,
    passed: count('passed'),
    failed: count('failed'),
    blocked: count('blocked'),
    skipped: count('skipped'),
    error: count('error'),
    notRun,
    drafts,
  };
  const app = issues.filter((i) => i.kind === 'application');
  const findings = {
    applicationBugs: app.length,
    applicationBugsFileable: app.filter((i) => i.fileable).length,
    applicationScenarios: by(
      (a) => a.classification === 'PRODUCT_BUG' || a.classification === 'DESIGN_MISMATCH',
    ),
    testIssues: by((a) => a.origin === 'test'),
    environmentIssues: by((a) => a.origin === 'environment'),
    unconfirmed: by((a) => a.classification === 'UNKNOWN' && a.category !== 'FLAKY'),
    intermittent: by((a) => a.category === 'FLAKY'),
    notAnalyzed: failing.filter((x) => !x.analysis).length,
  };
  const passRate = pct(s.passed, s.total);
  const parts = [
    `${s.passed} of ${s.total} scenario${s.total === 1 ? '' : 's'} passed${passRate !== null ? ` (${passRate}%)` : ''}`,
    s.failed && `${s.failed} failed`,
    s.error && `${s.error} could not execute`,
    s.blocked && `${s.blocked} blocked`,
    s.skipped && `${s.skipped} skipped`,
  ].filter(Boolean);
  const causes = [
    findings.applicationBugs &&
      `${findings.applicationBugs} confirmed application defect${findings.applicationBugs === 1 ? '' : 's'}`,
    findings.testIssues &&
      `${findings.testIssues} test implementation issue${findings.testIssues === 1 ? '' : 's'}`,
    findings.environmentIssues &&
      `${findings.environmentIssues} environment failure${findings.environmentIssues === 1 ? '' : 's'}`,
    findings.unconfirmed + findings.intermittent &&
      `${findings.unconfirmed + findings.intermittent} with an unconfirmed cause`,
    findings.notAnalyzed &&
      `${findings.notAnalyzed} not analyzed${triage ? '' : ' (run ai-qa-agent triage)'}`,
  ].filter(Boolean);
  return {
    headline: `${parts.join(', ')}.${causes.length ? ` Failures: ${causes.join(', ')}.` : ''}`,
    scenarios: s,
    results: {
      total: run.outcomes.length,
      passed: run.stats.passed,
      failed: run.stats.failed,
      flaky: run.stats.flaky,
      skipped: run.stats.skipped,
    },
    passRate,
    executedPassRate: pct(s.passed, s.passed + s.failed + s.error),
    findings,
    globalErrors: run.globalErrors.map(firstLine),
  };
}

function criticalFindings(
  scenarios: ScenarioReport[],
  issues: ConsolidatedIssue[],
  run: TestRunResult,
): QaReport['criticalFindings'] {
  const out: QaReport['criticalFindings'] = [];
  for (const e of run.globalErrors)
    out.push({
      level: 'critical',
      title: 'Error outside the tests',
      detail: firstLine(e),
      issueId: null,
      scenarioIds: [],
    });
  const blocked = scenarios.filter((s) => s.status === 'blocked');
  if (blocked.length)
    out.push({
      level: 'critical',
      title: `${blocked.length} scenario(s) blocked`,
      detail: blocked[0]!.statusReason ?? '',
      issueId: null,
      scenarioIds: blocked.map((s) => s.id),
    });
  for (const i of issues) {
    if (i.kind === 'environment')
      out.push({
        level: 'critical',
        title: i.title,
        detail: i.rankReason,
        issueId: i.id,
        scenarioIds: i.scenarioIds,
      });
    else if (i.kind === 'application' && (i.severity === 'critical' || i.severity === 'high'))
      out.push({
        level: i.severity,
        title: i.title,
        detail: `${i.categoryLabel}; root cause ${i.rootCauseStatus}: ${i.rootCause}`,
        issueId: i.id,
        scenarioIds: i.scenarioIds,
      });
  }
  const listed = new Set(out.flatMap((f) => f.scenarioIds));
  for (const s of scenarios.filter(
    (x) => x.critical && (x.status === 'failed' || x.status === 'error') && !listed.has(x.id),
  )) {
    out.push({
      level: 'high',
      title: `Critical flow failed: ${s.title}`,
      detail: s.analysis
        ? `${s.analysis.categoryLabel} (${s.analysis.classification}), root cause ${s.analysis.rootCause.status}.`
        : 'Not analyzed yet.',
      issueId: s.issueId,
      scenarioIds: [s.id],
    });
  }
  return out;
}

/** What to re-run after the fixes: scenarios sharing a page or feature, and the analysis' picks. */
function regressionPlan(
  scenarios: ScenarioReport[],
  issues: ConsolidatedIssue[],
  all: readonly Scenario[],
): QaReport['regression'] {
  const affected = new Set(issues.flatMap((i) => i.scenarioIds));
  const out = new Map<
    string,
    { scenarioId: string; title: string; reasons: Set<string>; issueIds: Set<string> }
  >();
  const add = (s: Scenario, reason: string, issueId: string) => {
    if (affected.has(s.id) || !s.approved) return;
    const e = out.get(s.id) ?? { scenarioId: s.id, title: s.title, reasons: new Set(), issueIds: new Set() };
    e.reasons.add(reason);
    e.issueIds.add(issueId);
    out.set(s.id, e);
  };
  for (const i of issues.filter((x) => x.kind === 'application' || x.kind === 'test')) {
    const members = scenarios.filter((s) => i.scenarioIds.includes(s.id));
    for (const m of members) {
      for (const id of m.regression.scenarioIds) {
        const s = all.find((x) => x.id === id);
        if (s) add(s, `named by the analysis of ${m.id}`, i.id);
      }
      for (const s of all) {
        if (m.page && s.page === m.page && i.kind === 'application') add(s, `same page ${m.page}`, i.id);
        else if (m.feature && s.feature === m.feature && i.kind === 'application')
          add(s, `same feature ${m.feature}`, i.id);
      }
    }
    if (i.kind === 'application')
      for (const s of all.filter((x) => x.critical)) add(s, 'critical flow', i.id);
  }
  return [...out.values()].map((e) => ({ ...e, reasons: [...e.reasons], issueIds: [...e.issueIds] }));
}

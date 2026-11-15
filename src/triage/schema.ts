import { z } from 'zod';

export const CLASSIFICATIONS = [
  'PRODUCT_BUG',
  'TEST_BUG',
  'ENVIRONMENT_FAILURE',
  'INFRASTRUCTURE_FAILURE',
  'DESIGN_MISMATCH',
  'UNKNOWN',
] as const;
export const Classification = z.enum(CLASSIFICATIONS);
export type Classification = z.infer<typeof Classification>;

export const Severity = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof Severity>;

/**
 * What kind of failure it is, finer than the classification. The classification says who has to
 * act (the app, the test, the environment, nobody yet); the category says what broke.
 */
export const FAILURE_CATEGORIES = [
  'APP_FUNCTIONAL',
  'UI_RENDERING',
  'BACKEND_API',
  'DATA_INTEGRITY',
  'AUTH',
  'NAVIGATION',
  'STATE_MANAGEMENT',
  'PERFORMANCE_TIMEOUT',
  'TEST_IMPLEMENTATION',
  'ENVIRONMENT_INFRA',
  'FLAKY',
  'UNKNOWN',
] as const;
export const FailureCategory = z.enum(FAILURE_CATEGORIES);
export type FailureCategory = z.infer<typeof FailureCategory>;

export const CATEGORY_LABEL: Record<FailureCategory, string> = {
  APP_FUNCTIONAL: 'Application functional bug',
  UI_RENDERING: 'UI / rendering issue',
  BACKEND_API: 'Backend / API failure',
  DATA_INTEGRITY: 'Data validation or integrity issue',
  AUTH: 'Authentication / authorization issue',
  NAVIGATION: 'Navigation / routing issue',
  STATE_MANAGEMENT: 'State management issue',
  PERFORMANCE_TIMEOUT: 'Performance / timeout issue',
  TEST_IMPLEMENTATION: 'Test implementation issue',
  ENVIRONMENT_INFRA: 'Test environment / infrastructure issue',
  FLAKY: 'Flaky or intermittent failure',
  UNKNOWN: 'Unknown / insufficient evidence',
};

/** Who has to act on a failure of each category. */
export type FailureOrigin = 'application' | 'test' | 'environment' | 'inconclusive';
export const CATEGORY_ORIGIN: Record<FailureCategory, FailureOrigin> = {
  APP_FUNCTIONAL: 'application',
  UI_RENDERING: 'application',
  BACKEND_API: 'application',
  DATA_INTEGRITY: 'application',
  AUTH: 'application',
  NAVIGATION: 'application',
  STATE_MANAGEMENT: 'application',
  PERFORMANCE_TIMEOUT: 'application',
  TEST_IMPLEMENTATION: 'test',
  ENVIRONMENT_INFRA: 'environment',
  FLAKY: 'inconclusive',
  UNKNOWN: 'inconclusive',
};

/** Where in the system the failure starts. */
export const FailureLayer = z.enum([
  'frontend',
  'backend',
  'api',
  'state',
  'navigation',
  'data',
  'test',
  'environment',
  'unknown',
]);
export type FailureLayer = z.infer<typeof FailureLayer>;

export const BugDraftSchema = z.object({
  title: z.string().describe('Short, specific, user-facing: what is wrong where'),
  severity: Severity.describe(
    'critical: blocks core flow/data loss; high: core feature wrong; medium: degraded/workaround; low: cosmetic',
  ),
  category: z.enum(['functional', 'visual', 'responsive', 'accessibility', 'content']),
  affectedPage: z.string(),
  stepsToReproduce: z.array(z.string()).min(1),
  expectedResult: z.string(),
  actualResult: z.string().describe('Exactly what was observed, with values'),
  suspectedRootCause: z.string().describe('File and line when the code shows it; otherwise "unknown"'),
});
export type BugDraft = z.infer<typeof BugDraftSchema>;

export const CodeLocationSchema = z.object({
  file: z.string().describe('Project-relative path of a file you opened in this task'),
  line: z.number().int().nullable().describe('1-based line you read, or null for the whole file'),
  symbol: z.string().nullable().describe('Component, function, selector or endpoint at that place, or null'),
  role: z
    .enum(['cause', 'related', 'test'])
    .describe('cause: produces the failure; related: must change with it; test: the test code involved'),
  note: z.string().describe('What this code does that matters for the failure'),
});
export type CodeLocation = z.infer<typeof CodeLocationSchema>;

/**
 * The structured diagnosis of one failed test: what happened, why, and how to make the scenario
 * pass. Every field is required from the AI; `facts` and `hypotheses` keep what was verified
 * apart from what is believed.
 */
export const FailureAnalysisSchema = z.object({
  category: FailureCategory.describe('What broke; must agree with the classification'),
  layer: FailureLayer.describe('Where the failure starts'),
  failurePoint: z
    .string()
    .describe('The step and the action or assertion at which the test stopped, in plain words'),
  expected: z
    .string()
    .describe('What should have happened at that point, from the scenario and the intended behaviour'),
  actual: z.string().describe('What happened instead, with the concrete values seen in the evidence'),
  difference: z.string().describe('The precise discrepancy between expected and actual'),
  timing: z.object({
    suspected: z
      .boolean()
      .describe('True when timing, async work, network or unstable data may explain the failure'),
    explanation: z.string().describe('Why it is or is not timing-related, with the evidence'),
  }),
  rootCause: z.object({
    statement: z
      .string()
      .describe('The cause in one or two sentences, or "Unconfirmed: ..." when it could not be established'),
    status: z
      .enum(['verified', 'hypothesis', 'unconfirmed'])
      .describe(
        'verified: seen in the code and the evidence; hypothesis: likely but not confirmed; unconfirmed: unknown',
      ),
    facts: z.array(z.string()).describe('Verified facts, each naming what it was read from'),
    hypotheses: z.array(z.string()).describe('Unverified explanations; empty when the cause is verified'),
    locations: z
      .array(CodeLocationSchema)
      .describe('Code you opened that is involved; never a file you did not read'),
    missingEvidence: z
      .array(z.string())
      .describe('Evidence that was not available or not enough to decide (e.g. no network log)'),
    investigation: z
      .array(z.string())
      .describe('Concrete next checks when the cause is not verified; empty when it is'),
  }),
  fix: z.object({
    target: z
      .enum(['application', 'test', 'environment', 'investigate'])
      .describe('What has to change; "investigate" when the cause is unconfirmed'),
    summary: z.string().describe('The recommended change in one sentence'),
    requiredChanges: z
      .array(z.string())
      .describe('Specific changes, each naming the file/component/endpoint and what to change in it'),
    implementationSteps: z.array(z.string()).describe('Ordered steps a developer follows'),
    alternatives: z.array(z.string()).describe('Other valid fixes and when to prefer them; may be empty'),
    sideEffects: z.string().describe('Dependencies, other callers or flows the change can affect'),
    expectedAfterFix: z.string().describe('The behaviour the scenario will observe once fixed'),
    acceptanceCriteria: z
      .array(z.string())
      .describe("Measurable conditions, in addition to the scenario's expected results, that prove the fix"),
    verificationSteps: z.array(z.string()).describe('How to check the fix by hand and with the test'),
    regressionScenarioIds: z
      .array(z.string())
      .describe('Ids of the listed related scenarios to re-run after the fix'),
    regressionAreas: z.array(z.string()).describe('Other functionality to re-test, in plain words'),
  }),
});
export type FailureAnalysis = z.infer<typeof FailureAnalysisSchema>;

/** What the AI returns for one failed test. */
export const AiVerdictSchema = z.object({
  classification: Classification,
  confidence: z.number().min(0).max(1),
  summary: z.string().describe('One sentence'),
  reasoning: z.string().describe('How the evidence supports the classification'),
  evidenceReviewed: z.array(z.string()).describe('Files/artifacts actually inspected'),
  bug: BugDraftSchema.nullable().describe('Required for PRODUCT_BUG and DESIGN_MISMATCH, otherwise null'),
  testProblem: z.string().nullable().describe('For TEST_BUG: what is wrong in the test and how to fix it'),
  analysis: FailureAnalysisSchema,
});
export type AiVerdict = z.infer<typeof AiVerdictSchema>;

/** A code location the engine could not find in the project: kept out of the report, but listed. */
export const RejectedLocationSchema = z.object({
  file: z.string(),
  line: z.number().nullable(),
  reason: z.string(),
});

export const TriagedFailureSchema = AiVerdictSchema.extend({
  key: z.string(),
  scenarioId: z.string().nullable(),
  title: z.string(),
  project: z.string(),
  /** How the classification was produced. */
  method: z.enum(['rule', 'ai']),
  /** Failed on every attempt (initial run + verification retries). */
  reproduced: z.boolean(),
  attempts: z.number(),
  /** Missing in triage.json written before structured analysis existed. */
  analysis: FailureAnalysisSchema.nullable().default(null),
  /** What the engine's own checks of the answer found and changed (location checks, consistency). */
  engineNotes: z.array(z.string()).default([]),
  rejectedLocations: z.array(RejectedLocationSchema).default([]),
});
export type TriagedFailure = z.infer<typeof TriagedFailureSchema>;

/** One underlying defect, possibly observed by several failing tests. */
export const IssueSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  classification: z.enum(['PRODUCT_BUG', 'DESIGN_MISMATCH']),
  bug: BugDraftSchema,
  failureKeys: z.array(z.string()),
  scenarioIds: z.array(z.string()),
  confidence: z.number(),
  /** Should be filed: confirmed classification, reproduced, confidence above the threshold. */
  fileable: z.boolean(),
  notFiledReason: z.string().nullable(),
  /** Why the consolidator grouped these failures; empty for a single failure. */
  groupReason: z.string().optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const TriageResultSchema = z.object({
  runId: z.string(),
  failures: z.array(TriagedFailureSchema),
  issues: z.array(IssueSchema),
  costUsd: z.number(),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

/** Confidence as a word, so reports and the dashboard use the same thresholds. */
export function confidenceLevel(confidence: number): 'high' | 'medium' | 'low' {
  return confidence >= 0.8 ? 'high' : confidence >= 0.5 ? 'medium' : 'low';
}

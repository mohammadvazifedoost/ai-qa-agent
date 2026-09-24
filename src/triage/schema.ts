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

/** What the AI returns for one failed test. */
export const AiVerdictSchema = z.object({
  classification: Classification,
  confidence: z.number().min(0).max(1),
  summary: z.string().describe('One sentence'),
  reasoning: z.string().describe('How the evidence supports the classification'),
  evidenceReviewed: z.array(z.string()).describe('Files/artifacts actually inspected'),
  bug: BugDraftSchema.nullable().describe('Required for PRODUCT_BUG and DESIGN_MISMATCH, otherwise null'),
  testProblem: z.string().nullable().describe('For TEST_BUG: what is wrong in the test and how to fix it'),
});
export type AiVerdict = z.infer<typeof AiVerdictSchema>;

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
});
export type Issue = z.infer<typeof IssueSchema>;

export const TriageResultSchema = z.object({
  runId: z.string(),
  failures: z.array(TriagedFailureSchema),
  issues: z.array(IssueSchema),
  costUsd: z.number(),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

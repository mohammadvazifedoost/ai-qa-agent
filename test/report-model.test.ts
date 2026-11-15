import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildQaReport, QaReportSchema, type BuildInput } from '../src/report/model.js';
import { renderHtml, renderMarkdown } from '../src/report/render.js';
import type { TestOutcome, TestRunResult } from '../src/runner/results.js';
import type { Scenario } from '../src/scenarios/schema.js';
import {
  TriageResultSchema,
  type FailureAnalysis,
  type TriagedFailure,
  type TriageResult,
} from '../src/triage/schema.js';
import { makeProject } from './helpers.js';

const RUN = '2026-11-15_10-00-00';
const RUN_DIR = `.qa/artifacts/runs/${RUN}`;

const scenario = (id: string, extra: Partial<Scenario> = {}): Scenario => ({
  id,
  page: '/checkout',
  feature: 'checkout',
  category: 'functional',
  priority: 'high',
  title: `Title of ${id}`,
  preconditions: [],
  steps: ['Add a mug', 'Apply SAVE10'],
  expectedResults: [`${id}: total is $16.20`],
  viewport: 'desktop',
  source: { figma: false, code: true },
  testData: [],
  design: null,
  rationale: 'Money is involved',
  approved: true,
  ...extra,
});

const outcome = (
  id: string,
  status: TestOutcome['status'],
  extra: Partial<TestOutcome> = {},
): TestOutcome => ({
  key: `${id}@chromium-desktop`,
  scenarioId: id,
  title: `${id}: Title of ${id}`,
  file: '.qa/tests/checkout.spec.ts',
  line: 10,
  project: 'chromium-desktop',
  tags: [],
  status,
  attempts: status === 'flaky' ? 2 : 1,
  durationMs: 100,
  error:
    status === 'failed'
      ? {
          message: `Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId('total')\nExpected string: "$16.20"\nReceived string: "$18.00"\nTimeout: 5000ms`,
          location: '.qa/tests/checkout.spec.ts:42',
        }
      : null,
  annotations: [],
  steps:
    status === 'passed'
      ? [
          { title: 'Open /checkout', durationMs: 10, status: 'passed' },
          { title: 'Read the total', durationMs: 5, status: 'passed' },
        ]
      : status === 'failed'
        ? [
            { title: 'Open /checkout', durationMs: 10, status: 'passed' },
            { title: 'Apply SAVE10', durationMs: 5, status: 'passed' },
            {
              title: 'Read the total',
              durationMs: 5000,
              status: 'failed',
              error: 'expect(locator).toHaveText failed',
            },
          ]
        : [],
  artifacts: {
    video: `${RUN_DIR}/videos/${id}.webm`,
    videos: [`${RUN_DIR}/videos/${id}.webm`],
    trace: `${RUN_DIR}/traces/${id}.zip`,
    screenshots: [`${RUN_DIR}/screenshots/${id}.png`],
    errorContext: status === 'failed' ? `${RUN_DIR}/logs/${id}_error-context.md` : null,
    logs: `${RUN_DIR}/logs/${id}_console-network.json`,
    design: [],
  },
  ...extra,
});

/** A project on disk with the artifacts of the given outcomes and an application file to cite. */
function project(outcomes: TestOutcome[]): string {
  const files: Record<string, string | object> = {
    'src/cart.ts': Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join('\n'),
    '.qa/tests/checkout.spec.ts': Array.from({ length: 80 }, () => '//').join('\n'),
  };
  for (const o of outcomes) {
    for (const p of [
      o.artifacts.video,
      o.artifacts.trace,
      ...o.artifacts.screenshots,
      o.artifacts.errorContext,
    ])
      if (p) files[p] = 'x';
    if (o.artifacts.logs)
      files[o.artifacts.logs] = {
        console: [{ type: 'error', text: 'TypeError: discount is undefined' }],
        pageErrors: [],
        network: [{ url: 'http://127.0.0.1:4173/api/coupon', method: 'POST', status: 500 }],
      };
  }
  return makeProject(files);
}

const runOf = (outcomes: TestOutcome[], extra: Partial<TestRunResult> = {}): TestRunResult => ({
  runId: RUN,
  runDir: RUN_DIR,
  outcomes,
  globalErrors: [],
  exitCode: 1,
  stats: {
    passed: outcomes.filter((o) => o.status === 'passed').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    flaky: outcomes.filter((o) => o.status === 'flaky').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
  },
  ...extra,
});

const analysis = (
  extra: Partial<FailureAnalysis> = {},
  fix: Partial<FailureAnalysis['fix']> = {},
): FailureAnalysis => ({
  category: 'APP_FUNCTIONAL',
  layer: 'frontend',
  failurePoint: 'Step 3 "Read the total"',
  expected: 'Total is $16.20 after SAVE10',
  actual: 'Total stays $18.00',
  difference: 'The 10% discount is not subtracted from the total',
  timing: { suspected: false, explanation: 'The value is wrong, not late.' },
  rootCause: {
    statement: 'total() ignores the discount',
    status: 'verified',
    facts: ['src/cart.ts:42 returns subtotal without the discount'],
    hypotheses: [],
    locations: [{ file: 'src/cart.ts', line: 42, symbol: 'total', role: 'cause', note: 'returns subtotal' }],
    missingEvidence: [],
    investigation: [],
  },
  fix: {
    target: 'application',
    summary: 'Subtract the discount in total()',
    requiredChanges: ['src/cart.ts total(): return subtotal - discount'],
    implementationSteps: ['Change total()', 'Run the checkout tests'],
    alternatives: [],
    sideEffects: 'Order summary uses total() too',
    expectedAfterFix: 'Total shows $16.20',
    acceptanceCriteria: ['Discount row shows -$1.80'],
    verificationSteps: ['Apply SAVE10 by hand'],
    regressionScenarioIds: ['CHECKOUT-009'],
    regressionAreas: ['Order summary'],
    ...fix,
  },
  ...extra,
});

const verdict = (o: TestOutcome, extra: Partial<TriagedFailure> = {}): TriagedFailure => ({
  key: o.key,
  scenarioId: o.scenarioId,
  title: o.title,
  project: o.project,
  method: 'ai',
  reproduced: true,
  attempts: 1,
  classification: 'PRODUCT_BUG',
  confidence: 0.9,
  summary: 'Total ignores the discount',
  reasoning: 'Screenshot shows $18.00; code returns the subtotal',
  evidenceReviewed: ['screenshot', 'src/cart.ts'],
  bug: {
    title: 'Discount not applied to the total',
    severity: 'high',
    category: 'functional',
    affectedPage: '/checkout',
    stepsToReproduce: ['Add a mug', 'Apply SAVE10'],
    expectedResult: '$16.20',
    actualResult: '$18.00',
    suspectedRootCause: 'src/cart.ts:42',
  },
  testProblem: null,
  analysis: analysis(),
  engineNotes: [],
  rejectedLocations: [],
  ...extra,
});

const issue = (id: string, keys: string[], extra: Partial<TriageResult['issues'][number]> = {}) => ({
  id,
  fingerprint: id,
  classification: 'PRODUCT_BUG' as const,
  bug: verdict(outcome('X-001', 'failed')).bug!,
  failureKeys: keys,
  scenarioIds: keys.map((k) => k.split('@')[0]!),
  confidence: 0.9,
  fileable: true,
  notFiledReason: null,
  ...extra,
});

function build(args: {
  outcomes: TestOutcome[];
  scenarios: Scenario[];
  triage?: TriageResult | null;
  run?: Partial<TestRunResult>;
}) {
  const root = project(args.outcomes);
  const input: BuildInput = {
    run: runOf(args.outcomes, args.run),
    scenarios: args.scenarios,
    triage: args.triage ?? null,
    filing: null,
    root,
    project: 'shop',
    target: 'http://127.0.0.1:4173 (production build)',
    generatedAt: '2026-11-15T10:05:00.000Z',
    aiCostUsd: 0.5,
  };
  const report = buildQaReport(input);
  return {
    report,
    root,
    md: renderMarkdown(report, `.qa/reports/${RUN}`),
    html: renderHtml(report, `.qa/reports/${RUN}`),
  };
}

describe('QA report model', () => {
  it('validates against its schema and keeps a JSON round trip', () => {
    const o = outcome('CHECKOUT-001', 'failed');
    const { report } = build({
      outcomes: [o, outcome('CHECKOUT-002', 'passed')],
      scenarios: [scenario('CHECKOUT-001'), scenario('CHECKOUT-002')],
      triage: { runId: RUN, failures: [verdict(o)], issues: [issue('BUG-001', [o.key])], costUsd: 0.5 },
    });
    expect(QaReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it('reports a passed scenario concisely: what was verified, no fix plan', () => {
    const { report, md } = build({
      outcomes: [outcome('CHECKOUT-002', 'passed')],
      scenarios: [scenario('CHECKOUT-002')],
    });
    const s = report.scenarios[0]!;
    expect(s).toMatchObject({ status: 'passed', analysisState: 'not-needed', analysis: null, issueId: null });
    expect(s.verified).toEqual([
      'Asserted: CHECKOUT-002: total is $16.20',
      'Step passed: Open /checkout',
      'Step passed: Read the total',
    ]);
    expect(s.acceptanceCriteria).toEqual([]);
    expect(report.issues).toEqual([]);
    const section = md.slice(md.indexOf('### CHECKOUT-002'));
    expect(section).toContain('#### Verified');
    expect(section).not.toContain('#### Bug fix plan');
  });

  it('gives a failed scenario its failed step, evidence, analysis, fix plan and acceptance criteria', () => {
    const o = outcome('CHECKOUT-001', 'failed');
    const { report, md } = build({
      outcomes: [o],
      scenarios: [scenario('CHECKOUT-001'), scenario('CHECKOUT-009', { priority: 'low' })],
      triage: { runId: RUN, failures: [verdict(o)], issues: [issue('BUG-001', [o.key])], costUsd: 0.5 },
    });
    const s = report.scenarios.find((x) => x.id === 'CHECKOUT-001')!;
    expect(s.status).toBe('failed');
    expect(s.executions[0]!.failedStep).toEqual({ index: 2, title: 'Read the total', path: [] });
    expect(s.observed).toMatchObject({
      difference: 'Expected "$16.20" from getByTestId(\'total\'), received "$18.00".',
    });
    expect(s.analysis).toMatchObject({
      classification: 'PRODUCT_BUG',
      category: 'APP_FUNCTIONAL',
      origin: 'application',
      confidenceLevel: 'high',
      severity: 'high',
    });
    // The scenario's own expected results come first and are never replaced.
    expect(s.acceptanceCriteria).toEqual(['CHECKOUT-001: total is $16.20', 'Discount row shows -$1.80']);
    expect(s.verificationSteps.at(-1)).toBe(
      "Re-run the scenario's test: npx ai-qa-agent test --grep CHECKOUT-001",
    );
    expect(s.regression.scenarioIds).toEqual(['CHECKOUT-009']);
    expect(s.issueId).toBe('BUG-001');
    const ev = s.executions[0]!.evidence;
    expect(ev.items.map((i) => i.kind)).toEqual(
      expect.arrayContaining([
        'error',
        'failed-step',
        'assertion',
        'screenshot',
        'video',
        'trace',
        'dom-snapshot',
        'console-network',
      ]),
    );
    expect(ev.items.find((i) => i.kind === 'console-network')!.detail).toContain(
      'HTTP POST http://127.0.0.1:4173/api/coupon → 500',
    );
    expect(ev.missing).toEqual([]);
    for (const heading of [
      '#### Scenario information',
      '#### Scenario objective',
      '#### Execution details',
      '#### Expected vs. actual behavior',
      '#### Failure analysis',
      '#### Bug fix plan',
      '#### Acceptance criteria',
      '#### Verification and regression tests',
    ])
      expect(md).toContain(heading);
    expect(md).toContain('3. ✗ Read the total (5000 ms)');
    expect(md).toContain('Root cause confidence: High (90%), root cause verified');
  });

  it('keeps multiple independent failures apart, each with its own analysis', () => {
    const a = outcome('CHECKOUT-001', 'failed');
    const b = outcome('LOGIN-001', 'failed', { file: '.qa/tests/login.spec.ts' });
    const vb = verdict(b, {
      summary: 'Login button has no handler',
      bug: { ...verdict(b).bug!, title: 'Login does nothing', severity: 'critical', affectedPage: '/login' },
      analysis: analysis({
        category: 'AUTH',
        rootCause: { ...analysis().rootCause, statement: 'no onSubmit' },
      }),
    });
    const { report } = build({
      outcomes: [a, b],
      scenarios: [scenario('CHECKOUT-001'), scenario('LOGIN-001', { page: '/login', feature: 'auth' })],
      triage: {
        runId: RUN,
        failures: [verdict(a), vb],
        issues: [issue('BUG-001', [a.key]), issue('BUG-002', [b.key], { bug: vb.bug! })],
        costUsd: 1,
      },
    });
    expect(report.scenarios.map((s) => [s.id, s.issueId, s.analysis?.rootCause.statement])).toEqual([
      ['CHECKOUT-001', 'BUG-001', 'total() ignores the discount'],
      ['LOGIN-001', 'BUG-002', 'no onSubmit'],
    ]);
    // Critical before high, regardless of file order.
    expect(report.fixOrder).toEqual(['BUG-002', 'BUG-001']);
    expect(report.issues.every((i) => i.groupedBy === 'single')).toBe(true);
    expect(report.summary.findings.applicationBugs).toBe(2);
    expect(report.criticalFindings.map((f) => f.issueId)).toEqual(['BUG-002', 'BUG-001']);
  });

  it('groups failures sharing a verified cause without removing any scenario report', () => {
    const a = outcome('CHECKOUT-001', 'failed');
    const b = outcome('CHECKOUT-002', 'failed');
    const { report, md } = build({
      outcomes: [a, b],
      scenarios: [scenario('CHECKOUT-001'), scenario('CHECKOUT-002')],
      triage: {
        runId: RUN,
        failures: [verdict(a), verdict(b)],
        issues: [issue('BUG-001', [a.key, b.key], { groupReason: 'Both read total() at src/cart.ts:42' })],
        costUsd: 1,
      },
    });
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      groupedBy: 'consolidation',
      groupReason: 'Both read total() at src/cart.ts:42',
      scenarioIds: ['CHECKOUT-001', 'CHECKOUT-002'],
    });
    for (const id of ['CHECKOUT-001', 'CHECKOUT-002']) {
      const s = report.scenarios.find((x) => x.id === id)!;
      expect(s.analysis).not.toBeNull();
      expect(s.acceptanceCriteria[0]).toBe(`${id}: total is $16.20`);
      expect(s.issueId).toBe('BUG-001');
      expect(md).toContain(`### ${id}: Title of ${id}`);
    }
  });

  it('says the root cause is unconfirmed and what is missing when the evidence is insufficient', () => {
    const o = outcome('CHECKOUT-001', 'failed', {
      artifacts: {
        video: null,
        videos: [],
        trace: null,
        screenshots: [],
        errorContext: null,
        logs: null,
        design: [],
      },
      steps: undefined,
    });
    const unknown = verdict(o, {
      classification: 'UNKNOWN',
      confidence: 0.3,
      bug: null,
      analysis: analysis(
        {
          category: 'UNKNOWN',
          rootCause: {
            statement: 'Unconfirmed: no screenshot or log to tell whether the total rendered late',
            status: 'unconfirmed',
            facts: [],
            hypotheses: ['The coupon request may be slow'],
            locations: [],
            missingEvidence: ['network timings'],
            investigation: ['Re-run with tracing and inspect the coupon request'],
          },
        },
        { target: 'investigate' },
      ),
    });
    const { report, md } = build({
      outcomes: [o],
      scenarios: [scenario('CHECKOUT-001')],
      triage: { runId: RUN, failures: [unknown], issues: [], costUsd: 0.2 },
    });
    const s = report.scenarios[0]!;
    expect(s.analysis).toMatchObject({ classification: 'UNKNOWN', confidenceLevel: 'low' });
    expect(s.analysis!.rootCause.status).toBe('unconfirmed');
    expect(s.executions[0]!.evidence.missing).toEqual([
      'screenshot',
      'DOM snapshot at failure',
      'console and network log',
      'trace',
      'video',
      'step-by-step execution record (results written before steps were recorded)',
    ]);
    expect(report.issues[0]).toMatchObject({
      id: 'INV-001',
      kind: 'unconfirmed',
      rootCauseStatus: 'unconfirmed',
    });
    expect(report.summary.findings).toMatchObject({
      unconfirmed: 1,
      applicationBugs: 0,
      applicationScenarios: 0,
    });
    expect(md).toContain('Hypotheses (not verified):');
    expect(md).toContain('Further investigation needed:');
    expect(md).toContain('- network timings');
  });

  it('reports a test implementation issue as such, not as an application bug', () => {
    const a = outcome('CHECKOUT-001', 'failed');
    const b = outcome('CHECKOUT-002', 'failed');
    const testBug = (o: TestOutcome) =>
      verdict(o, {
        classification: 'TEST_BUG',
        bug: null,
        testProblem: 'getByTestId("total") matches the subtotal row',
        analysis: analysis(
          { category: 'TEST_IMPLEMENTATION', layer: 'test' },
          { target: 'test', summary: "Locate the total by its row label 'Total'" },
        ),
      });
    const { report } = build({
      outcomes: [a, b],
      scenarios: [scenario('CHECKOUT-001'), scenario('CHECKOUT-002')],
      triage: { runId: RUN, failures: [testBug(a), testBug(b)], issues: [], costUsd: 0.4 },
    });
    expect(report.summary.findings).toMatchObject({
      testIssues: 2,
      applicationBugs: 0,
      applicationScenarios: 0,
    });
    // Both fail at the same line of the spec, so they share that code.
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      id: 'TEST-001',
      kind: 'test',
      groupedBy: 'same-failure-location',
      scenarioIds: ['CHECKOUT-001', 'CHECKOUT-002'],
    });
    expect(report.scenarios.every((s) => s.status === 'failed' && s.issueId === 'TEST-001')).toBe(true);
    expect(report.criticalFindings).toEqual([]);
  });

  it('counts statistics and pass rates without treating blocked, skipped or errors as passed', () => {
    const outcomes = [
      outcome('CHECKOUT-001', 'passed'),
      outcome('CHECKOUT-002', 'failed'),
      outcome('CHECKOUT-003', 'skipped', { steps: [] }),
      outcome('CHECKOUT-004', 'failed', {
        error: { message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4173/checkout' },
        steps: [],
      }),
    ];
    const { report, md } = build({
      outcomes,
      scenarios: [
        ...['CHECKOUT-001', 'CHECKOUT-002', 'CHECKOUT-003', 'CHECKOUT-004'].map((id) => scenario(id)),
        scenario('LOGIN-001', { page: '/login' }),
        scenario('HOME-001', { page: '/' }),
        scenario('HOME-002', { page: '/', approved: false }),
      ],
      run: { globalErrors: ['Error: SyntaxError in tests/login.spec.ts:3'] },
    });
    expect(report.summary.scenarios).toEqual({
      total: 5,
      passed: 1,
      failed: 1,
      blocked: 1,
      skipped: 1,
      error: 1,
      notRun: 1,
      drafts: 1,
    });
    expect(report.summary.passRate).toBe(20);
    expect(report.summary.executedPassRate).toBe(33.3);
    expect(report.scenarios.find((s) => s.id === 'LOGIN-001')).toMatchObject({ status: 'blocked' });
    expect(report.scenarios.find((s) => s.id === 'CHECKOUT-004')).toMatchObject({
      status: 'error',
      analysisState: 'analyzed',
      analysis: { method: 'rule', category: 'ENVIRONMENT_INFRA' },
    });
    expect(report.notRun.map((n) => n.id)).toEqual(['HOME-001']);
    expect(report.issues[0]).toMatchObject({ kind: 'environment', rank: 1 });
    expect(report.issues.find((i) => i.kind === 'unconfirmed')!.dependsOn).toEqual([report.issues[0]!.id]);
    expect(md).toContain('| 5 | 1 | 1 | 1 | 1 | 1 | 20% | 33.3% |');
  });

  it('shows deterministic facts for failures that were not triaged', () => {
    const o = outcome('CHECKOUT-001', 'failed');
    const { report, md } = build({ outcomes: [o], scenarios: [scenario('CHECKOUT-001')] });
    const s = report.scenarios[0]!;
    expect(s.analysisState).toBe('not-analyzed');
    expect(s.observed!.actual).toContain('received "$18.00"');
    expect(report.summary.findings.notAnalyzed).toBe(1);
    expect(md).toContain('this failure has not been analyzed');
    expect(md).not.toContain('Root cause confidence');
  });

  it('keeps reading a triage.json written before structured analyses', () => {
    const o = outcome('CHECKOUT-001', 'failed');
    const { analysis: _a, engineNotes: _e, rejectedLocations: _r, ...old } = verdict(o);
    const triage = TriageResultSchema.parse({
      runId: RUN,
      failures: [old],
      issues: [{ ...issue('BUG-001', [o.key]) }],
      costUsd: 0.3,
    });
    expect(triage.failures[0]!.analysis).toBeNull();
    const { report, md } = build({ outcomes: [o], scenarios: [scenario('CHECKOUT-001')], triage });
    expect(report.scenarios[0]!.analysis).toMatchObject({
      legacy: true,
      category: 'APP_FUNCTIONAL',
      rootCause: { statement: 'src/cart.ts:42', status: 'hypothesis' },
    });
    expect(md).toContain('triaged by an older version');
  });

  it('ignores an analysis made for an earlier result of a re-run test', () => {
    const o = outcome('CHECKOUT-001', 'failed', { rerunAt: '2026-11-15T11:00:00.000Z' });
    const { report } = build({
      outcomes: [o],
      scenarios: [scenario('CHECKOUT-001')],
      triage: { runId: RUN, failures: [verdict(o)], issues: [issue('BUG-001', [o.key])], costUsd: 0 },
    });
    expect(report.scenarios[0]!.analysisState).toBe('not-analyzed');
    expect(report.issues.map((i) => i.id)).toEqual(['INV-001']);
  });

  it('renders HTML with the eight sections and escapes content', () => {
    const o = outcome('CHECKOUT-001', 'failed', {
      error: { message: 'Error: <script>alert(1)</script>', location: '.qa/tests/checkout.spec.ts:42' },
    });
    const { html, root } = build({ outcomes: [o], scenarios: [scenario('CHECKOUT-001')] });
    for (const id of [
      'summary',
      'stats',
      'critical',
      'scenarios',
      'plan',
      'priorities',
      'regression',
      'artifacts',
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    // Evidence links are relative to the report folder.
    expect(html).toContain(`href="../../artifacts/runs/${RUN}/screenshots/CHECKOUT-001.png"`);
    expect(fs.existsSync(path.join(root, RUN_DIR, 'screenshots/CHECKOUT-001.png'))).toBe(true);
  });
});

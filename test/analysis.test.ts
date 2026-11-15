import { describe, expect, it } from 'vitest';
import { parseAssertion } from '../src/report/evidence.js';
import { executedSteps, failedStepOf, type TestOutcome } from '../src/runner/results.js';
import type { Scenario } from '../src/scenarios/schema.js';
import { checkLocations, reconcileVerdict, ruleAnalysis, weakeningFindings } from '../src/triage/analysis.js';
import { classifyByRules } from '../src/triage/rules.js';
import type { AiVerdict, FailureAnalysis } from '../src/triage/schema.js';
import { analysisOf, bugReportText, defectsOf, failedStepText, type Data } from '../src/ui/client/logic.js';
import { makeProject } from './helpers.js';

const root = makeProject({ 'src/cart.ts': Array.from({ length: 50 }, () => '//').join('\n') });

const outcome = (extra: Partial<TestOutcome> = {}): TestOutcome => ({
  key: 'CHECKOUT-001@chromium-desktop',
  scenarioId: 'CHECKOUT-001',
  title: 'CHECKOUT-001: total',
  file: '.qa/tests/checkout.spec.ts',
  line: 1,
  project: 'chromium-desktop',
  tags: [],
  status: 'failed',
  attempts: 1,
  durationMs: 1,
  error: { message: 'Error: boom', location: '.qa/tests/checkout.spec.ts:12' },
  annotations: [],
  artifacts: {
    video: null,
    videos: [],
    trace: null,
    screenshots: [],
    errorContext: null,
    logs: null,
    design: [],
  },
  ...extra,
});

const scenario = { id: 'CHECKOUT-001', critical: true, expectedResults: ['Total is $16.20'] } as Scenario;

const fa = (
  extra: Partial<FailureAnalysis> = {},
  fix: Partial<FailureAnalysis['fix']> = {},
): FailureAnalysis => ({
  category: 'APP_FUNCTIONAL',
  layer: 'frontend',
  failurePoint: 'step 3',
  expected: 'e',
  actual: 'a',
  difference: 'd',
  timing: { suspected: false, explanation: 'x' },
  rootCause: {
    statement: 'total() ignores discount',
    status: 'verified',
    facts: [],
    hypotheses: [],
    locations: [{ file: 'src/cart.ts', line: 42, symbol: 'total', role: 'cause', note: 'n' }],
    missingEvidence: [],
    investigation: [],
  },
  fix: {
    target: 'application',
    summary: 'Subtract the discount',
    requiredChanges: [],
    implementationSteps: [],
    alternatives: [],
    sideEffects: '',
    expectedAfterFix: '',
    acceptanceCriteria: [],
    verificationSteps: [],
    regressionScenarioIds: [],
    regressionAreas: [],
    ...fix,
  },
  ...extra,
});

const verdict = (extra: Partial<AiVerdict> = {}): AiVerdict => ({
  classification: 'PRODUCT_BUG',
  confidence: 0.9,
  summary: 's',
  reasoning: 'r',
  evidenceReviewed: ['src/cart.ts'],
  bug: {
    title: 't',
    severity: 'medium',
    category: 'functional',
    affectedPage: '/checkout',
    stepsToReproduce: ['x'],
    expectedResult: 'e',
    actualResult: 'a',
    suspectedRootCause: 'src/cart.ts:42',
  },
  testProblem: null,
  analysis: fa(),
  ...extra,
});

const ctx = { root, outcome: outcome(), scenario, knownScenarioIds: ['CHECKOUT-001', 'CHECKOUT-002'] };

describe('checkLocations', () => {
  it('keeps existing files and lines, and rejects invented ones with the reason', () => {
    const loc = (file: string, line: number | null) => ({
      file,
      line,
      symbol: null,
      role: 'cause' as const,
      note: '',
    });
    const { kept, rejected } = checkLocations(root, [
      loc('./src/cart.ts', 42),
      loc('src/cart.ts:7', null),
      loc('src/missing.ts', 1),
      loc('src/cart.ts', 500),
      loc('../outside.ts', 1),
    ]);
    expect(kept.map((l) => [l.file, l.line])).toEqual([
      ['src/cart.ts', 42],
      ['src/cart.ts', 7],
    ]);
    expect(rejected.map((r) => r.reason)).toEqual([
      'file does not exist',
      'line 500 is outside the file (50 lines)',
      'outside the project',
    ]);
  });
});

describe('reconcileVerdict', () => {
  it('leaves a consistent, grounded verdict unchanged', () => {
    const r = reconcileVerdict(verdict(), { ...ctx, scenario: { ...scenario, critical: false } });
    expect(r.notes).toEqual([]);
    expect(r.verdict).toEqual(verdict());
  });

  it('does not let a product bug carry a test or environment category', () => {
    const r = reconcileVerdict(verdict({ analysis: fa({ category: 'TEST_IMPLEMENTATION' }) }), ctx);
    expect(r.verdict.classification).toBe('UNKNOWN');
    expect(r.verdict.analysis.category).toBe('UNKNOWN');
    const t = reconcileVerdict(verdict({ classification: 'TEST_BUG', bug: null }), ctx);
    expect(t.verdict.analysis.category).toBe('TEST_IMPLEMENTATION');
    // The spec line Playwright reported is added as the test location.
    expect(t.verdict.analysis.rootCause.locations.some((l) => l.role === 'test' && l.line === 12)).toBe(true);
  });

  it('removes invented locations and stops calling the cause verified without one', () => {
    const v = verdict({
      analysis: fa({
        rootCause: {
          ...fa().rootCause,
          locations: [{ file: 'src/Checkout.tsx', line: 29, symbol: null, role: 'cause', note: '' }],
        },
      }),
    });
    const r = reconcileVerdict(v, ctx);
    expect(r.rejected).toEqual([{ file: 'src/Checkout.tsx', line: 29, reason: 'file does not exist' }]);
    expect(r.verdict.analysis.rootCause.locations).toEqual([]);
    expect(r.verdict.analysis.rootCause.status).toBe('hypothesis');
    expect(r.notes.join(' ')).toContain('no next checks');
  });

  it('turns the fix of an unconfirmed cause into an investigation', () => {
    const v = verdict({
      classification: 'UNKNOWN',
      bug: null,
      analysis: fa({
        category: 'UNKNOWN',
        rootCause: { ...fa().rootCause, status: 'unconfirmed', investigation: ['check'] },
      }),
    });
    expect(reconcileVerdict(v, ctx).verdict.analysis.fix.target).toBe('investigate');
  });

  it('flags fixes that only make the test quiet, and a fix of the wrong side', () => {
    const r = reconcileVerdict(
      verdict({
        analysis: fa(
          {},
          { target: 'test', summary: 'Increase the timeout to 30s and remove the total assertion' },
        ),
      }),
      ctx,
    );
    expect(r.notes.join(' ')).toContain('removes an assertion');
    expect(r.notes.join(' ')).toContain('raises a timeout');
    expect(r.notes.join(' ')).toContain('attributed to the application but the fix changes the test');
    expect(weakeningFindings(fa().fix)).toEqual([]);
    expect(weakeningFindings({ ...fa().fix, requiredChanges: ['Mark it test.skip until fixed'] })).toEqual([
      'skips the test',
    ]);
  });

  it('keeps only known regression scenarios, caps confidence without evidence, and raises critical-flow severity', () => {
    const r = reconcileVerdict(
      verdict({
        evidenceReviewed: [],
        analysis: fa({}, { regressionScenarioIds: ['CHECKOUT-002', 'NOPE-001', 'CHECKOUT-001'] }),
      }),
      ctx,
    );
    expect(r.verdict.analysis.fix.regressionScenarioIds).toEqual(['CHECKOUT-002']);
    expect(r.verdict.confidence).toBe(0.4);
    expect(r.verdict.bug!.severity).toBe('high');
  });
});

describe('ruleAnalysis', () => {
  it('describes an environment failure with its server log and no invented code location', () => {
    const o = outcome({
      error: { message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4173/' },
    });
    const a = ruleAnalysis(classifyByRules(o)!, o, scenario, {
      serverLog: '.qa/artifacts/runs/r/logs/app-server.log',
    });
    expect(a).toMatchObject({
      category: 'ENVIRONMENT_INFRA',
      layer: 'environment',
      fix: { target: 'environment' },
    });
    expect(a.rootCause.locations).toEqual([]);
    expect(a.rootCause.investigation).toEqual([
      'Read the app server log: .qa/artifacts/runs/r/logs/app-server.log',
    ]);
  });

  it('marks a flaky result unconfirmed and says the failing attempt was not kept', () => {
    const o = outcome({ status: 'flaky', attempts: 2, error: null });
    const a = ruleAnalysis(classifyByRules(o)!, o, scenario);
    expect(a.category).toBe('FLAKY');
    expect(a.rootCause.status).toBe('unconfirmed');
    expect(a.rootCause.missingEvidence[0]).toContain('failed attempt');
    expect(a.timing.suspected).toBe(true);
  });
});

describe('execution steps', () => {
  it('keeps top-level steps and the nested path to the failure', () => {
    const steps = executedSteps([
      { title: 'Open /', duration: 10 },
      {
        title: 'Check the total',
        duration: 20,
        error: { message: '\u001b[31mError: expected 1\u001b[39m\nmore' },
        steps: [
          { title: 'Read subtotal', duration: 1 },
          { title: 'Read total', duration: 2, error: { message: 'x' } },
        ],
      },
    ]);
    expect(steps).toEqual([
      { title: 'Open /', durationMs: 10, status: 'passed' },
      {
        title: 'Check the total',
        durationMs: 20,
        status: 'failed',
        error: 'Error: expected 1',
        failedPath: ['Read total'],
      },
    ]);
    expect(failedStepOf({ steps })!.index).toBe(1);
    expect(failedStepOf({})).toBeNull();
  });
});

describe('parseAssertion', () => {
  it('reads locator, expected, received and timeouts from Playwright errors', () => {
    expect(
      parseAssertion(
        "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button', { name: 'Open menu' })\nExpected: visible\nTimeout: 5000ms\nError: element(s) not found",
      ),
    ).toEqual({
      matcher: 'toBeVisible',
      message: null,
      locator: "getByRole('button', { name: 'Open menu' })",
      expected: 'visible',
      received: null,
      timeoutMs: 5000,
      elementNotFound: true,
      testTimeout: false,
    });
    expect(
      parseAssertion(
        "Error: error 'Enter your name' should be announced\n\nexpect(received).toBe(expected)\n\nExpected: true\nReceived: false",
      ),
    ).toMatchObject({
      message: "error 'Enter your name' should be announced",
      expected: 'true',
      received: 'false',
    });
    expect(parseAssertion(undefined)).toBeNull();
  });
});

describe('dashboard defect analysis', () => {
  const failure = {
    key: 'CHECKOUT-001@chromium-desktop',
    scenarioId: 'CHECKOUT-001',
    classification: 'TEST_BUG',
    confidence: 0.8,
    summary: 'Locator matches the subtotal',
    reasoning: 'r',
    bug: null,
    testProblem: 'wrong locator',
    analysis: fa({ category: 'TEST_IMPLEMENTATION' }, { acceptanceCriteria: ['Total row is read'] }),
    engineNotes: ['note'],
  };
  const data = {
    run: {
      outcomes: [
        outcome({
          steps: [
            { title: 'Open', durationMs: 1, status: 'passed' },
            { title: 'Read total', durationMs: 1, status: 'failed', error: 'x' },
          ],
        }),
      ],
      failures: [failure],
      issues: [],
    },
    scenarios: [{ id: 'CHECKOUT-001', title: 'Total', expectedResults: ['Total is $16.20'] }],
  } as unknown as Data;

  it('carries category, failed step and acceptance criteria into the defect', () => {
    const [d] = defectsOf(data);
    expect(d!.failedStep).toBe('Step 2 of 2: Read total');
    expect(d!.analysis).toMatchObject({ category: 'Test implementation issue', rootCauseStatus: 'verified' });
    expect(d!.acceptance).toEqual(['Total is $16.20', 'Total row is read']);
    expect(failedStepText(undefined)).toBe('');
    expect(analysisOf(undefined)).toBeNull();
  });

  it('makes a copyable Markdown bug report', () => {
    const text = bugReportText(defectsOf(data)[0]!);
    expect(text).toContain('- Tests: CHECKOUT-001');
    expect(text).toContain('- Failed at: Step 2 of 2: Read total');
    expect(text).toContain('## Acceptance criteria\n- Total is $16.20\n- Total row is read');
  });
});

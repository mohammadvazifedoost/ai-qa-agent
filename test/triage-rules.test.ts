import { describe, expect, it } from 'vitest';
import type { TestOutcome } from '../src/runner/results.js';
import { classifyByRules } from '../src/triage/rules.js';

function outcome(over: Partial<TestOutcome> & { message?: string; stack?: string }): TestOutcome {
  return {
    key: 'X-001@chromium-desktop',
    scenarioId: 'X-001',
    title: 'X-001: t',
    file: '.qa/tests/x.spec.ts',
    line: 1,
    project: 'chromium-desktop',
    tags: [],
    status: 'failed',
    attempts: 2,
    durationMs: 1,
    error: over.message ? { message: over.message, stack: over.stack } : null,
    annotations: [],
    artifacts: { video: null, trace: null, screenshots: [], errorContext: null, logs: null, design: [] },
    ...over,
  };
}

describe('classifyByRules', () => {
  it('classifies flaky tests as UNKNOWN without filing', () => {
    expect(classifyByRules(outcome({ status: 'flaky' }))?.classification).toBe('UNKNOWN');
  });

  it('classifies unreachable app as ENVIRONMENT_FAILURE', () => {
    const v = classifyByRules(outcome({ message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/' }));
    expect(v?.classification).toBe('ENVIRONMENT_FAILURE');
    expect(v?.confidence).toBeGreaterThan(0.9);
  });

  it('classifies browser crashes as INFRASTRUCTURE_FAILURE', () => {
    expect(classifyByRules(outcome({ message: "browserType.launch: Executable doesn't exist" }))?.classification).toBe(
      'INFRASTRUCTURE_FAILURE',
    );
  });

  it('classifies programming errors inside the spec as TEST_BUG', () => {
    const v = classifyByRules(
      outcome({ message: 'TypeError: foo is not a function', stack: 'TypeError: foo is not a function\n at .qa/tests/x.spec.ts:12' }),
    );
    expect(v?.classification).toBe('TEST_BUG');
  });

  it('leaves assertion failures to the AI', () => {
    expect(classifyByRules(outcome({ message: 'expect(locator).toHaveText(expected) failed' }))).toBeNull();
  });
});

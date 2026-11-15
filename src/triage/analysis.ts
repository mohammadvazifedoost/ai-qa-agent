/**
 * The engine's checks of a failure analysis. The AI diagnoses; this code makes sure the diagnosis
 * is consistent and grounded before anyone reads it: code locations must exist in the project,
 * the category must agree with the classification, a "verified" cause needs a verified location,
 * regression scenarios must exist, and a fix that would only make the test quiet is flagged.
 * Failures classified by rule get their analysis from the rule, without AI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { failedStepOf, type TestOutcome } from '../runner/results.js';
import type { Scenario } from '../scenarios/schema.js';
import type { RuleVerdict } from './rules.js';
import {
  CATEGORY_LABEL,
  CATEGORY_ORIGIN,
  type AiVerdict,
  type CodeLocation,
  type FailureAnalysis,
  type FailureCategory,
} from './schema.js';

export interface RejectedLocation {
  file: string;
  line: number | null;
  reason: string;
}

/** Keep only locations that exist in the project (file inside the root, line within the file). */
export function checkLocations(
  root: string,
  locations: readonly CodeLocation[],
): { kept: CodeLocation[]; rejected: RejectedLocation[] } {
  const kept: CodeLocation[] = [];
  const rejected: RejectedLocation[] = [];
  const base = path.resolve(root);
  for (const loc of locations) {
    // Accept "file.ts:42" in the file field, as models sometimes write it.
    const m = /^(.*?):(\d+)(?::\d+)?$/.exec(loc.file.trim());
    const file = (m && loc.line === null ? m[1]! : loc.file.trim()).replace(/^\.\//, '');
    const line = m && loc.line === null ? Number(m[2]) : loc.line;
    const abs = path.resolve(base, file);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      rejected.push({ file: loc.file, line: loc.line, reason: 'outside the project' });
      continue;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      rejected.push({ file: loc.file, line: loc.line, reason: 'file does not exist' });
      continue;
    }
    if (line !== null) {
      const lines = fs.readFileSync(abs, 'utf8').split('\n').length;
      if (line < 1 || line > lines) {
        rejected.push({ file: loc.file, line, reason: `line ${line} is outside the file (${lines} lines)` });
        continue;
      }
    }
    kept.push({ ...loc, file: path.relative(base, abs).split(path.sep).join('/'), line });
  }
  return { kept, rejected };
}

/** Recommendations that would make the test pass without fixing anything. */
const WEAKENING: Array<[RegExp, string]> = [
  [
    /\b(?:test|it|describe)\.(?:skip|fixme|only)\b|\bskip (?:the|this) (?:test|scenario|step|assertion)\b/i,
    'skips the test',
  ],
  [
    /\b(?:remove|delete|drop|comment(?:ing)? out)\b[^.\n]{0,40}\b(?:assert\w*|expect\w*|check)\b/i,
    'removes an assertion',
  ],
  [/\b(?:loosen|weaken|relax)\b/i, 'weakens an assertion'],
  [/\bchange (?:the )?expected (?:result|value|text|outcome)\b/i, "changes the scenario's expectation"],
  [
    /waitForTimeout|\bforce:\s*true\b|networkidle/,
    'uses a pattern the test rules forbid (fixed wait, forced click, networkidle)',
  ],
  [
    /\b(?:increase|raise|bump|extend)\b[^.\n]{0,30}\btimeout\b/i,
    'raises a timeout (only valid with a measured reason)',
  ],
  [/\b(?:suppress|swallow|ignore)\b[^.\n]{0,30}\b(?:error|exception|failure)s?\b/i, 'suppresses an error'],
];

export function weakeningFindings(fix: FailureAnalysis['fix']): string[] {
  const text = [fix.summary, ...fix.requiredChanges, ...fix.implementationSteps].join('\n');
  return WEAKENING.filter(([re]) => re.test(text)).map(([, what]) => what);
}

export interface ReconcileInput {
  root: string;
  outcome: TestOutcome;
  scenario: Scenario | null;
  knownScenarioIds: readonly string[];
}

export interface Reconciled {
  verdict: AiVerdict;
  notes: string[];
  rejected: RejectedLocation[];
}

const RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/** Make an AI verdict consistent and grounded; every change is explained in `notes`. */
export function reconcileVerdict(input: AiVerdict, ctx: ReconcileInput): Reconciled {
  const notes: string[] = [];
  const v: AiVerdict = structuredClone(input);
  const a = v.analysis;
  const origin = (c: FailureCategory) => CATEGORY_ORIGIN[c];

  // 1. Category and classification must say the same thing.
  const forced: Partial<Record<AiVerdict['classification'], FailureCategory>> = {
    TEST_BUG: 'TEST_IMPLEMENTATION',
    ENVIRONMENT_FAILURE: 'ENVIRONMENT_INFRA',
    INFRASTRUCTURE_FAILURE: 'ENVIRONMENT_INFRA',
  };
  const want = forced[v.classification];
  if (want && a.category !== want) {
    notes.push(
      `Category ${CATEGORY_LABEL[a.category]} does not fit ${v.classification}; set to ${CATEGORY_LABEL[want]}.`,
    );
    a.category = want;
  }
  if (
    (v.classification === 'PRODUCT_BUG' || v.classification === 'DESIGN_MISMATCH') &&
    origin(a.category) !== 'application'
  ) {
    notes.push(
      `${v.classification} with category ${CATEGORY_LABEL[a.category]} is contradictory; reported as unconfirmed instead of an application bug.`,
    );
    v.classification = 'UNKNOWN';
    a.category = 'UNKNOWN';
  }
  if (
    v.classification === 'UNKNOWN' &&
    (origin(a.category) === 'test' || origin(a.category) === 'environment')
  ) {
    notes.push(`An unconfirmed verdict cannot have category ${CATEGORY_LABEL[a.category]}; set to Unknown.`);
    a.category = 'UNKNOWN';
  }

  // 2. Locations must exist.
  const { kept, rejected } = checkLocations(ctx.root, a.rootCause.locations);
  for (const r of rejected)
    notes.push(`Removed location ${r.file}${r.line !== null ? `:${r.line}` : ''}: ${r.reason}.`);
  a.rootCause.locations = kept;
  if (a.category === 'TEST_IMPLEMENTATION' && ctx.outcome.error?.location) {
    const at = /^(.*):(\d+)$/.exec(ctx.outcome.error.location);
    if (at && !kept.some((l) => l.file === at[1] && l.line === Number(at[2]))) {
      a.rootCause.locations.push({
        file: at[1]!,
        line: Number(at[2]),
        symbol: null,
        role: 'test',
        note: 'Where Playwright reported the failure.',
      });
    }
  }

  // 3. "Verified" needs something verified; an unconfirmed verdict is never verified.
  if (v.classification === 'UNKNOWN' && a.rootCause.status === 'verified') {
    notes.push('A verified root cause contradicts an unconfirmed classification; marked as a hypothesis.');
    a.rootCause.status = 'hypothesis';
  }
  if (
    a.rootCause.status === 'verified' &&
    origin(a.category) === 'application' &&
    !a.rootCause.locations.some((l) => l.role === 'cause')
  ) {
    notes.push(
      'Root cause marked verified without a verified code location of the cause; marked as a hypothesis.',
    );
    a.rootCause.status = 'hypothesis';
  }
  if (a.rootCause.status !== 'verified' && a.rootCause.investigation.length === 0) {
    notes.push('The cause is not verified and the analysis named no next checks.');
  }
  if (a.rootCause.status === 'unconfirmed' && a.fix.target !== 'investigate') {
    notes.push(
      `The cause is unconfirmed, so the ${a.fix.target} change is a proposal to investigate, not a fix.`,
    );
    a.fix.target = 'investigate';
  }

  // 4. Evidence: a verdict that inspected nothing is not trusted.
  if (v.evidenceReviewed.length === 0 && v.confidence > 0.4) {
    notes.push('No evidence was listed as inspected; confidence capped at 40%.');
    v.confidence = 0.4;
  }

  // 5. The fix must address the cause, not silence the test.
  const weak = weakeningFindings(a.fix);
  if (weak.length) {
    notes.push(
      `Review the recommended fix: it ${weak.join('; ')}. A scenario is not resolved by weakening its test; its expected results stay as they are.`,
    );
  }
  if (origin(a.category) === 'application' && a.fix.target === 'test') {
    notes.push('The failure is attributed to the application but the fix changes the test.');
  }
  if (a.category === 'TEST_IMPLEMENTATION' && a.fix.target === 'application') {
    notes.push('The failure is attributed to the test but the fix changes the application.');
  }

  // 6. Regression scenarios must exist.
  const own = ctx.scenario?.id ?? ctx.outcome.scenarioId;
  const ids = [...new Set(a.fix.regressionScenarioIds)];
  const unknown = ids.filter((id) => !ctx.knownScenarioIds.includes(id));
  if (unknown.length) notes.push(`Dropped unknown regression scenario ids: ${unknown.join(', ')}.`);
  a.fix.regressionScenarioIds = ids.filter((id) => id !== own && ctx.knownScenarioIds.includes(id));

  // 7. A product bug in a critical flow is at least high.
  if (v.bug && ctx.scenario?.critical && RANK[v.bug.severity] > RANK.high) {
    notes.push(`Severity raised from ${v.bug.severity} to high: the failed scenario is a critical flow.`);
    v.bug.severity = 'high';
  }
  return { verdict: v, notes, rejected };
}

const firstLine = (s: string | undefined): string => (s ?? '').split('\n')[0]!.trim();

/** Where the test stopped, from the recorded steps and the error location. */
export function failurePointOf(o: TestOutcome): string {
  const step = failedStepOf(o);
  const at = o.error?.location ? ` (${o.error.location})` : '';
  if (step) {
    const nested = step.step.failedPath?.length ? ` › ${step.step.failedPath.join(' › ')}` : '';
    return `Step ${step.index + 1} "${step.step.title}"${nested}${at}`;
  }
  if (o.steps?.length) return `After the ${o.steps.length} named step(s) passed, outside any step${at}`;
  return o.error?.location ? `At ${o.error.location}` : 'Not recorded';
}

/** The analysis of a failure classified by a deterministic rule: facts from the error only. */
export function ruleAnalysis(
  rule: RuleVerdict,
  o: TestOutcome,
  scenario: Scenario | null,
  opts: { target?: string; serverLog?: string } = {},
): FailureAnalysis {
  const expected = scenario?.expectedResults.join('; ') ?? 'The test completes its steps and assertions.';
  const error = firstLine(o.error?.message);
  const facts = error ? [`Playwright error: ${error}`] : [];
  if (o.error?.location) facts.push(`Reported at ${o.error.location}`);
  const base = {
    failurePoint: failurePointOf(o),
    expected,
    timing: { suspected: false, explanation: 'Not assessed: classified by a deterministic rule.' },
  };
  const fixBase = { alternatives: [], regressionScenarioIds: [] };
  if (o.status === 'flaky') {
    return {
      ...base,
      category: 'FLAKY',
      layer: 'unknown',
      actual: `Failed on at least one attempt and passed on a retry (${o.attempts} attempts).`,
      difference: 'The same test gives different results on the same build, so its outcome is not reliable.',
      timing: {
        suspected: true,
        explanation:
          'Passing on retry without any change points to timing, asynchronous work, shared state or unstable data.',
      },
      rootCause: {
        statement: 'Unconfirmed: the test is intermittent; the failing attempt was not analyzed.',
        status: 'unconfirmed',
        facts: [`Passed on retry after ${o.attempts} attempt(s).`],
        hypotheses: [],
        locations: [],
        missingEvidence: [
          'the error, screenshot and trace of the failed attempt (only the final, passing attempt is kept)',
        ],
        investigation: [
          `Run the test several times in a row: npx ai-qa-agent test --grep ${o.scenarioId ?? '<id>'}`,
          'Open the trace of a failing attempt and look for a wait that depends on timing or on data left by another test.',
        ],
      },
      fix: {
        ...fixBase,
        target: 'investigate',
        summary: 'Find what makes the result change between attempts before changing the app or the test.',
        requiredChanges: [],
        implementationSteps: [],
        sideEffects: 'None until the cause is known.',
        expectedAfterFix: 'The test passes on its first attempt on every run.',
        acceptanceCriteria: ['The test passes on the first attempt in several consecutive runs.'],
        verificationSteps: ['Re-run the test at least five times without retries; every run passes.'],
        regressionAreas: [],
      },
    };
  }
  if (rule.classification === 'TEST_BUG') {
    const at = /^(.*):(\d+)$/.exec(o.error?.location ?? '');
    return {
      ...base,
      category: 'TEST_IMPLEMENTATION',
      layer: 'test',
      actual: `The test code threw: ${error}`,
      difference:
        'The test stopped on a programming error in its own code before it could check the application.',
      rootCause: {
        statement: rule.summary,
        status: 'verified',
        facts,
        hypotheses: [],
        locations: at
          ? [
              {
                file: at[1]!,
                line: Number(at[2]),
                symbol: null,
                role: 'test',
                note: 'Where the error was thrown.',
              },
            ]
          : [],
        missingEvidence: [],
        investigation: [],
      },
      fix: {
        ...fixBase,
        target: 'test',
        summary: `Fix the programming error in the test${o.error?.location ? ` at ${o.error.location}` : ''}.`,
        requiredChanges: [
          `Correct the code that throws "${error}"${o.error?.location ? ` at ${o.error.location}` : ''}.`,
        ],
        implementationSteps: [
          'Open the location above and fix the error (wrong import, undefined name, wrong call).',
          'Keep every assertion of the scenario; only the broken code changes.',
        ],
        sideEffects: 'Other tests in the same spec file share its helpers and imports.',
        expectedAfterFix: "The test runs to its assertions and checks the scenario's expected results.",
        acceptanceCriteria: ['The test runs every step of the scenario without a programming error.'],
        verificationSteps: [`npx ai-qa-agent test --grep ${o.scenarioId ?? '<id>'}`],
        regressionAreas: ['Other tests in the same spec file'],
      },
    };
  }
  const infra = rule.classification === 'INFRASTRUCTURE_FAILURE';
  const missingBrowser = /Executable doesn't exist/.test(o.error?.message ?? '');
  return {
    ...base,
    category: 'ENVIRONMENT_INFRA',
    layer: 'environment',
    actual: infra
      ? `The browser or runner failed: ${error}`
      : `The application could not be reached: ${error}`,
    difference: 'The test could not exercise the application, so the scenario was not checked at all.',
    rootCause: {
      statement: rule.summary,
      status: 'verified',
      facts: [...facts, ...(opts.target ? [`The run targeted ${opts.target}`] : [])],
      hypotheses: [],
      locations: [],
      missingEvidence: [],
      investigation: opts.serverLog && !infra ? [`Read the app server log: ${opts.serverLog}`] : [],
    },
    fix: {
      ...fixBase,
      target: 'environment',
      summary: missingBrowser
        ? 'Install the Playwright browsers.'
        : infra
          ? 'Restore the test machine (browser, disk space, memory) and run again.'
          : 'Make the application reachable for the tests and run again.',
      requiredChanges: missingBrowser
        ? ['Run `npx playwright install` on the machine that runs the tests.']
        : infra
          ? ['Check free disk space and memory, and that the browser starts on its own.']
          : [
              `Check that the app starts and listens${opts.target ? ` at ${opts.target}` : ''}.`,
              'Check the build and start commands of the app section in .qa/config.ts.',
            ],
      implementationSteps: [],
      sideEffects: 'Every test of the run is affected by the same environment.',
      expectedAfterFix: 'The test reaches the application and checks the scenario.',
      acceptanceCriteria: ['The test reaches the application and completes its steps.'],
      verificationSteps: ['Run the tests again: npx ai-qa-agent test'],
      regressionAreas: ['The whole run: results of other tests in this run may be affected as well.'],
    },
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QaConfigSchema } from '../src/config/schema.js';
import { qaPaths, runDir } from '../src/core/paths.js';
import type { QaContext } from '../src/pipeline/context.js';
import {
  collectFailures,
  planFile,
  planStatus,
  PlanRefused,
  reconcilePlan,
  renderPlan,
  writeBugFixPlan,
  type PlanBug,
} from '../src/plan/plan.js';
import type { TestOutcome, TestRunResult } from '../src/runner/results.js';
import type { Scenario } from '../src/scenarios/schema.js';
import { StateStore } from '../src/state/state.js';
import { makeProject } from './helpers.js';

const RUN = '2026-09-24_15-24-46';

const outcome = (
  id: string,
  status: TestOutcome['status'],
  extra: Partial<TestOutcome> = {},
): TestOutcome => ({
  key: `${id}@chromium-desktop`,
  scenarioId: id,
  title: `${id}: title of ${id}`,
  file: '.qa/tests/checkout.spec.ts',
  line: 1,
  project: 'chromium-desktop',
  tags: [],
  status,
  attempts: 1,
  durationMs: 1,
  error: status === 'passed' ? null : { message: `${id} failed: expected $16.20, got $18.00` },
  annotations: [],
  artifacts: {
    video: null,
    trace: null,
    screenshots: [`.qa/artifacts/runs/${RUN}/screens/${id}.png`],
    errorContext: null,
    logs: null,
    design: [],
  },
  ...extra,
});

const scenario = (id: string): Scenario => ({
  id,
  page: '/checkout',
  feature: 'checkout',
  category: 'functional',
  priority: 'high',
  title: `Scenario ${id}`,
  preconditions: [],
  steps: ['Add a mug', 'Apply SAVE10'],
  expectedResults: ['Total is $16.20'],
  viewport: 'desktop',
  source: { figma: false, code: true },
  testData: [],
  design: null,
  rationale: 'money',
  approved: true,
});

const runResult = (outcomes: TestOutcome[]): TestRunResult => ({
  runId: RUN,
  runDir: '',
  outcomes,
  globalErrors: [],
  exitCode: 1,
  stats: { passed: 0, failed: outcomes.length, flaky: 0, skipped: 0 },
});

const bug = (id: string, failureKeys: string[], extra: Partial<PlanBug> = {}): PlanBug => ({
  id,
  title: `Bug ${id}`,
  severity: 'high',
  page: '/checkout',
  failureKeys,
  expected: 'Total is $16.20',
  actual: 'Total stays $18.00',
  rootCause: `Cause of ${id}`,
  locations: ['src/cart.ts:42'],
  fix: `Fix ${id}`,
  codeHint: null,
  risks: 'None',
  verify: ['Apply SAVE10 and check the total'],
  effort: 'S',
  relatedIds: [],
  ...extra,
});

describe('collectFailures', () => {
  it('takes failed and flaky tests with their scenario, error and first screenshot', () => {
    const run = runResult([
      outcome('A-001', 'failed'),
      outcome('A-002', 'flaky'),
      outcome('A-003', 'passed'),
    ]);
    const failures = collectFailures(run, [scenario('A-001')]);
    expect(failures.map((f) => [f.key, f.status, f.scenario?.steps ?? null])).toEqual([
      ['A-001@chromium-desktop', 'failed', ['Add a mug', 'Apply SAVE10']],
      ['A-002@chromium-desktop', 'flaky', null],
    ]);
    expect(failures[0]).toMatchObject({
      error: 'A-001 failed: expected $16.20, got $18.00',
      screenshot: `.qa/artifacts/runs/${RUN}/screens/A-001.png`,
    });
  });
});

describe('reconcilePlan', () => {
  const failures = collectFailures(
    runResult([
      outcome('A-001', 'failed'),
      outcome('A-002', 'failed'),
      outcome('A-003', 'failed'),
      outcome('A-004', 'failed'),
    ]),
    [],
  );
  const k = (id: string) => `${id}@chromium-desktop`;

  it('keeps the AI order, drops unknown keys and bugs without failures, and classifies what is left', () => {
    const plan = reconcilePlan(
      {
        bugs: [
          bug('BUG-1', [k('A-001'), 'nope@chromium-desktop']),
          bug('BUG-2', [k('A-002'), k('A-001')]), // A-001 already explained by BUG-1
          bug('BUG-3', ['nope@chromium-desktop']), // explains nothing in this run
        ],
        order: ['BUG-2', 'BUG-9', 'BUG-1'],
        notIncluded: [
          { failureKey: k('A-003'), kind: 'TEST_BUG', reason: 'Stale locator' },
          { failureKey: k('A-002'), kind: 'FLAKY', reason: 'ignored: BUG-2 explains it' },
        ],
        notes: ['n'],
      },
      failures,
    );
    expect(plan.bugs.map((b) => [b.id, b.failureKeys])).toEqual([
      ['BUG-2', [k('A-002')]],
      ['BUG-1', [k('A-001')]],
    ]);
    expect(plan.notIncluded).toEqual([
      { key: k('A-003'), title: 'A-003: title of A-003', kind: 'TEST_BUG', reason: 'Stale locator' },
      {
        key: k('A-004'),
        title: 'A-004: title of A-004',
        kind: 'UNKNOWN',
        reason: 'The AI did not classify this failure.',
      },
    ]);
    expect(plan.notes).toEqual(['n']);
  });
});

describe('renderPlan', () => {
  it('renders the summary, each bug in order, evidence links and the not-included list', () => {
    const outcomes = [outcome('A-001', 'failed'), outcome('A-002', 'failed')];
    const failures = collectFailures(runResult(outcomes), [scenario('A-001'), scenario('A-002')]);
    const plan = reconcilePlan(
      {
        bugs: [
          bug('BUG-1', ['A-001@chromium-desktop']),
          bug('BUG-2', ['A-002@chromium-desktop'], {
            codeHint: 'total = subtotal - discount;',
            relatedIds: ['BUG-1'],
            effort: 'M',
          }),
        ],
        order: ['BUG-2', 'BUG-1'],
        notIncluded: [],
        notes: [],
      },
      failures,
    );
    const md = renderPlan({
      runId: RUN,
      baseUrl: 'http://127.0.0.1:5173',
      generatedAt: '2026-09-24T16:00:00.000Z',
      plan: {
        ...plan,
        notIncluded: [{ key: 'A-003@chromium-desktop', title: 'A | B', kind: 'TEST_BUG', reason: 'stale' }],
      },
      failures,
      evidenceBase: 'docs/bug-fix-plan',
    });
    expect(md).toContain('# Bug-fix plan: run 2026-09-24 15:24:46');
    expect(md).toContain('| 1 | [Bug BUG-2](#bug-1) | high | /checkout | M | `src/cart.ts` |');
    expect(md).toContain('| 2 | [Bug BUG-1](#bug-2) | high | /checkout | S | `src/cart.ts` |');
    expect(md.indexOf('## 1. Bug BUG-2')).toBeLessThan(md.indexOf('## 2. Bug BUG-1'));
    expect(md).toContain('1. Add a mug\n2. Apply SAVE10');
    expect(md).toContain('```\ntotal = subtotal - discount;\n```');
    expect(md).toContain('- #2 Bug BUG-1');
    expect(md).toContain('`npx ai-qa-agent test --grep A-002`');
    expect(md).toContain(`[A-002 screenshot](../../.qa/artifacts/runs/${RUN}/screens/A-002.png)`);
    expect(md).toContain('| A-003@chromium-desktop | A \\| B | TEST_BUG | stale |');
  });
});

function setup(opts: { outcomes?: TestOutcome[]; plansDir?: string } = {}) {
  const root = makeProject({
    '.qa/scenarios/checkout.json': {
      page: '/checkout',
      generatedAt: 'x',
      inputHash: 'x',
      scenarios: [scenario('A-001')],
      removed: [],
    },
  });
  const paths = qaPaths(root);
  const state = new StateStore(paths.state);
  const record = state.startRun({ command: 'test' });
  record.id = RUN;
  state.save();
  const dir = runDir(paths, RUN);
  fs.mkdirSync(dir, { recursive: true });
  const outcomes = opts.outcomes ?? [outcome('A-001', 'failed')];
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ ...runResult(outcomes), runDir: dir }));
  const config = QaConfigSchema.parse({
    project: { name: 'x' },
    app: { baseUrl: 'http://127.0.0.1:5173' },
    source: { include: ['src'] },
    ...(opts.plansDir ? { plans: { dir: opts.plansDir } } : {}),
  });
  const prompts: string[] = [];
  const ai = {
    run: async (task: { prompt: string; tools?: string[] }) => {
      prompts.push(task.prompt);
      expect(task.tools).toEqual(['Read', 'Glob', 'Grep']);
      return {
        output: {
          bugs: [bug('BUG-1', ['A-001@chromium-desktop'])],
          order: ['BUG-1'],
          notIncluded: [],
          notes: [],
        },
        costUsd: 0.12,
      };
    },
  };
  const ctx = { root, paths, state, config, ai } as unknown as QaContext;
  return { ctx, root, prompts };
}

describe('writeBugFixPlan', () => {
  it('writes the plan into docs/bug-fix-plan/ in the project, and refuses to overwrite it', async () => {
    const { ctx, root, prompts } = setup();
    const res = await writeBugFixPlan(ctx);
    expect(res).toMatchObject({
      runId: RUN,
      bugs: 1,
      notIncluded: 0,
      costUsd: 0.12,
      file: `docs/bug-fix-plan/${RUN}-plan.md`,
    });
    const md = fs.readFileSync(path.join(root, 'docs', 'bug-fix-plan', `${RUN}-plan.md`), 'utf8');
    expect(md).toContain('## 1. Bug BUG-1');
    expect(prompts[0]).toContain('A-001 failed: expected $16.20, got $18.00');
    expect(prompts[0]).toContain('Apply SAVE10');
    await expect(writeBugFixPlan(ctx)).rejects.toThrow(PlanRefused);
    await expect(writeBugFixPlan(ctx)).rejects.toThrow(/--force/);
    await expect(writeBugFixPlan(ctx, { force: true })).resolves.toMatchObject({ bugs: 1 });
    expect(planStatus(ctx, RUN)).toEqual({ failures: 1, exists: true, file: `docs/bug-fix-plan/${RUN}-plan.md` });
  });

  it('uses plans.dir and --dir for the folder', () => {
    const { ctx } = setup({ plansDir: 'plans' });
    expect(planFile(ctx, RUN)).toBe(path.join(ctx.root, 'plans', `${RUN}-plan.md`));
    expect(planFile(ctx, RUN, 'other/dir')).toBe(path.join(ctx.root, 'other', 'dir', `${RUN}-plan.md`));
  });

  it('writes nothing and calls no AI when the run has no failed tests', async () => {
    const { ctx, root, prompts } = setup({ outcomes: [outcome('A-001', 'passed')] });
    const res = await writeBugFixPlan(ctx);
    expect(res).toMatchObject({ bugs: 0, file: null });
    expect(prompts).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'docs'))).toBe(false);
    expect(planStatus(ctx, RUN)).toMatchObject({ failures: 0, exists: false });
  });
});

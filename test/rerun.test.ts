import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { qaPaths, runDir } from '../src/core/paths.js';
import type { QaContext } from '../src/pipeline/context.js';
import { mergeRerun, runScenarioTest, runScenarioTests, type Runner } from '../src/runner/rerun.js';
import { TestRunResultSchema, type TestOutcome, type TestRunResult } from '../src/runner/results.js';
import type { Scenario, ScenarioFile } from '../src/scenarios/schema.js';
import { StateStore } from '../src/state/state.js';
import { makeProject } from './helpers.js';

const outcome = (
  scenarioId: string,
  status: TestOutcome['status'],
  project = 'chromium-desktop',
): TestOutcome => ({
  key: `${scenarioId}@${project}`,
  scenarioId,
  title: `${scenarioId}: t`,
  file: '.qa/tests/checkout.spec.ts',
  line: 1,
  project,
  tags: [],
  status,
  attempts: 1,
  durationMs: 10,
  error: status === 'failed' ? { message: 'boom' } : null,
  annotations: [],
  artifacts: { video: null, trace: null, screenshots: [], errorContext: null, logs: null, design: [] },
});

const result = (runId: string, outcomes: TestOutcome[], globalErrors: string[] = []): TestRunResult => ({
  runId,
  runDir: `/runs/${runId}`,
  outcomes,
  globalErrors,
  exitCode: 0,
  stats: {
    passed: outcomes.filter((o) => o.status === 'passed').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    flaky: 0,
    skipped: 0,
  },
});

describe('mergeRerun', () => {
  it('replaces every outcome of the scenario, marks them re-run and recounts', () => {
    const target = result('r1', [
      outcome('A-001', 'passed'),
      outcome('A-002', 'failed'),
      outcome('A-002', 'failed', 'chromium-mobile'),
    ]);
    const merged = mergeRerun(target, [outcome('A-002', 'passed')], 'A-002', '2026-09-24T15:00:00.000Z');
    expect(merged.outcomes.map((o) => [o.key, o.status, o.rerunAt])).toEqual([
      ['A-001@chromium-desktop', 'passed', undefined],
      ['A-002@chromium-desktop', 'passed', '2026-09-24T15:00:00.000Z'],
    ]);
    expect(merged.stats).toEqual({ passed: 2, failed: 0, flaky: 0, skipped: 0 });
    expect(merged.runId).toBe('r1');
  });
});

function setup(opts: { withRun?: boolean; spec?: string } = {}) {
  const scenario: Scenario = {
    id: 'CHECKOUT-001',
    page: '/checkout',
    feature: 'checkout',
    category: 'functional',
    priority: 'medium',
    title: 'One',
    preconditions: [],
    steps: ['Open /checkout'],
    expectedResults: ['It works'],
    viewport: 'desktop',
    source: { figma: false, code: true },
    testData: [],
    design: null,
    rationale: 'why',
    approved: true,
  };
  const file = { page: '/checkout', generatedAt: 'x', inputHash: 'h', scenarios: [scenario], removed: [] };
  const root = makeProject({
    '.qa/scenarios/checkout.json': file satisfies Partial<ScenarioFile>,
    '.qa/tests/checkout.spec.ts':
      opts.spec ?? "test('CHECKOUT-001: one', async ({ page }) => {\n  await page.goto('/');\n});\n",
  });
  const paths = qaPaths(root);
  const state = new StateStore(paths.state);
  const ctx = { root, paths, state, config: {} } as unknown as QaContext;
  let runId: string | undefined;
  if (opts.withRun) {
    runId = state.startRun({ command: 'test' }).id;
    const dir = runDir(paths, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'results.json'),
      JSON.stringify(result(runId, [outcome('CHECKOUT-001', 'failed'), outcome('HOME-001', 'passed')])),
    );
  }
  const readRun = (id: string) =>
    TestRunResultSchema.parse(
      JSON.parse(fs.readFileSync(path.join(runDir(paths, id), 'results.json'), 'utf8')),
    );
  return { ctx, runId, readRun };
}

describe('runScenarioTest', () => {
  it('runs only that test and merges its result into the selected run', async () => {
    const { ctx, runId, readRun } = setup({ withRun: true });
    const calls: Array<{ filter: unknown; dir: string | undefined }> = [];
    const runner: Runner = async (_ctx, id, filter, dir) => {
      calls.push({ filter, dir });
      return result(id, [outcome('CHECKOUT-001', 'passed')]);
    };
    const res = await runScenarioTest(ctx, 'checkout-001', { runId, runner });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filter).toEqual({
      scenarioIds: ['CHECKOUT-001'],
      files: [path.join(ctx.paths.testsDir, 'checkout.spec.ts')],
    });
    expect(calls[0]!.dir).toMatch(/[\\/]reruns[\\/]CHECKOUT-001_/);
    expect(calls[0]!.dir!.startsWith(runDir(ctx.paths, runId!))).toBe(true);
    expect(res).toMatchObject({ runId, merged: true });
    expect(readRun(runId!).outcomes.map((o) => [o.scenarioId, o.status])).toEqual([
      ['HOME-001', 'passed'],
      ['CHECKOUT-001', 'passed'],
    ]);
    expect(readRun(runId!).stats.failed).toBe(0);
  });

  it('starts a new run when there is none yet', async () => {
    const { ctx, readRun } = setup();
    const runner: Runner = async (c, id, _f, dir) => {
      expect(dir).toBeUndefined();
      const r = result(id, [outcome('CHECKOUT-001', 'failed')]);
      fs.mkdirSync(runDir(c.paths, id), { recursive: true });
      fs.writeFileSync(path.join(runDir(c.paths, id), 'results.json'), JSON.stringify(r));
      return r;
    };
    const res = await runScenarioTest(ctx, 'CHECKOUT-001', { runner });
    expect(res.merged).toBe(false);
    expect(ctx.state.data.runs.map((r) => [r.id, r.status])).toEqual([[res.runId, 'completed']]);
    expect(readRun(res.runId).outcomes).toHaveLength(1);
  });

  it('leaves the run untouched when the test did not run', async () => {
    const { ctx, runId, readRun } = setup({ withRun: true });
    const runner: Runner = async (_c, id) => result(id, [], ['SyntaxError in checkout.spec.ts']);
    await expect(runScenarioTest(ctx, 'CHECKOUT-001', { runId, runner })).rejects.toThrow(
      /CHECKOUT-001 did not run: SyntaxError in checkout.spec.ts/,
    );
    expect(readRun(runId!).outcomes[0]!.status).toBe('failed');
  });

  it('refuses scenarios without a test', async () => {
    const { ctx } = setup({ spec: "test('CHECKOUT-009: other', async () => {});\n" });
    await expect(
      runScenarioTest(ctx, 'CHECKOUT-001', { runner: async () => result('x', []) }),
    ).rejects.toThrow(/CHECKOUT-001 has no test yet/);
    await expect(
      runScenarioTest(ctx, 'CHECKOUT-404', { runner: async () => result('x', []) }),
    ).rejects.toThrow(/Unknown scenario CHECKOUT-404/);
  });
});

describe('runScenarioTests', () => {
  it('runs several tests in one go, merges those that ran and reports the rest', async () => {
    const { ctx, runId, readRun } = setup({
      withRun: true,
      spec: "test('CHECKOUT-001: one', async () => {});\ntest('CHECKOUT-002: two', async () => {});\n",
    });
    const file = path.join(ctx.paths.scenariosDir, 'checkout.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.scenarios.push({ ...data.scenarios[0], id: 'CHECKOUT-002', title: 'Two' });
    fs.writeFileSync(file, JSON.stringify(data));
    let filter: unknown;
    const runner: Runner = async (_c, id, f, dir) => {
      filter = f;
      expect(dir).toMatch(/[\\/]reruns[\\/]batch_/);
      return result(id, [outcome('CHECKOUT-001', 'passed')]);
    };
    const res = await runScenarioTests(ctx, ['CHECKOUT-001', 'checkout-002'], { runId, runner });
    expect(filter).toEqual({
      scenarioIds: ['CHECKOUT-001', 'CHECKOUT-002'],
      files: [path.join(ctx.paths.testsDir, 'checkout.spec.ts')],
    });
    expect(res).toMatchObject({ merged: true, missing: ['CHECKOUT-002'] });
    expect(readRun(runId!).outcomes.map((o) => [o.scenarioId, o.status])).toEqual([
      ['HOME-001', 'passed'],
      ['CHECKOUT-001', 'passed'],
    ]);
  });
});

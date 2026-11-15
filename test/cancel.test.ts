import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QaConfigSchema } from '../src/config/schema.js';
import { Cancelled, run } from '../src/core/process.js';
import { qaPaths, runDir } from '../src/core/paths.js';
import type { QaContext } from '../src/pipeline/context.js';
import { writeBugFixPlan } from '../src/plan/plan.js';
import { runScenarioTests, type Runner } from '../src/runner/rerun.js';
import type { TestOutcome } from '../src/runner/results.js';
import type { Scenario } from '../src/scenarios/schema.js';
import { StateStore } from '../src/state/state.js';
import { makeProject } from './helpers.js';

const RUN = '2026-09-25_10-00-00';

describe('run() with an AbortSignal', () => {
  it('kills a long-running child and rejects with Cancelled', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toBeInstanceOf(Cancelled);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does not start anything when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      run(process.execPath, ['-e', 'process.exit(0)'], { signal: ac.signal }),
    ).rejects.toBeInstanceOf(Cancelled);
  });

  it('still resolves normally without an abort', async () => {
    const ac = new AbortController();
    const res = await run(process.execPath, ['-e', 'console.log("hi")'], { signal: ac.signal });
    expect(res).toMatchObject({ code: 0, stdout: 'hi\n' });
  });
});

const scenario: Scenario = {
  id: 'A-001',
  page: '/a',
  feature: 'a',
  category: 'functional',
  priority: 'high',
  title: 'One',
  preconditions: [],
  steps: ['Open /a'],
  expectedResults: ['Works'],
  viewport: 'desktop',
  source: { figma: false, code: true },
  testData: [],
  design: null,
  rationale: 'r',
  approved: true,
};

const outcome = (status: TestOutcome['status']): TestOutcome => ({
  key: 'A-001@chromium-desktop',
  scenarioId: 'A-001',
  title: 'A-001: One',
  file: '.qa/tests/a.spec.ts',
  line: 1,
  project: 'chromium-desktop',
  tags: [],
  status,
  attempts: 1,
  durationMs: 1,
  error: status === 'failed' ? { message: 'boom' } : null,
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
});

function setup() {
  const root = makeProject({
    '.qa/scenarios/a.json': {
      page: '/a',
      generatedAt: 'x',
      inputHash: 'x',
      scenarios: [scenario],
      removed: [],
    },
    '.qa/tests/a.spec.ts': "test('A-001: One', async () => {});\n",
  });
  const paths = qaPaths(root);
  const state = new StateStore(paths.state);
  const record = state.startRun({ command: 'test' });
  record.id = RUN;
  state.save();
  const dir = runDir(paths, RUN);
  fs.mkdirSync(dir, { recursive: true });
  const results = {
    runId: RUN,
    runDir: dir,
    outcomes: [outcome('failed')],
    globalErrors: [],
    exitCode: 1,
    stats: { passed: 0, failed: 1, flaky: 0, skipped: 0 },
  };
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results));
  const config = QaConfigSchema.parse({
    project: { name: 'x' },
    app: { baseUrl: 'http://127.0.0.1:5173' },
    source: { include: ['src'] },
  });
  const ctx = { root, paths, state, config } as unknown as QaContext;
  return { ctx, root, resultsFile: path.join(dir, 'results.json') };
}

describe('cancelling jobs', () => {
  it('passes the signal to the runner and merges nothing when the run is cancelled', async () => {
    const { ctx, resultsFile } = setup();
    const before = fs.readFileSync(resultsFile, 'utf8');
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const runner: Runner = async (_c, _id, _f, _dir, signal) => {
      seen = signal;
      ac.abort();
      throw new Cancelled();
    };
    await expect(
      runScenarioTests(ctx, ['A-001'], { runId: RUN, runner, signal: ac.signal }),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(seen).toBe(ac.signal);
    expect(fs.readFileSync(resultsFile, 'utf8')).toBe(before);
  });

  it('records a cancelled new run as failed with "Cancelled"', async () => {
    const { ctx } = setup();
    ctx.state.data.runs.length = 0;
    const runner: Runner = async () => {
      throw new Cancelled();
    };
    await expect(runScenarioTests(ctx, ['A-001'], { runner })).rejects.toBeInstanceOf(Cancelled);
    expect(ctx.state.data.runs.map((r) => [r.status, r.error])).toEqual([['failed', 'Cancelled']]);
  });

  it('writes no plan when the AI call is cancelled', async () => {
    const { ctx, root } = setup();
    let seen: AbortSignal | undefined;
    (ctx as { ai: unknown }).ai = {
      run: async (task: { signal?: AbortSignal }) => {
        seen = task.signal;
        throw new Cancelled();
      },
    };
    const ac = new AbortController();
    await expect(writeBugFixPlan(ctx, { signal: ac.signal })).rejects.toBeInstanceOf(Cancelled);
    expect(seen).toBe(ac.signal);
    expect(fs.existsSync(path.join(root, 'docs'))).toBe(false);
  });
});

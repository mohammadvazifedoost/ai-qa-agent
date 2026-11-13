import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { qaPaths, runDir } from '../src/core/paths.js';
import { deleteMedia, MediaDeleteError } from '../src/runner/media.js';
import { TestRunResultSchema, type TestOutcome, type TestRunResult } from '../src/runner/results.js';
import { makeProject } from './helpers.js';

const RUN = '2026-11-13_10-00-00';
const DIR = `.qa/artifacts/runs/${RUN}`;
const SHOT = `${DIR}/screenshots/A-001_chromium-desktop.png`;
const SHOT2 = `${DIR}/screenshots/A-001_chromium-desktop-1.png`;
const VIDEO = `${DIR}/videos/A-001_chromium-desktop.webm`;
const TRACE = `${DIR}/traces/A-001_chromium-desktop.zip`;
const KEY = 'A-001@chromium-desktop';

const outcome = (artifacts: Partial<TestOutcome['artifacts']> = {}): TestOutcome => ({
  key: KEY,
  scenarioId: 'A-001',
  title: 'A-001: t',
  file: '.qa/tests/a.spec.ts',
  line: 1,
  project: 'chromium-desktop',
  tags: [],
  status: 'failed',
  attempts: 1,
  durationMs: 10,
  error: { message: 'boom' },
  annotations: [],
  artifacts: {
    video: VIDEO,
    trace: TRACE,
    screenshots: [SHOT, SHOT2],
    errorContext: null,
    logs: null,
    design: [],
    ...artifacts,
  },
});

function setup(artifacts: Partial<TestOutcome['artifacts']> = {}, files = [SHOT, SHOT2, VIDEO, TRACE]) {
  const result: TestRunResult = {
    runId: RUN,
    runDir: DIR,
    outcomes: [outcome(artifacts)],
    globalErrors: [],
    exitCode: 1,
    stats: { passed: 0, failed: 1, flaky: 0, skipped: 0 },
  };
  const root = makeProject({
    [`${DIR}/results.json`]: result,
    '.qa/config.ts': 'secret',
    ...Object.fromEntries(files.map((f) => [f, 'bytes'])),
  });
  const ctx = { root, paths: qaPaths(root) };
  const saved = (): TestOutcome['artifacts'] =>
    TestRunResultSchema.parse(
      JSON.parse(fs.readFileSync(path.join(runDir(ctx.paths, RUN), 'results.json'), 'utf8')),
    ).outcomes[0]!.artifacts;
  const exists = (p: string): boolean => fs.existsSync(path.join(root, p));
  return { ctx, saved, exists };
}

const rejects = (fn: () => unknown, status: number): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MediaDeleteError);
    expect((err as MediaDeleteError).status).toBe(status);
    return;
  }
  throw new Error('expected a MediaDeleteError');
};

describe('deleteMedia', () => {
  it('deletes one screenshot and removes it from results.json', () => {
    const { ctx, saved, exists } = setup();
    const res = deleteMedia(ctx, { runId: RUN, key: KEY, file: SHOT });
    expect(res).toMatchObject({ removed: [SHOT], missing: [], screenshots: [SHOT2], video: VIDEO });
    expect(exists(SHOT)).toBe(false);
    expect(exists(SHOT2)).toBe(true);
    expect(saved().screenshots).toEqual([SHOT2]);
    expect(saved().video).toBe(VIDEO);
  });

  it('deletes the video and sets it to null', () => {
    const { ctx, saved, exists } = setup();
    deleteMedia(ctx, { runId: RUN, key: KEY, file: VIDEO });
    expect(exists(VIDEO)).toBe(false);
    expect(saved().video).toBeNull();
    expect(saved().screenshots).toEqual([SHOT, SHOT2]);
  });

  it('deletes all media of a result without touching the trace', () => {
    const { ctx, saved, exists } = setup();
    const res = deleteMedia(ctx, { runId: RUN, key: KEY });
    expect(res.removed).toEqual([SHOT, SHOT2, VIDEO]);
    expect([SHOT, SHOT2, VIDEO].some(exists)).toBe(false);
    expect(exists(TRACE)).toBe(true);
    expect(saved()).toMatchObject({ video: null, screenshots: [], trace: TRACE });
  });

  it('drops a file that is already gone from disk and reports it as missing', () => {
    const { ctx, saved } = setup({}, [SHOT2, VIDEO]);
    const res = deleteMedia(ctx, { runId: RUN, key: KEY, file: SHOT });
    expect(res.missing).toEqual([SHOT]);
    expect(saved().screenshots).toEqual([SHOT2]);
  });

  it('refuses paths the result does not reference as media, including traversal', () => {
    const { ctx, saved, exists } = setup();
    for (const file of [
      '.qa/config.ts',
      `${DIR}/screenshots/../../../../config.ts`,
      `${DIR}/screenshots/other.png`,
      TRACE,
      path.join(ctx.root, SHOT),
    ]) {
      rejects(() => deleteMedia(ctx, { runId: RUN, key: KEY, file }), 400);
    }
    expect(exists('.qa/config.ts')).toBe(true);
    expect(exists(TRACE)).toBe(true);
    expect(saved().screenshots).toEqual([SHOT, SHOT2]);
  });

  it('refuses media a tampered results.json points outside the artifacts, deleting nothing', () => {
    const { ctx, exists } = setup({ screenshots: [SHOT, '.qa/config.ts'] });
    rejects(() => deleteMedia(ctx, { runId: RUN, key: KEY, file: '.qa/config.ts' }), 400);
    rejects(() => deleteMedia(ctx, { runId: RUN, key: KEY }), 400);
    expect(exists('.qa/config.ts')).toBe(true);
    expect(exists(SHOT)).toBe(true);
  });

  it('rejects bad input and unknown runs or results', () => {
    const { ctx } = setup();
    rejects(() => deleteMedia(ctx, { runId: '../x', key: KEY }), 400);
    rejects(() => deleteMedia(ctx, { runId: RUN, key: '' }), 400);
    rejects(() => deleteMedia(ctx, { runId: RUN, key: KEY, file: 3 }), 400);
    rejects(() => deleteMedia(ctx, { runId: 'nope', key: KEY }), 404);
    rejects(() => deleteMedia(ctx, { runId: RUN, key: 'B-001@x' }), 404);
  });

  it('says so when a result has no media left', () => {
    const { ctx } = setup({ video: null, screenshots: [] });
    rejects(() => deleteMedia(ctx, { runId: RUN, key: KEY }), 404);
  });
});

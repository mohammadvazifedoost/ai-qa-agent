import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { qaPaths, runDir } from '../src/core/paths.js';
import { deleteRuns, type RunDeleteError } from '../src/runner/delete-runs.js';
import { StateStore } from '../src/state/state.js';
import { formatBytes, runCleanupChoices, type Data } from '../src/ui/client/logic.js';
import { makeProject } from './helpers.js';

function setup() {
  const root = makeProject({ 'docs/bug-fix-plan/r1-plan.md': '# plan' });
  const paths = qaPaths(root);
  const state = new StateStore(paths.state);
  const ids = ['r1', 'r2', 'r3'];
  for (const id of ids) {
    state.data.runs.push({ id, startedAt: id, scope: {}, completedStages: [], status: 'completed' });
    fs.mkdirSync(path.join(runDir(paths, id), 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(runDir(paths, id), 'results.json'), '{}');
    fs.writeFileSync(path.join(runDir(paths, id), 'screenshots', 'a.png'), Buffer.alloc(1000));
    fs.mkdirSync(path.join(paths.reportsDir, id), { recursive: true });
    fs.writeFileSync(path.join(paths.reportsDir, id, 'report.html'), 'x'.repeat(24));
  }
  state.data.bugs.fp = {
    fingerprint: 'fp',
    title: 'Bug',
    firstSeenRun: 'r1',
    lastSeenRun: 'r1',
    files: [],
    tracker: 'clickup',
  };
  state.save();
  return { root, paths, state };
}

describe('deleteRuns', () => {
  it('removes the evidence, report and record of each run, and keeps everything else', () => {
    const { root, paths, state } = setup();
    const res = deleteRuns({ paths, state }, { ids: ['r1', 'r2', 'r1'] });
    expect(res).toEqual({ deleted: ['r1', 'r2'], freedBytes: 2 * (2 + 1000 + 24) });
    for (const id of ['r1', 'r2']) {
      expect(fs.existsSync(runDir(paths, id))).toBe(false);
      expect(fs.existsSync(path.join(paths.reportsDir, id))).toBe(false);
    }
    expect(fs.existsSync(runDir(paths, 'r3'))).toBe(true);
    expect(new StateStore(paths.state).data.runs.map((r) => r.id)).toEqual(['r3']);
    // Filed bugs and fix plans are not run data.
    expect(new StateStore(paths.state).data.bugs.fp).toBeDefined();
    expect(fs.existsSync(path.join(root, 'docs/bug-fix-plan/r1-plan.md'))).toBe(true);
  });

  it('refuses unknown runs, runs still running or used by a job, and bad ids, deleting nothing', () => {
    const { paths, state } = setup();
    state.data.runs[2]!.status = 'running';
    const err = (ids: unknown, inUse: string[] = []) => {
      try {
        deleteRuns({ paths, state }, { ids, inUse });
      } catch (e) {
        return [(e as RunDeleteError).status, (e as Error).message];
      }
      return null;
    };
    expect(err(['r1', 'nope'])).toEqual([404, 'Run nope not found']);
    expect(err(['r1', 'r3'])).toEqual([409, 'Run r3 is still in use; wait until it finishes']);
    expect(err(['r2'], ['r2'])?.[0]).toBe(409);
    expect(err(['../../x'])?.[0]).toBe(400);
    expect(err([])?.[0]).toBe(400);
    expect(err('r1')?.[0]).toBe(400);
    expect(state.data.runs).toHaveLength(3);
    expect(fs.existsSync(runDir(paths, 'r1'))).toBe(true);
  });
});

describe('run cleanup dialog logic', () => {
  const runs = ['r3', 'r2', 'r1'].map((id) => ({
    id,
    startedAt: id,
    status: 'completed',
    stats: null,
  })) as Data['runs'];

  it('selects every run but the latest, and never the one a job is using', () => {
    expect(runCleanupChoices(runs, 'r2')).toEqual([
      { id: 'r3', latest: true, locked: false, selected: false },
      { id: 'r2', latest: false, locked: true, selected: false },
      { id: 'r1', latest: false, locked: false, selected: true },
    ]);
  });

  it('formats freed space', () => {
    expect([formatBytes(512), formatBytes(1536), formatBytes(25 * 1024 * 1024)]).toEqual([
      '512 bytes',
      '1.5 KB',
      '25 MB',
    ]);
  });
});

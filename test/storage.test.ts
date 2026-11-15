import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { qaPaths, runDir } from '../src/core/paths.js';
import { cleanStorage, storageReport, type StorageCleanError } from '../src/runner/storage.js';
import { StateStore } from '../src/state/state.js';
import { cleanupBytes } from '../src/ui/client/logic.js';
import { makeProject } from './helpers.js';

const put = (file: string, bytes: number): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
};

function setup() {
  const root = makeProject({});
  const paths = qaPaths(root);
  const state = new StateStore(paths.state);
  for (const id of ['r1', 'r2']) {
    state.data.runs.push({ id, startedAt: id, scope: {}, completedStages: [], status: 'completed' });
    put(path.join(runDir(paths, id), 'results.json'), 10);
    put(path.join(runDir(paths, id), 'playwright', 't', 'video.webm'), 100);
    put(path.join(runDir(paths, id), 'videos', 'a.webm'), 100);
    put(path.join(paths.reportsDir, id, 'report.html'), 5);
  }
  put(path.join(paths.logsDir, 'ai-qa-agent.log'), 40);
  put(path.join(paths.logsDir, 'ai', 'transcript.jsonl'), 60);
  put(path.join(paths.artifactsDir, 'runs', 'ghost', 'results.json'), 7);
  put(path.join(paths.reportsDir, 'ghost', 'report.html'), 3);
  put(path.join(paths.artifactsDir, 'test-results', 'x.png'), 20);
  put(path.join(paths.reportsDir, 'latest.md'), 1);
  put(path.join(paths.scenariosDir, 'home.json'), 50);
  put(path.join(paths.testsDir, 'home.spec.ts'), 50);
  state.save();
  return { paths, state };
}

const bytesOf = (r: ReturnType<typeof storageReport>, kind: string) =>
  r.items.find((i) => i.kind === kind)!.bytes;

describe('storage', () => {
  it('measures each kind of cleanable data', () => {
    const { paths, state } = setup();
    const r = storageReport({ paths, state }, { busy: false, inUse: [] });
    expect(bytesOf(r, 'raw-output')).toBe(200);
    expect(bytesOf(r, 'logs')).toBe(100);
    expect(bytesOf(r, 'leftovers')).toBe(30);
    // Only r1: the latest run (r2) is kept.
    expect(r.items.find((i) => i.kind === 'old-runs')).toMatchObject({
      bytes: 215,
      runs: ['r1'],
      overlap: 100,
    });
    expect(r.totalBytes).toBeGreaterThan(545);
  });

  it('frees raw output, logs and leftovers without losing what the dashboard shows', () => {
    const { paths, state } = setup();
    const res = cleanStorage(
      { paths, state },
      { kinds: ['raw-output', 'logs', 'leftovers'], busy: false, inUse: [] },
    );
    expect(res).toEqual({ cleaned: ['raw-output', 'logs', 'leftovers'], freedBytes: 330, deletedRuns: [] });
    for (const id of ['r1', 'r2']) {
      expect(fs.existsSync(path.join(runDir(paths, id), 'playwright'))).toBe(false);
      expect(fs.existsSync(path.join(runDir(paths, id), 'videos', 'a.webm'))).toBe(true);
    }
    expect(fs.readdirSync(paths.logsDir)).toEqual([]);
    expect(fs.existsSync(path.join(paths.artifactsDir, 'runs', 'ghost'))).toBe(false);
    expect(fs.existsSync(path.join(paths.reportsDir, 'ghost'))).toBe(false);
    expect(fs.existsSync(path.join(paths.reportsDir, 'latest.md'))).toBe(true);
    expect(fs.existsSync(path.join(paths.scenariosDir, 'home.json'))).toBe(true);
    expect(fs.existsSync(path.join(paths.testsDir, 'home.spec.ts'))).toBe(true);
    expect(state.data.runs).toHaveLength(2);
  });

  it('deletes old runs only when asked, keeping the latest, and counts their raw output once', () => {
    const { paths, state } = setup();
    const res = cleanStorage({ paths, state }, { kinds: ['old-runs', 'raw-output'], busy: false, inUse: [] });
    expect(res.deletedRuns).toEqual(['r1']);
    expect(res.freedBytes).toBe(215 + 100);
    expect(new StateStore(paths.state).data.runs.map((r) => r.id)).toEqual(['r2']);
    expect(fs.existsSync(path.join(runDir(paths, 'r2'), 'results.json'))).toBe(true);
  });

  it('refuses bad kinds and any cleanup while a job runs, and spares the run a job uses', () => {
    const { paths, state } = setup();
    const err = (kinds: unknown, busy = false) => {
      try {
        cleanStorage({ paths, state }, { kinds, busy, inUse: [] });
      } catch (e) {
        return (e as StorageCleanError).status;
      }
      return null;
    };
    expect([err([]), err(['cache']), err('logs'), err(['logs'], true)]).toEqual([400, 400, 400, 409]);
    expect(fs.existsSync(path.join(paths.logsDir, 'ai-qa-agent.log'))).toBe(true);
    const r = storageReport({ paths, state }, { busy: true, inUse: ['r1'] });
    expect(r.busy).toBe(true);
    expect(bytesOf(r, 'raw-output')).toBe(100);
    expect(r.items.find((i) => i.kind === 'old-runs')!.runs).toEqual([]);
  });

  it('totals the selection without counting old runs’ raw output twice', () => {
    const items = [
      { kind: 'raw-output', bytes: 200 },
      { kind: 'logs', bytes: 100 },
      { kind: 'old-runs', bytes: 215, overlap: 100 },
    ];
    expect(cleanupBytes(items, new Set(['raw-output', 'logs']))).toBe(300);
    expect(cleanupBytes(items, new Set(['old-runs']))).toBe(215);
    expect(cleanupBytes(items, new Set(['raw-output', 'old-runs']))).toBe(315);
  });
});

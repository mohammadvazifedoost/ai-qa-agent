import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/state/state.js';
import { makeProject } from './helpers.js';

describe('StateStore', () => {
  it('persists stage completion and detects stale inputs', () => {
    const file = path.join(makeProject({}), 'state.json');
    const s = new StateStore(file);
    expect(s.isStageFresh('analyze', 'h1')).toBe(false);
    s.markStage('analyze', 'h1');
    const reloaded = new StateStore(file);
    expect(reloaded.isStageFresh('analyze', 'h1')).toBe(true);
    expect(reloaded.isStageFresh('analyze', 'h2')).toBe(false);
  });

  it('tracks resumable runs', () => {
    const file = path.join(makeProject({}), 'state.json');
    const s = new StateStore(file);
    const run = s.startRun({ page: '/checkout' });
    s.completeRunStage(run, 'analyze');
    const again = new StateStore(file);
    expect(again.resumableRun()?.id).toBe(run.id);
    expect(again.resumableRun()?.completedStages).toEqual(['analyze']);
    again.finishRun(again.resumableRun()!, 'completed');
    expect(new StateStore(file).resumableRun()).toBeUndefined();
  });
});

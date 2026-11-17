import { describe, expect, it } from 'vitest';
import { ranScenarioIds } from '../src/ui/server.js';

describe('ranScenarioIds', () => {
  it('counts a scenario whose results are all skipped as not run', () => {
    // Playwright skips the rest of a file when its setup fails; the dashboard lists those
    // scenarios under "Not run", so running them from there must not refuse them.
    const ran = ranScenarioIds([
      { scenarioId: 'A-001', status: 'passed' },
      { scenarioId: 'A-002', status: 'skipped' },
      { scenarioId: 'A-002', status: 'skipped' },
      { scenarioId: 'A-003', status: 'skipped' },
      { scenarioId: 'A-003', status: 'failed' },
      { scenarioId: null, status: 'failed' },
    ]);
    expect([...ran].sort()).toEqual(['A-001', 'A-003']);
  });
});

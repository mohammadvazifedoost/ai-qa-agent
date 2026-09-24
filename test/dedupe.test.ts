import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { previouslyFiled, rootCauseFiles } from '../src/bugs/file.js';
import type { QaContext } from '../src/pipeline/context.js';
import { StateStore } from '../src/state/state.js';
import type { Issue } from '../src/triage/schema.js';
import { makeProject } from './helpers.js';

function issue(over: Partial<Issue> & { rootCause: string; category?: Issue['bug']['category'] }): Issue {
  return {
    id: 'BUG-001',
    fingerprint: over.fingerprint ?? 'fp-new',
    classification: over.classification ?? 'DESIGN_MISMATCH',
    bug: {
      title: 't',
      severity: 'medium',
      category: over.category ?? 'visual',
      affectedPage: '/x',
      stepsToReproduce: ['s'],
      expectedResult: 'e',
      actualResult: 'a',
      suspectedRootCause: over.rootCause,
    },
    failureKeys: [],
    scenarioIds: ['X-001'],
    confidence: 0.9,
    fileable: true,
    notFiledReason: null,
  };
}

describe('rootCauseFiles', () => {
  it('extracts unique source files without line numbers', () => {
    expect(
      rootCauseFiles('src/styles.css:2 sets a color; src/styles.css:155 and ./src/pages/CheckoutPage.tsx:29'),
    ).toEqual(['src/pages/CheckoutPage.tsx', 'src/styles.css']);
    expect(rootCauseFiles('unknown')).toEqual([]);
  });
});

describe('previouslyFiled', () => {
  const ctx = (): QaContext => {
    const state = new StateStore(path.join(makeProject({}), 'state.json'));
    state.data.bugs['fp-old'] = {
      fingerprint: 'fp-old',
      title: 'Primary buttons use wrong color',
      taskId: 'T1',
      url: 'https://app.clickup.com/t/T1',
      firstSeenRun: 'r1',
      lastSeenRun: 'r1',
      classification: 'DESIGN_MISMATCH',
      category: 'visual',
      files: ['src/styles.css'],
      tracker: 'clickup',
    };
    return { state, config: { clickup: { listId: '1' } } } as unknown as QaContext;
  };

  it('matches the same defect found by different tests through root-cause files', () => {
    const hit = previouslyFiled(ctx(), issue({ rootCause: 'src/styles.css:2 --color-primary is purple' }));
    expect(hit?.taskId).toBe('T1');
  });

  it('does not match a different classification or category in the same file', () => {
    expect(
      previouslyFiled(
        ctx(),
        issue({
          rootCause: 'src/styles.css:126 breakpoint',
          classification: 'PRODUCT_BUG',
          category: 'responsive',
        }),
      ),
    ).toBeUndefined();
  });

  it('does not match when no files are named', () => {
    expect(previouslyFiled(ctx(), issue({ rootCause: 'unknown' }))).toBeUndefined();
  });

  it('matches by fingerprint regardless of files', () => {
    expect(previouslyFiled(ctx(), issue({ fingerprint: 'fp-old', rootCause: 'unknown' }))?.taskId).toBe('T1');
  });
});

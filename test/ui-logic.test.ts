import { describe, expect, it } from 'vitest';
import { esc, fmtRun, lines, listModel, statusOf, type Data, type View } from '../src/ui/client/logic.js';

const view = (extra: Partial<View> = {}): View => ({
  page: '',
  only: 'all',
  type: '',
  q: '',
  ...extra,
});

const sc = (id: string, page: string, extra: Record<string, unknown> = {}) => ({
  id,
  page,
  category: 'functional',
  title: `Title ${id}`,
  approved: true,
  ...extra,
});

const out = (scenarioId: string, status: string, project = 'chromium-desktop') => ({
  key: `${scenarioId}@${project}`,
  scenarioId,
  status,
});

/** Only the fields the list logic reads. */
function data(extra: Record<string, unknown> = {}): Data {
  return {
    scenarios: [
      sc('A-001', '/a'),
      sc('A-002', '/a'),
      sc('B-001', '/b', { category: 'visual' }),
      sc('B-002', '/b', { origin: 'person' }),
      sc('B-003', '/b'),
    ],
    run: {
      id: 'r1',
      outcomes: [
        out('A-001', 'passed'),
        out('A-002', 'passed'),
        out('A-002', 'failed', 'chromium-mobile'),
        out('B-001', 'flaky'),
      ],
      failures: [],
      issues: [],
    },
    testStates: { 'B-003': 'missing' },
    ...extra,
  } as unknown as Data;
}

describe('dashboard helpers', () => {
  it('escapes HTML, formats run ids and splits textarea lines', () => {
    expect(esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect(esc(undefined)).toBe('');
    expect(fmtRun('2026-09-24_15-24-46')).toBe('2026-09-24 15:24:46');
    expect(lines(' a \n\n b\n')).toEqual(['a', 'b']);
  });

  it('takes the worst status across browser projects', () => {
    const d = data();
    expect(statusOf(d, 'A-001')).toBe('passed');
    expect(statusOf(d, 'A-002')).toBe('failed');
    expect(statusOf(d, 'B-001')).toBe('flaky');
    expect(statusOf(d, 'B-002')).toBe('none');
  });
});

describe('listModel', () => {
  it('hides not-run scenarios by default, except your own and ones waiting for a test', () => {
    const m = listModel(data(), view());
    expect(m.rows.map((r) => r.sc.id)).toEqual(['A-001', 'A-002', 'B-001', 'B-002', 'B-003']);
    const withoutOwn = listModel(
      data({ scenarios: [sc('A-001', '/a'), sc('C-001', '/c')], testStates: {} }),
      view(),
    );
    expect(withoutOwn.rows.map((r) => r.sc.id)).toEqual(['A-001']);
  });

  it('counts failures, not-run tests and tests that need writing', () => {
    const m = listModel(data(), view());
    expect(m).toMatchObject({ failed: 2, notRun: 2, notRunWithTest: 1, todo: 1, pages: ['/a', '/b'] });
    expect(m.types).toEqual(['functional', 'visual']);
  });

  it('filters by result, page, type and search text', () => {
    const ids = (v: Partial<View>) => listModel(data(), view(v)).rows.map((r) => r.sc.id);
    expect(ids({ only: 'failed' })).toEqual(['A-002', 'B-001']);
    expect(ids({ only: 'passed' })).toEqual(['A-001']);
    expect(ids({ only: 'notrun' })).toEqual(['B-002', 'B-003']);
    expect(ids({ only: 'todo' })).toEqual(['B-003']);
    expect(ids({ page: '/a' })).toEqual(['A-001', 'A-002']);
    expect(ids({ type: 'visual' })).toEqual(['B-001']);
    expect(ids({ q: 'b-00' })).toEqual(['B-001', 'B-002', 'B-003']);
  });

  it('falls back to All when a view has nothing left to show', () => {
    const m = listModel(data({ testStates: {} }), view({ only: 'todo' }));
    expect(m.only).toBe('all');
  });

  it('lists every scenario before the first run', () => {
    const m = listModel(data({ run: null }), view());
    expect(m.rows).toHaveLength(5);
    expect(m.notRun).toBe(0);
  });
});

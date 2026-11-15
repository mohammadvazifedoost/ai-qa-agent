import { describe, expect, it } from 'vitest';
import {
  defectFor,
  defectsOf,
  esc,
  filterTable,
  fmtRun,
  initials,
  label,
  lines,
  listModel,
  mediaDeleteLabel,
  pageResults,
  paginate,
  parseRoute,
  passRate,
  plural,
  projectSummary,
  routeHash,
  runCounts,
  videosOf,
  runLabel,
  scenarioTargets,
  shortUrl,
  statusOf,
  verdictOf,
  type Data,
  type Project,
  type View,
} from '../src/ui/client/logic.js';

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
  expectedResults: ['It works'],
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

  it('gives the pass rate of the tests that ran', () => {
    expect(passRate(null)).toBeNull();
    expect(passRate({ passed: 0, failed: 0, flaky: 0 })).toBeNull();
    expect(passRate({ passed: 7, failed: 4, flaky: 0 })).toEqual({ ran: 11, pct: 64 });
    expect(passRate({ passed: 5, failed: 0, flaky: 0 })).toEqual({ ran: 5, pct: 100 });
    // Rounding never hides the one test that failed, or the one that passed.
    expect(passRate({ passed: 999, failed: 1, flaky: 0 })?.pct).toBe(99);
    expect(passRate({ passed: 1, failed: 999, flaky: 0 })?.pct).toBe(1);
    expect(passRate({ passed: 0, failed: 2, flaky: 1 })?.pct).toBe(0);
  });

  it('names a project by two letters and shortens its address', () => {
    expect(initials('demo-shop')).toBe('DS');
    expect(initials('blog')).toBe('BL');
    expect(initials('@acme/web_store app')).toBe('WS');
    expect(initials('x')).toBe('X');
    expect(initials('')).toBe('');
    expect(shortUrl('http://127.0.0.1:5173/')).toBe('127.0.0.1:5173');
    expect(shortUrl('https://shop.example/app')).toBe('shop.example/app');
  });

  it('writes run ids, enum values and counts the way people read them', () => {
    expect(runLabel('2026-09-04_15-24-46')).toBe('4 Sep 2026, 15:24');
    expect(runLabel('custom-run')).toBe('custom-run');
    expect(label('PRODUCT_BUG')).toBe('Product bug');
    expect(label('functional')).toBe('Functional');
    expect(plural(1, 'test')).toBe('1 test');
    expect(plural(3, 'test')).toBe('3 tests');
    expect(plural(2, 'defect is', 'defects are')).toBe('2 defects are');
  });

  it('reads the page and the open item from the address', () => {
    expect(parseRoute('')).toEqual({ page: 'overview', id: '' });
    expect(parseRoute('#/nonsense/x')).toEqual({ page: 'overview', id: '' });
    expect(parseRoute('#/scenarios')).toEqual({ page: 'scenarios', id: '' });
    expect(parseRoute('#/scenarios/HOME-001')).toEqual({ page: 'scenarios', id: 'HOME-001' });
    const id = 'test:A-002@chromium-mobile';
    expect(parseRoute(routeHash('defects', id))).toEqual({ page: 'defects', id });
    expect(parseRoute('#/defects/%E0%A4%A')).toEqual({ page: 'defects', id: '' });
    expect(parseRoute(routeHash('project'))).toEqual({ page: 'project', id: '' });
    expect(parseRoute('#/project/anything')).toEqual({ page: 'project', id: '' });
  });

  it('summarises a run in one word', () => {
    expect(verdictOf(null)).toBe('none');
    expect(verdictOf({ passed: 0, failed: 0, flaky: 0 })).toBe('none');
    expect(verdictOf({ passed: 3, failed: 0, flaky: 0 })).toBe('passed');
    expect(verdictOf({ passed: 3, failed: 0, flaky: 1 })).toBe('flaky');
    expect(verdictOf({ passed: 3, failed: 1, flaky: 1 })).toBe('failed');
  });

  it('cuts a list into pages and clamps the page number', () => {
    const rows = [1, 2, 3, 4, 5];
    expect(paginate(rows, 0, 2)).toMatchObject({
      items: [1, 2],
      page: 0,
      pages: 3,
      from: 1,
      to: 2,
      total: 5,
    });
    expect(paginate(rows, 9, 2)).toMatchObject({ items: [5], page: 2, from: 5, to: 5 });
    expect(paginate([], 3, 2)).toMatchObject({ items: [], page: 0, pages: 1, from: 0, to: 0, total: 0 });
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
  it('lists every scenario under All, including the ones that did not run', () => {
    const m = listModel(data(), view());
    expect(m.rows.map((r) => r.sc.id)).toEqual(['A-001', 'A-002', 'B-001', 'B-002', 'B-003']);
    const partial = listModel(
      data({ scenarios: [sc('A-001', '/a'), sc('C-001', '/c')], testStates: {} }),
      view(),
    );
    expect(partial.rows.map((r) => r.sc.id)).toEqual(['A-001', 'C-001']);
  });

  it('counts each result tab within the page, type and search filters', () => {
    expect(listModel(data(), view()).counts).toEqual({ all: 5, failed: 2, passed: 1, notrun: 2, todo: 1 });
    expect(listModel(data(), view({ page: '/a', only: 'failed' })).counts).toEqual({
      all: 2,
      failed: 1,
      passed: 1,
      notrun: 0,
      todo: 0,
    });
    expect(listModel(data({ run: null }), view()).counts.notrun).toBe(0);
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

describe('mediaDeleteLabel', () => {
  it('names what is deleted and whose result it is', () => {
    expect(mediaDeleteLabel('screenshot', 'A-001@chromium-desktop')).toBe(
      'Delete final screenshot of A-001@chromium-desktop',
    );
    expect(mediaDeleteLabel('video', 'A-001@x')).toBe('Delete video of A-001@x');
    expect(mediaDeleteLabel('all', 'A-001@x')).toBe('Delete all screenshots and videos of A-001@x');
  });

  it('tells the videos of a test that opened several pages apart', () => {
    expect(mediaDeleteLabel('video', 'A-001@x', 1)).toBe('Delete video of A-001@x');
    expect(mediaDeleteLabel('video', 'A-001@x', 2)).toBe('Delete video of page 2 of A-001@x');
  });
});

describe('videosOf', () => {
  it('lists every page video, and falls back to `video` for older results', () => {
    expect(videosOf({ video: 'a.webm', videos: ['a.webm', 'a-1.webm'] })).toEqual(['a.webm', 'a-1.webm']);
    expect(videosOf({ video: 'a.webm' })).toEqual(['a.webm']);
    expect(videosOf({ video: 'a.webm', videos: [] })).toEqual(['a.webm']);
    expect(videosOf({ video: null, videos: [] })).toEqual([]);
  });
});

describe('pageResults', () => {
  it('counts results per page and puts the most important page first', () => {
    const d = data({
      model: {
        pages: [
          { route: '/b', name: 'Basket', importance: 'essential' },
          { route: '/a', name: 'About', importance: 'optional' },
        ],
      },
    });
    expect(pageResults(d)).toEqual([
      { route: '/b', name: 'Basket', importance: 'essential', total: 3, passed: 0, failed: 1, notRun: 2 },
      { route: '/a', name: 'About', importance: 'optional', total: 2, passed: 1, failed: 1, notRun: 0 },
    ]);
  });

  it('works without an application model', () => {
    expect(pageResults(data()).map((p) => [p.route, p.name, p.importance])).toEqual([
      ['/a', '', null],
      ['/b', '', null],
    ]);
  });
});

describe('defectsOf', () => {
  const bug = (title: string, severity: string) => ({
    title,
    severity,
    expectedResult: 'expected ' + title,
    actualResult: 'actual ' + title,
    suspectedRootCause: 'src/x.ts:1',
    stepsToReproduce: ['Open /'],
  });
  const failed = (id: string, project = 'chromium-desktop') => ({
    ...out(id, 'failed', project),
    title: 'Test ' + id,
    project,
    error: { message: 'Error: boom\n\nstack' },
  });
  const verdict = (key: string, classification: string, summary: string, extra = {}) => ({
    key,
    classification,
    confidence: 0.8,
    summary,
    reasoning: 'because',
    ...extra,
  });
  const triaged = (): Data =>
    data({
      run: {
        id: 'r1',
        outcomes: [
          out('A-001', 'passed'),
          failed('A-002'),
          failed('B-001'),
          failed('B-001', 'm'),
          failed('B-002'),
          failed('B-003'),
        ],
        failures: [
          verdict('A-002@chromium-desktop', 'PRODUCT_BUG', 'Low one'),
          verdict('B-001@chromium-desktop', 'DESIGN_MISMATCH', 'Total is wrong'),
          verdict('B-002@chromium-desktop', 'TEST_BUG', 'Wrong locator', {
            bug: null,
            testProblem: 'Use the button role',
          }),
        ],
        issues: [
          {
            id: 'I-1',
            classification: 'PRODUCT_BUG',
            bug: bug('Low one', 'low'),
            failureKeys: ['A-002@chromium-desktop'],
            confidence: 0.8,
            fileable: false,
            notFiledReason: 'confidence below the threshold',
          },
          {
            id: 'I-2',
            classification: 'DESIGN_MISMATCH',
            bug: bug('Critical one', 'critical'),
            failureKeys: ['B-001@chromium-desktop', 'B-001@m'],
            confidence: 0.9,
            fileable: true,
            notFiledReason: null,
          },
        ],
      },
    });

  it('lists confirmed defects most severe first, then the other failed tests', () => {
    const defects = defectsOf(triaged());
    expect(defects.map((d) => [d.id, d.kind, d.severity, d.confirmed])).toEqual([
      ['I-2', 'Design mismatch', 'critical', true],
      ['I-1', 'Product bug', 'low', true],
      ['test:B-002@chromium-desktop', 'Test problem', null, false],
      ['test:B-003@chromium-desktop', 'Not analyzed', null, false],
    ]);
    expect(defects[0]).toMatchObject({
      keys: ['B-001@chromium-desktop', 'B-001@m'],
      scenarioIds: ['B-001'],
      summary: 'Total is wrong',
      body: { issueId: 'I-2' },
      note: '',
    });
    expect(defects[1]).toMatchObject({ summary: '', note: 'confidence below the threshold' });
    expect(defects[2]).toMatchObject({
      title: 'Wrong locator',
      cause: 'Use the button role',
      causeTitle: 'What is wrong with the test',
      body: { failureKey: 'B-002@chromium-desktop' },
    });
    expect(defects[3]).toMatchObject({ title: 'Title B-003', actual: 'Error: boom', confidence: null });
  });

  it('finds the defect behind a scenario', () => {
    const defects = defectsOf(triaged());
    expect(defectFor(defects, 'B-001')?.id).toBe('I-2');
    expect(defectFor(defects, 'A-001')).toBeUndefined();
  });

  it('drops a test from its issue once it passed or was run again', () => {
    const d = triaged();
    d.run!.outcomes = d.run!.outcomes.map((o) =>
      o.key === 'B-001@m'
        ? { ...o, status: 'passed' as const }
        : o.key === 'A-002@chromium-desktop'
          ? { ...o, rerunAt: '2026-01-01T00:00:00Z' }
          : o,
    );
    const defects = defectsOf(d);
    expect(defects.find((x) => x.id === 'I-2')?.keys).toEqual(['B-001@chromium-desktop']);
    expect(defects.find((x) => x.id === 'I-1')).toBeUndefined();
    expect(defects.map((x) => x.id)).toContain('test:A-002@chromium-desktop');
  });

  it('is empty without a run', () => {
    expect(defectsOf(data({ run: null }))).toEqual([]);
  });
});

describe('the Project page', () => {
  const page = (
    route: string,
    code: Project['pages'][number]['code'],
    scenarioState: Project['pages'][number]['scenarioState'],
  ): Project['pages'][number] => ({
    route,
    name: route,
    importance: 'essential',
    code,
    scenarios: 0,
    scenarioState,
  });
  const project = (extra: Partial<Project> = {}): Project => ({
    analysis: {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      pages: 3,
      journeys: 2,
      criticalJourneys: 1,
      usable: true,
    },
    design: { configured: false, extractedAt: null },
    code: { toAnalyze: [], removed: [], shared: [] },
    pages: [page('/', 'unchanged', 'current'), page('/cart', 'unchanged', 'current')],
    scenarios: { total: 0, person: 0, removed: 0 },
    critical: { journeys: 1, max: null, chosen: [] },
    ...extra,
  });

  it('is up to date when the code and the scenarios match the analysis', () => {
    expect(projectSummary(project())).toEqual({
      analysis: 'current',
      toAnalyze: 0,
      scenarioPages: 0,
      outdated: false,
    });
  });

  it('is not called out of date before the first analysis', () => {
    const s = projectSummary(project({ analysis: null, pages: [page('/', 'new', null)] }));
    expect(s.analysis).toBe('none');
    expect(s.outdated).toBe(false);
  });

  it('is out of date when a page, a removed page or a shared file changed', () => {
    for (const code of [
      { toAnalyze: ['/cart'], removed: [], shared: [] },
      { toAnalyze: [], removed: ['/cart'], shared: [] },
      { toAnalyze: [], removed: [], shared: ['src/Layout.tsx'] },
    ]) {
      const s = projectSummary(project({ code }));
      expect(s.analysis).toBe('outdated');
      expect(s.outdated).toBe(true);
    }
  });

  it('is out of date when scenarios are older than the analysis or missing', () => {
    const p = project({
      pages: [
        page('/', 'unchanged', 'current'),
        page('/cart', 'unchanged', 'outdated'),
        page('/pay', 'unchanged', 'none'),
      ],
    });
    expect(projectSummary(p)).toMatchObject({ analysis: 'current', scenarioPages: 2, outdated: true });
  });

  it('asks for a new analysis when it was made by an older version of the agent', () => {
    const p = project({ pages: [page('/', 'unchanged', 'outdated')] });
    p.analysis!.usable = false;
    expect(projectSummary(p)).toEqual({ analysis: 'old', toAnalyze: 0, scenarioPages: 0, outdated: true });
  });

  it('picks the pages a scenario step writes', () => {
    const p = project({
      pages: [
        page('/', 'unchanged', 'current'),
        page('/cart', 'changed', 'outdated'),
        page('/pay', 'unchanged', 'none'),
        page('/gone', 'removed', 'outdated'),
        page('/new', 'new', null),
      ],
    });
    // Pages the analysis does not know, or whose code is gone, cannot get scenarios.
    expect(scenarioTargets(p, false)).toEqual(['/cart', '/pay']);
    expect(scenarioTargets(p, true)).toEqual(['/', '/cart', '/pay']);
  });
});

describe('long tables', () => {
  const rows = [
    { route: '/', name: 'Home', changed: false },
    { route: '/cart', name: 'Cart', changed: true },
    { route: '/checkout', name: 'Checkout', changed: false },
    { route: '/account', name: 'Account', changed: true },
  ];
  const text = (r: (typeof rows)[number]) => r.route + ' ' + r.name;
  const needs = (r: (typeof rows)[number]) => r.changed;

  it('puts the rows that need attention first and counts them', () => {
    const t = filterTable(rows, { q: '', only: 'all' }, text, needs);
    expect(t.rows.map((r) => r.route)).toEqual(['/cart', '/account', '/', '/checkout']);
    expect(t).toMatchObject({ total: 4, attention: 2 });
  });

  it('finds by route or name, any case, and filters to what needs attention', () => {
    expect(filterTable(rows, { q: 'CHECK', only: 'all' }, text, needs).rows.map((r) => r.route)).toEqual([
      '/checkout',
    ]);
    expect(filterTable(rows, { q: 'c', only: 'attention' }, text, needs).rows.map((r) => r.route)).toEqual([
      '/cart',
      '/account',
    ]);
    expect(filterTable(rows, { q: 'nothing', only: 'all' }, text, needs).rows).toEqual([]);
  });

  it('says what a run counted', () => {
    expect(runCounts({ passed: 24, failed: 18, flaky: 0 })).toBe('24 passed, 18 failed');
    expect(runCounts({ passed: 0, failed: 0, flaky: 2 })).toBe('2 flaky');
    expect(runCounts({ passed: 0, failed: 0, flaky: 0 })).toBe('No results');
    expect(runCounts(null)).toBe('No results');
  });

  it('knows the Bug tracker page', () => {
    expect(parseRoute('#/tracker')).toEqual({ page: 'tracker', id: '' });
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fileHashes,
  globalFilesOf,
  loadAppModel,
  pageHash,
  type AppModelFile,
  type Flow,
} from '../src/analyze/app.js';
import { qaPaths } from '../src/core/paths.js';
import { Cancelled } from '../src/core/process.js';
import { withSignal, type QaContext } from '../src/pipeline/context.js';
import { scenarioPageStatus } from '../src/scenarios/generate.js';
import { ScenarioFileSchema, type Scenario, type ScenarioFile } from '../src/scenarios/schema.js';
import { StateStore } from '../src/state/state.js';
import { projectStatus, runScenarios } from '../src/ui/project.js';
import { makeProject } from './helpers.js';

const scenario = (id: string, page: string, extra: Partial<Scenario> = {}): Scenario => ({
  id,
  page,
  feature: 'shop',
  category: 'functional',
  priority: 'medium',
  title: `Scenario ${id}`,
  preconditions: [],
  steps: [`Open ${page}`],
  expectedResults: ['It works'],
  viewport: 'desktop',
  source: { figma: false, code: true },
  testData: [],
  design: null,
  rationale: 'why',
  approved: true,
  ...extra,
});

const pageModel = (route: string, name: string, file: string) =>
  ({
    route,
    name,
    purpose: name,
    importance: 'essential',
    access: 'public',
    navigatesTo: [],
    files: ['src/main.ts', file],
    headings: [],
    interactiveElements: [],
    forms: [],
    states: { loading: null, empty: null, error: null },
    dataDependencies: [],
    preconditions: [],
    responsiveBehavior: [],
    businessRules: [],
  }) as unknown as AppModelFile['pages'][number];

const flow = (name: string, routes: string[], criticality: Flow['criticality']): Flow => ({
  name,
  feature: 'shop',
  kind: 'happy-path',
  criticality,
  criticalityReason: '',
  preconditions: [],
  steps: ['go'],
  outcome: 'done',
  routes,
  implementation: 'complete',
  gaps: [],
});

const file = (page: string, scenarios: Scenario[], removed: ScenarioFile['removed'] = []): ScenarioFile => ({
  page,
  generatedAt: 'x',
  inputHash: 'written-from-an-older-analysis',
  scenarios,
  removed,
});

/** A project with two analyzed pages; `/checkout` has scenarios, `/login` has none. */
function setup(analyzed = true) {
  const root = makeProject({
    'package.json': { name: 'shop' },
    'src/main.ts': 'router v1',
    'src/checkout.ts': 'checkout v1',
    'src/login.ts': 'login v1',
  });
  const paths = qaPaths(root);
  fs.mkdirSync(paths.qaDir, { recursive: true });
  const pages = [
    pageModel('/checkout', 'Checkout', 'src/checkout.ts'),
    pageModel('/login', 'Login', 'src/login.ts'),
  ];
  if (analyzed) {
    const globalFiles = globalFilesOf(pages);
    const model: AppModelFile = {
      summary: 'A shop',
      pages,
      flows: [
        flow('Buy a product', ['/checkout'], 'critical'),
        flow('Read the FAQ', ['/checkout'], 'secondary'),
      ],
      auth: null,
      stateManagement: 'none',
      integrations: [],
      modelVersion: 2,
      testData: [],
      styling: { approach: 'css', tokens: {} },
      unknowns: [],
      analyzedAt: '2026-01-01T00:00:00.000Z',
      pageHashes: Object.fromEntries(pages.map((p) => [p.route, pageHash(root, p, globalFiles)])),
      globalFileHashes: fileHashes(root, globalFiles),
    } as AppModelFile;
    fs.writeFileSync(paths.appModel, JSON.stringify(model));
    fs.mkdirSync(paths.scenariosDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.scenariosDir, 'checkout.json'),
      JSON.stringify(
        file(
          '/checkout',
          [
            scenario('CHECKOUT-001', '/checkout'),
            scenario('CHECKOUT-002', '/checkout', { origin: 'person' }),
            scenario('CHECKOUT-003', '/checkout', { critical: true }),
          ],
          [
            {
              id: 'CHECKOUT-009',
              title: 'Gone',
              removedAt: 'x',
              scenario: scenario('CHECKOUT-009', '/checkout'),
            },
          ],
        ),
      ),
    );
  }
  const ctx = {
    root,
    paths,
    state: new StateStore(paths.state),
    config: {
      viewports: { desktop: { width: 1440, height: 900 } },
      app: { baseUrl: 'http://127.0.0.1:5173' },
      ai: { mcpServers: {} },
      scenarios: {},
      source: { include: ['src'] },
    },
  } as unknown as QaContext;
  const read = (slug: string) =>
    ScenarioFileSchema.parse(
      JSON.parse(fs.readFileSync(path.join(paths.scenariosDir, `${slug}.json`), 'utf8')),
    );
  return { ctx, root, read };
}

describe('withSignal', () => {
  it('gives every AI task the signal and keeps the cost on the real engine', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const engine = {
      provider: 'claude-code',
      totalCostUsd: 0,
      run: async (task: { signal?: AbortSignal }) => {
        seen.push(task.signal);
        engine.totalCostUsd += 0.5;
        return { output: {} };
      },
      toolRef: (server: string, tool: string) => `${server}:${tool}`,
    };
    const ac = new AbortController();
    const ctx = withSignal({ ai: engine } as unknown as QaContext, ac.signal);
    await ctx.ai.run({ name: 'x' } as never);
    expect(seen).toEqual([ac.signal]);
    expect(ctx.ai.totalCostUsd).toBe(0.5);
    expect(ctx.ai.toolRef('figma', 'get')).toBe('figma:get');
  });
});

describe('projectStatus', () => {
  it('reports a project that was never analyzed', () => {
    const { ctx } = setup(false);
    const s = projectStatus(ctx);
    expect(s.analysis).toBeNull();
    expect(s.code.toAnalyze).toEqual([]);
    expect(s.scenarios).toEqual({ total: 0, person: 0, removed: 0 });
    expect(s.critical.chosen).toEqual([]);
  });

  it('counts scenarios per page and says which are out of date', () => {
    const { ctx } = setup();
    const s = projectStatus(ctx);
    expect(s.analysis).toMatchObject({ pages: 2, journeys: 2, criticalJourneys: 1, usable: true });
    expect(s.pages.map((p) => [p.route, p.code, p.scenarios, p.scenarioState])).toEqual([
      ['/checkout', 'unchanged', 3, 'outdated'],
      ['/login', 'unchanged', 0, 'none'],
    ]);
    expect(s.scenarios).toEqual({ total: 3, person: 1, removed: 1 });
    expect(s.critical.journeys).toBe(1);
    expect(s.critical.chosen.map((c) => c.id)).toEqual(['CHECKOUT-003']);
    expect(s.design).toEqual({ configured: false, extractedAt: null });
  });

  it('sees code that changed after the analysis', () => {
    const { ctx, root } = setup();
    fs.writeFileSync(path.join(root, 'src/login.ts'), 'login v2');
    const s = projectStatus(ctx);
    expect(s.code.toAnalyze).toEqual(['/login']);
    expect(s.pages.find((p) => p.route === '/login')?.code).toBe('changed');
    expect(s.pages.find((p) => p.route === '/checkout')?.code).toBe('unchanged');
  });
});

describe('runScenarios', () => {
  /** A fake AI that writes one scenario for the page named in the task. */
  function fakeAi(ctx: QaContext, onPage?: (route: string) => void) {
    const asked: string[] = [];
    (ctx as { ai: unknown }).ai = {
      provider: 'claude-code',
      totalCostUsd: 0,
      toolRef: () => '',
      run: async (task: { name: string; signal?: AbortSignal }) => {
        const route = `/${task.name.replace('scenarios-', '')}`;
        asked.push(route);
        onPage?.(route);
        if (task.signal?.aborted) throw new Cancelled();
        return { output: { scenarios: [scenario(`${route.slice(1).toUpperCase()}-001`, route)] } };
      },
    };
    return asked;
  }

  it('writes only the pages that are out of date or have none, one at a time', async () => {
    const { ctx, read } = setup();
    const asked = fakeAi(ctx);
    const steps: string[] = [];
    const message = await runScenarios(ctx, { all: false }, (d) => steps.push(d));
    expect(asked).toEqual(['/checkout', '/login']);
    expect(steps).toEqual(['page 1 of 2: /checkout', 'page 2 of 2: /login']);
    expect(message).toMatch(/^Scenarios written for 2 pages: /);
    // A person's scenario and the critical flow survive; removed ones stay removed.
    expect(read('checkout').scenarios.map((s) => s.id)).toEqual(
      expect.arrayContaining(['CHECKOUT-001', 'CHECKOUT-002', 'CHECKOUT-003']),
    );
    expect(read('checkout').removed.map((r) => r.id)).toEqual(['CHECKOUT-009']);
    expect(read('login').scenarios.map((s) => s.id)).toEqual(['LOGIN-001']);
    // Now everything matches the analysis, so an update has nothing to do.
    expect(scenarioPageStatus(ctx, loadAppModel(ctx)!).map((s) => s.state)).toEqual(['current', 'current']);
    expect(await runScenarios(ctx, { all: false }, () => undefined)).toBe(
      'The scenarios were already up to date.',
    );
  });

  it('writes one page when asked for it', async () => {
    const { ctx } = setup();
    const asked = fakeAi(ctx);
    const steps: string[] = [];
    const message = await runScenarios(ctx, { page: '/login', all: false }, (d) => steps.push(d));
    expect(asked).toEqual(['/login']);
    expect(steps).toEqual([]);
    expect(message).toMatch(/^Scenarios written for \/login: 1 scenario\./);
  });

  it('keeps the pages written before a cancel and says so', async () => {
    const { ctx, read } = setup();
    const ac = new AbortController();
    fakeAi(ctx, (route) => {
      if (route === '/login') ac.abort();
    });
    const run = runScenarios(withSignal(ctx, ac.signal), { all: true }, () => undefined);
    await expect(run).rejects.toBeInstanceOf(Cancelled);
    await expect(run).rejects.toThrow(
      'Cancelled while writing /login. The scenarios of /checkout were already saved; the other pages are as they were.',
    );
    expect(read('checkout').inputHash).not.toBe('written-from-an-older-analysis');
    expect(fs.existsSync(path.join(ctx.paths.scenariosDir, 'login.json'))).toBe(false);
  });
});

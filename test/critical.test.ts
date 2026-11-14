import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppModelFile, Flow } from '../src/analyze/app.js';
import { qaPaths } from '../src/core/paths.js';
import { recordScenarioTests, specHash, testRules } from '../src/generate/playwright.js';
import { generateCriticalTests } from '../src/generate/scenario-test.js';
import type { QaContext } from '../src/pipeline/context.js';
import { buildGrep } from '../src/runner/run.js';
import {
  criticalTestFilter,
  generateCriticalScenarios,
  mergeCriticalScenarios,
  selectCriticalJourneys,
} from '../src/scenarios/critical.js';
import { generateScenarios } from '../src/scenarios/generate.js';
import {
  AiScenarioSchema,
  ScenarioFileSchema,
  ScenarioSchema,
  type Scenario,
  type ScenarioFile,
} from '../src/scenarios/schema.js';
import { StateStore } from '../src/state/state.js';
import { makeProject } from './helpers.js';

const scenario = (id: string, title: string, extra: Partial<Scenario> = {}): Scenario => ({
  id,
  page: '/checkout',
  feature: 'checkout',
  category: 'functional',
  priority: 'medium',
  title,
  preconditions: [],
  steps: ['Open /checkout'],
  expectedResults: ['It works'],
  viewport: 'desktop',
  source: { figma: false, code: true },
  testData: [],
  design: null,
  rationale: 'why',
  approved: true,
  ...extra,
});

const pageModel = (route: string, name: string) =>
  ({
    route,
    name,
    purpose: name,
    importance: 'essential',
    access: 'public',
    navigatesTo: [],
    files: [`src${route === '/' ? '/home' : route}.ts`],
    headings: [],
    interactiveElements: [],
    forms: [],
    states: { loading: null, empty: null, error: null },
    dataDependencies: [],
    preconditions: [],
    responsiveBehavior: [],
    businessRules: [],
  }) as unknown as AppModelFile['pages'][number];

const checkout = pageModel('/checkout', 'Checkout');
const login = pageModel('/login', 'Login');

const flow = (name: string, routes: string[], extra: Partial<Flow> = {}): Flow => ({
  name,
  feature: 'checkout',
  kind: 'happy-path',
  criticality: 'critical',
  criticalityReason: 'No sales without it',
  preconditions: [],
  steps: ['add', 'pay'],
  outcome: 'Order confirmed',
  routes,
  implementation: 'complete',
  gaps: [],
  ...extra,
});

const appModel = {
  summary: 'A shop',
  pages: [checkout, login],
  flows: [
    flow('Buy a product', ['/checkout']),
    flow('Sign in', ['/login'], { feature: 'auth' }),
    flow('Read the FAQ', ['/checkout'], { criticality: 'secondary' }),
    flow('Pay with a declined card', ['/checkout'], { kind: 'error-path' }),
  ],
  auth: 'email + password',
  stateManagement: 'none',
  integrations: [],
  modelVersion: 2,
  testData: ['user@example.com / secret'],
  styling: { approach: 'css', tokens: {} },
  unknowns: [],
  analyzedAt: '2026-01-01T00:00:00.000Z',
  pageHashes: { '/checkout': 'h1', '/login': 'h2' },
  globalFileHashes: {},
};

const file = (page: string, scenarios: Scenario[], removed: ScenarioFile['removed'] = []): ScenarioFile => ({
  page,
  generatedAt: 'x',
  inputHash: 'in',
  scenarios,
  removed,
});

function setup(checkoutScenarios: Scenario[], extra: Record<string, string | object> = {}) {
  const root = makeProject({
    '.qa/app-model.json': appModel,
    '.qa/scenarios/checkout.json': file('/checkout', checkoutScenarios),
    ...extra,
  });
  const paths = qaPaths(root);
  const ctx = {
    root,
    paths,
    state: new StateStore(paths.state),
    config: {
      viewports: { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } },
      app: { baseUrl: 'http://127.0.0.1:5173' },
      ai: { mcpServers: {} },
      scenarios: {},
    },
  } as unknown as QaContext;
  const read = (slug: string) =>
    ScenarioFileSchema.parse(
      JSON.parse(fs.readFileSync(path.join(paths.scenariosDir, `${slug}.json`), 'utf8')),
    );
  return { ctx, read };
}

/** A fake AI engine that records prompts and returns `scenarios`. */
function fakeAi(ctx: QaContext, scenarios: unknown[]) {
  const prompts: string[] = [];
  (ctx as { ai: unknown }).ai = {
    run: async (task: { prompt: string }) => {
      prompts.push(task.prompt);
      return { output: { scenarios } };
    },
  };
  return prompts;
}

describe('critical schema field', () => {
  it('keeps existing scenario files valid and accepts the optional flag', () => {
    const old = scenario('CHECKOUT-001', 'One');
    expect(ScenarioSchema.parse(old).critical).toBeUndefined();
    expect(ScenarioFileSchema.parse(file('/checkout', [old])).scenarios).toHaveLength(1);
    expect(ScenarioSchema.parse({ ...old, critical: true }).critical).toBe(true);
    expect(ScenarioSchema.safeParse({ ...old, critical: 'yes' }).success).toBe(false);
  });

  it('does not let the AI mark scenarios critical through the regular schema', () => {
    const parsed = AiScenarioSchema.parse({ ...scenario('CHECKOUT-001', 'One'), critical: true });
    expect('critical' in parsed).toBe(false);
  });
});

describe('mergeCriticalScenarios', () => {
  const viewports = ['desktop', 'mobile'];

  it('adds new flows with fresh ids, forced to functional/high/critical, keeping other scenarios', () => {
    const regular = scenario('CHECKOUT-001', 'Shows totals');
    const mine = scenario('CHECKOUT-002', 'My check', { origin: 'person' });
    const files = new Map([
      ['/checkout', file('/checkout', [regular, mine])],
      ['/login', undefined],
    ]);
    const out = mergeCriticalScenarios(
      files,
      [
        scenario('NEW-001', 'Buy a product', { category: 'visual', priority: 'low', viewport: 'tv' }),
        scenario('NEW-002', 'Log in', { page: '/login', feature: 'auth' }),
      ],
      viewports,
    );
    const co = out.get('/checkout')!.scenarios;
    expect(co.map((s) => s.id)).toEqual(['CHECKOUT-001', 'CHECKOUT-002', 'CHECKOUT-003']);
    expect(co[0]).toEqual(regular);
    expect(co[1]).toEqual(mine);
    expect(co[2]).toMatchObject({
      title: 'Buy a product',
      category: 'functional',
      priority: 'high',
      viewport: 'desktop',
      critical: true,
    });
    // A page without a scenario file gets one; the empty hash lets `scenarios` fill in the rest later.
    expect(out.get('/login')).toMatchObject({ page: '/login', inputHash: '', removed: [] });
    expect(out.get('/login')!.scenarios.map((s) => [s.id, s.critical])).toEqual([['LOGIN-001', true]]);
  });

  it('replaces only AI critical flows, keeps their ids and approval, and never reuses dropped ids', () => {
    const kept = scenario('CHECKOUT-002', 'Buy a product', { critical: true, approved: false });
    const gone = scenario('CHECKOUT-003', 'Old flow', { critical: true });
    const personFlow = scenario('CHECKOUT-004', 'Pay by card', { critical: true, origin: 'person' });
    const files = new Map([
      ['/checkout', file('/checkout', [scenario('CHECKOUT-001', 'One'), kept, gone, personFlow])],
    ]);
    const out = mergeCriticalScenarios(
      files,
      [
        scenario('CHECKOUT-002', 'Buy a product, updated', { steps: ['new'] }),
        scenario('NEW-001', 'Apply a coupon'),
      ],
      viewports,
    );
    const co = out.get('/checkout')!.scenarios;
    expect(co.map((s) => s.id)).toEqual(['CHECKOUT-001', 'CHECKOUT-002', 'CHECKOUT-004', 'CHECKOUT-005']);
    expect(co[1]).toMatchObject({ title: 'Buy a product, updated', approved: false, critical: true });
    expect(co[2]).toEqual(personFlow);
  });

  it('marks an existing scenario with the same title critical instead of duplicating it', () => {
    const files = new Map([['/checkout', file('/checkout', [scenario('CHECKOUT-001', 'Buy a product')])]]);
    const before = JSON.stringify([...files.values()]);
    const out = mergeCriticalScenarios(files, [scenario('NEW-001', 'buy  a Product')], viewports);
    expect(out.get('/checkout')!.scenarios).toEqual([
      scenario('CHECKOUT-001', 'Buy a product', { critical: true }),
    ]);
    expect(JSON.stringify([...files.values()])).toBe(before); // inputs are not mutated
  });

  it('drops removed flows, duplicates of person scenarios and flows on unknown pages', () => {
    const removed = [
      {
        id: 'CHECKOUT-009',
        title: 'Buy a gift card',
        removedAt: 'x',
        scenario: scenario('CHECKOUT-009', 'Buy a gift card'),
      },
    ];
    const files = new Map([
      ['/checkout', file('/checkout', [scenario('CHECKOUT-001', 'My flow', { origin: 'person' })], removed)],
    ]);
    const out = mergeCriticalScenarios(
      files,
      [
        scenario('NEW-001', 'Buy a gift card'),
        scenario('NEW-002', 'My flow'),
        scenario('NEW-003', 'Admin', { page: '/admin' }),
      ],
      viewports,
    );
    expect(out.size).toBe(0);
  });
});

describe('critical flow limit', () => {
  it('has no limit by default, uses scenarios.maxCritical from the config, and --max overrides it', async () => {
    const { ctx } = setup([]);
    const prompts = fakeAi(ctx, []);
    await generateCriticalScenarios(ctx, { force: true });
    // No limit: every critical happy path of the model, and nothing else.
    expect(prompts[0]).toContain('"name": "Buy a product"');
    expect(prompts[0]).toContain('"name": "Sign in"');
    expect(prompts[0]).not.toContain('Read the FAQ');
    expect(prompts[0]).not.toContain('Pay with a declined card');

    // A limit keeps the most important journeys, in the analyst's order.
    (ctx.config as { scenarios: { maxCritical?: number } }).scenarios.maxCritical = 1;
    await generateCriticalScenarios(ctx, { force: true });
    expect(prompts[1]).toContain('"name": "Buy a product"');
    expect(prompts[1]).not.toContain('"name": "Sign in"');

    await generateCriticalScenarios(ctx, { force: true, max: 2 });
    expect(prompts[2]).toContain('"name": "Sign in"');
  });
});

describe('critical flows come from the shared application analysis', () => {
  it('selects the critical happy paths of the model, in order', () => {
    expect(selectCriticalJourneys(appModel).map((j) => j.name)).toEqual(['Buy a product', 'Sign in']);
    expect(selectCriticalJourneys(appModel, 1).map((j) => j.name)).toEqual(['Buy a product']);
  });

  it('asks nothing of the AI when the analysis ranked no journey critical', async () => {
    const { ctx } = setup([], {
      '.qa/app-model.json': {
        ...appModel,
        flows: [flow('Read the FAQ', ['/checkout'], { criticality: 'important' })],
      },
    });
    const prompts = fakeAi(ctx, []);
    expect(await generateCriticalScenarios(ctx, { force: true })).toEqual([]);
    expect(prompts).toHaveLength(0);
  });

  it('refuses a model written before journeys were ranked', async () => {
    const { ctx } = setup([], { '.qa/app-model.json': { ...appModel, modelVersion: undefined } });
    fakeAi(ctx, []);
    await expect(generateCriticalScenarios(ctx)).rejects.toThrow(/ai-qa-agent analyze/);
    await expect(generateScenarios(ctx)).rejects.toThrow(/ai-qa-agent analyze/);
  });

  it('gives the AI the full models of the pages the journeys visit, not of the others', async () => {
    const { ctx } = setup([], {
      '.qa/app-model.json': { ...appModel, flows: [flow('Sign in', ['/login'], { feature: 'auth' })] },
    });
    const prompts = fakeAi(ctx, []);
    await generateCriticalScenarios(ctx, { force: true });
    const pages = prompts[0]!
      .split('## Page models of every route these journeys visit')[1]!
      .split('## Other pages')[0]!;
    expect(pages).toContain('"route": "/login"');
    expect(pages).not.toContain('"route": "/checkout"');
  });

  it('marks an existing scenario critical when the AI says it already covers a journey', async () => {
    const regular = scenario('CHECKOUT-001', 'Checkout end to end');
    const { ctx, read } = setup([regular]);
    const prompts: string[] = [];
    (ctx as { ai: unknown }).ai = {
      run: async (task: { prompt: string }) => {
        prompts.push(task.prompt);
        return {
          output: {
            scenarios: [{ ...scenario('NEW-001', 'Sign in', { page: '/login' }), journey: 'Sign in' }],
            promote: [
              { scenarioId: 'checkout-001', journey: 'Buy a product' },
              { scenarioId: 'NOPE-001', journey: 'Buy a product' },
            ],
            skipped: [],
          },
        };
      },
    };
    await generateCriticalScenarios(ctx, { force: true });
    expect(prompts[0]).toContain('- CHECKOUT-001 (/checkout, medium): Checkout end to end');
    expect(read('checkout').scenarios).toEqual([{ ...regular, critical: true }]);
    expect(read('login').scenarios.map((s) => [s.id, s.critical, 'journey' in s])).toEqual([
      ['LOGIN-001', true, false],
    ]);

    // A promoted scenario is not a flow the next round replaces.
    (ctx as { ai: unknown }).ai = {
      run: async () => ({
        output: {
          scenarios: [],
          promote: [{ scenarioId: 'CHECKOUT-001', journey: 'Buy a product' }],
          skipped: [],
        },
      }),
    };
    await generateCriticalScenarios(ctx, { force: true });
    expect(read('checkout').scenarios).toEqual([{ ...regular, critical: true }]);
  });

  it('keeps the routes of a journey that crosses pages, and only known ones', () => {
    const out = mergeCriticalScenarios(
      new Map([
        ['/checkout', undefined],
        ['/login', undefined],
      ]),
      [scenario('NEW-001', 'Buy', { routes: ['/checkout', '/login', '/nowhere'] })],
      ['mobile', 'desktop'],
    );
    const s = out.get('/checkout')!.scenarios[0]!;
    expect(s.routes).toEqual(['/checkout', '/login']);
    // Critical flows run on desktop when the project has that viewport, whatever its position.
    expect(
      mergeCriticalScenarios(
        new Map([['/checkout', undefined]]),
        [scenario('NEW-001', 'Buy', { viewport: 'tv' })],
        ['mobile', 'desktop'],
      ).get('/checkout')!.scenarios[0]!.viewport,
    ).toBe('desktop');
  });
});

describe('generateCriticalScenarios', () => {
  it('asks for a small set of journeys, merges them, and skips the AI while inputs are unchanged', async () => {
    const { ctx, read } = setup([scenario('CHECKOUT-001', 'Shows totals')]);
    const prompts = fakeAi(ctx, [
      scenario('NEW-001', 'Buy a product'),
      scenario('NEW-002', 'Log in', {
        page: '/login',
        feature: 'auth',
        origin: 'person',
      } as Partial<Scenario>),
    ]);
    const flows = await generateCriticalScenarios(ctx, { max: 3 });
    expect(prompts[0]).toContain('## Critical journeys to cover');
    expect(prompts[0]).toContain('user@example.com / secret');
    expect(flows.map((s) => s.id).sort()).toEqual(['CHECKOUT-002', 'LOGIN-001']);
    expect(read('checkout').scenarios.map((s) => s.id)).toEqual(['CHECKOUT-001', 'CHECKOUT-002']);
    // The AI cannot claim authorship.
    expect(read('login').scenarios[0]!.origin).toBeUndefined();

    await generateCriticalScenarios(ctx);
    expect(prompts).toHaveLength(1);
    await generateCriticalScenarios(ctx, { force: true });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('## Existing critical flows');
    expect(prompts[1]).toContain('"title": "Buy a product"');
    // The same journeys keep their ids even when the AI does not reuse them.
    expect(read('checkout').scenarios.map((s) => s.id)).toEqual(['CHECKOUT-001', 'CHECKOUT-002']);
    expect(read('login').scenarios.map((s) => s.id)).toEqual(['LOGIN-001']);
  });

  it('tells the AI about removed scenarios and person-written critical flows', async () => {
    const removed = [
      {
        id: 'LOGIN-002',
        title: 'Reset password',
        removedAt: 'x',
        scenario: scenario('LOGIN-002', 'Reset password', { page: '/login' }),
      },
    ];
    const { ctx } = setup([scenario('CHECKOUT-001', 'Pay', { critical: true, origin: 'person' })], {
      '.qa/scenarios/login.json': file('/login', [], removed),
    });
    const prompts = fakeAi(ctx, []);
    await generateCriticalScenarios(ctx);
    expect(prompts[0]).toContain('- CHECKOUT-001: Pay');
    expect(prompts[0]).toContain('- LOGIN-002: Reset password');
  });
});

describe('page regeneration keeps critical flows', () => {
  it('leaves AI critical flows alone and strips a critical flag the AI sets', async () => {
    const flow = scenario('CHECKOUT-002', 'Buy a product', { critical: true });
    const { ctx, read } = setup([scenario('CHECKOUT-001', 'One'), flow]);
    const prompts = fakeAi(ctx, [
      scenario('CHECKOUT-001', 'One'),
      scenario('CHECKOUT-003', 'Three', { critical: true }),
    ]);
    await generateScenarios(ctx, { page: '/checkout', force: true });
    expect(prompts[0]).toContain('## Critical flows starting on this page');
    expect(prompts[0]).toContain('- CHECKOUT-002: Buy a product');
    const after = read('checkout').scenarios;
    expect(after.map((s) => s.id)).toEqual(['CHECKOUT-001', 'CHECKOUT-002', 'CHECKOUT-003']);
    expect(after[1]).toEqual(flow);
    expect(after[2]!.critical).toBeUndefined();
  });
});

describe('selecting critical tests', () => {
  const flows = [
    scenario('CHECKOUT-001', 'One'),
    scenario('CHECKOUT-002', 'Buy', { critical: true }),
    scenario('CHECKOUT-003', 'Pay', { critical: true, feature: 'payment' }),
    scenario('CHECKOUT-004', 'Skipped', { critical: true, approved: false }),
  ];

  it('picks approved critical flows by id, narrowed by tags and ids', () => {
    const { ctx } = setup(flows);
    expect(criticalTestFilter(ctx)).toEqual({
      files: undefined,
      scenarioIds: ['CHECKOUT-002', 'CHECKOUT-003'],
    });
    expect(criticalTestFilter(ctx, { tags: ['@payment'], files: ['checkout.spec.ts'] })).toEqual({
      files: ['checkout.spec.ts'],
      scenarioIds: ['CHECKOUT-003'],
    });
    expect(criticalTestFilter(ctx, { scenarioIds: ['checkout-002'] }).scenarioIds).toEqual(['CHECKOUT-002']);
    expect(buildGrep(criticalTestFilter(ctx))).toBe(
      '^CHECKOUT-002\\b|\\sCHECKOUT-002:|^CHECKOUT-003\\b|\\sCHECKOUT-003:',
    );
  });

  it('fails clearly when there are no critical flows', () => {
    const { ctx } = setup([scenario('CHECKOUT-001', 'One')]);
    expect(() => criticalTestFilter(ctx)).toThrow(/scenarios --critical/);
  });

  it('asks generated tests to carry the @critical tag', () => {
    const { ctx } = setup([]);
    expect(testRules(ctx)).toContain("'@critical'");
  });
});

describe('generateCriticalTests', () => {
  it('does nothing without critical flows or when their tests are up to date', async () => {
    const spec = "import { test } from 'x';\ntest('CHECKOUT-002: Buy', async () => {});\n";
    const flow = scenario('CHECKOUT-002', 'Buy', { critical: true });
    const { ctx } = setup([scenario('CHECKOUT-001', 'One')], { '.qa/tests/checkout.spec.ts': spec });
    expect(await generateCriticalTests(ctx)).toEqual([]);

    const fresh = setup([flow], { '.qa/tests/checkout.spec.ts': spec });
    recordScenarioTests(fresh.ctx, [flow]);
    fresh.ctx.state.data.generatedSpecs['tests/checkout.spec.ts'] = specHash(fresh.ctx, checkout, [flow]);
    // No AI and no app server are needed: there is nothing to write.
    expect(await generateCriticalTests(fresh.ctx)).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASE_SYSTEM,
  meaningfulRules,
  projectRules,
  systemPrompt,
  type AgentRole,
} from '../src/ai/context.js';
import type { AppModelFile, PageModel } from '../src/analyze/app.js';
import { qaPaths } from '../src/core/paths.js';
import { lintSpec, relatedPages, specHash, testRules } from '../src/generate/playwright.js';
import { writeScenarioTest } from '../src/generate/scenario-test.js';
import { initProject } from '../src/init/init.js';
import type { QaContext } from '../src/pipeline/context.js';
import { collectFailures } from '../src/plan/plan.js';
import type { TestOutcome, TestRunResult } from '../src/runner/results.js';
import { generateScenarios } from '../src/scenarios/generate.js';
import {
  AiScenarioSchema,
  ScenarioFileSchema,
  scenarioRoutes,
  withKnownRoutes,
  type Scenario,
} from '../src/scenarios/schema.js';
import { StateStore } from '../src/state/state.js';
import { buildTriagePrompt } from '../src/triage/triage.js';
import { makeProject } from './helpers.js';

const page = (route: string, name: string, extra: Partial<PageModel> = {}): PageModel => ({
  route,
  name,
  purpose: name,
  importance: 'essential',
  access: 'public',
  files: [`src/${name}.tsx`],
  headings: [],
  interactiveElements: [`button 'Do ${name}'`],
  forms: [],
  states: { loading: null, empty: null, error: null },
  dataDependencies: [],
  preconditions: [],
  navigatesTo: [],
  responsiveBehavior: ['at 320px the menu collapses'],
  businessRules: [],
  ...extra,
});

const scenario = (id: string, extra: Partial<Scenario> = {}): Scenario => ({
  id,
  page: '/checkout',
  feature: 'checkout',
  category: 'functional',
  priority: 'high',
  title: `Scenario ${id}`,
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

const appModel: AppModelFile = {
  summary: 'A shop',
  pages: [page('/', 'Home'), page('/checkout', 'Checkout'), page('/login', 'Login')],
  flows: [
    {
      name: 'Buy a product',
      feature: 'checkout',
      kind: 'happy-path',
      criticality: 'critical',
      criticalityReason: 'No sales without it',
      preconditions: [],
      steps: ['add', 'pay'],
      outcome: 'Order confirmed',
      routes: ['/', '/checkout'],
      implementation: 'partial',
      gaps: ['Total ignores the discount (src/Checkout.tsx:29)'],
    },
  ],
  auth: null,
  stateManagement: 'in-memory cart',
  integrations: [],
  testData: ['SAVE10 => 10% off'],
  styling: { approach: 'css', tokens: {} },
  unknowns: [],
  modelVersion: 2,
  analyzedAt: 'x',
  pageHashes: {},
  globalFileHashes: {},
};

function setup(scenarios: Scenario[], extra: Record<string, string | object> = {}) {
  const root = makeProject({
    '.qa/app-model.json': appModel,
    '.qa/scenarios/checkout.json': {
      page: '/checkout',
      generatedAt: 'x',
      inputHash: 'in',
      scenarios,
      removed: [],
    },
    '.qa/tests/checkout.spec.ts': `import { test } from '@mohammadvazifedoost/ai-qa-agent/playwright';\n\ntest('CHECKOUT-001: one', async ({ page }) => {\n  await page.goto('/checkout');\n});\n`,
    ...extra,
  });
  const paths = qaPaths(root);
  const tasks: Array<{ prompt: string; system?: string }> = [];
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
  const answer = (output: unknown) => {
    (ctx as { ai: unknown }).ai = {
      run: async (task: { prompt: string; system?: string }) => {
        tasks.push(task);
        return { output };
      },
    };
  };
  return { ctx, root, tasks, answer };
}

describe('agent roles', () => {
  const roles: AgentRole[] = [
    'app-analyst',
    'design-analyst',
    'scenario-designer',
    'test-author',
    'failure-triager',
    'defect-consolidator',
    'fix-planner',
  ];

  it('gives every agent the shared rules plus its own role, decisions, limits and hand-off', () => {
    const prompts = roles.map(systemPrompt);
    expect(new Set(prompts).size).toBe(roles.length);
    for (const p of prompts) {
      expect(p.startsWith(BASE_SYSTEM)).toBe(true);
      for (const part of ['Your role:', 'Objective:', 'You decide:', 'You must not:', 'Hand-off:']) {
        expect(p).toContain(part);
      }
    }
  });

  it('separates what the code does from what it should do, in the shared rules', () => {
    expect(BASE_SYSTEM).toContain('OBSERVED');
    expect(BASE_SYSTEM).toContain('INTENDED');
  });
});

describe('project rules', () => {
  it('adds nothing to the prompts while .qa/rules.md is still the empty template', () => {
    const root = makeProject({
      'package.json': { name: 'x', scripts: { dev: 'vite' }, devDependencies: { vite: '6' } },
    });
    initProject({ root });
    const ctx = { paths: qaPaths(root) } as QaContext;
    expect(projectRules(ctx)).toBe('');

    fs.appendFileSync(ctx.paths.rules, '- /admin is already tracked\n');
    const rules = projectRules(ctx);
    expect(rules).toMatch(/# Project QA rules\n\n## Known issues\n+- \/admin is already tracked$/);
    expect(rules).not.toContain('## Test data');
    expect(rules).not.toContain('Free-form guidance');
  });

  it('keeps a heading only when something is written under it', () => {
    expect(meaningfulRules('# Rules\n\n## A\n\n## B\ntext\n\n### C\n\n## D\n<!-- hint -->\n')).toBe(
      '# Rules\n\n## B\ntext',
    );
    expect(meaningfulRules('# Rules\n\n## A\n### Deep\nx\n')).toBe('# Rules\n\n## A\n### Deep\nx');
    expect(meaningfulRules('just a line')).toBe('just a line');
  });
});

describe('scenarios that cross pages', () => {
  it('stores routes only for scenarios that really cross pages, and only known routes', () => {
    const known = ['/', '/checkout'];
    expect(withKnownRoutes(scenario('A-001', { routes: ['/checkout'] }), known).routes).toBeUndefined();
    expect(withKnownRoutes(scenario('A-001', { routes: [] }), known)).toEqual(scenario('A-001'));
    expect(withKnownRoutes(scenario('A-001', { routes: ['/', '/checkout', '/x'] }), known).routes).toEqual([
      '/checkout',
      '/',
    ]);
    expect(scenarioRoutes(scenario('A-001'))).toEqual(['/checkout']);
    // The AI is always asked for the routes; a file written before the field existed still parses.
    expect(AiScenarioSchema.parse(scenario('CHECKOUT-001')).routes).toEqual([]);
  });

  it('gives the scenario designer the ranked journeys, the priority scale and the value rules', async () => {
    const { ctx, tasks, answer } = setup([]);
    answer({ scenarios: [{ ...scenario('CHECKOUT-001'), page: '/elsewhere', routes: ['/', '/checkout'] }] });
    await generateScenarios(ctx, { page: '/checkout', force: true });
    const { prompt, system } = tasks[0]!;
    expect(system).toContain('TEST SCENARIO DESIGNER');
    expect(prompt).toContain('"criticality": "critical"');
    expect(prompt).toContain('Total ignores the discount (src/Checkout.tsx:29)');
    expect(prompt).toContain('## Priority');
    expect(prompt).toContain('only checks that static elements exist');
    expect(prompt).toContain('NOT IMPLEMENTED');
    const saved = ScenarioFileSchema.parse(
      JSON.parse(fs.readFileSync(path.join(ctx.paths.scenariosDir, 'checkout.json'), 'utf8')),
    ).scenarios[0]!;
    // The scenario stays on the page it was designed for and keeps the other route it visits.
    expect(saved).toMatchObject({ page: '/checkout', routes: ['/checkout', '/'] });
  });

  it('gives the test author the model of every page a scenario visits', async () => {
    const journey = scenario('CHECKOUT-002', { routes: ['/checkout', '/'], critical: true });
    const { ctx, tasks, answer } = setup([scenario('CHECKOUT-001'), journey]);
    answer({
      code: `test('CHECKOUT-002: buy', async ({ page }) => {\n  await page.goto('/');\n});`,
      notes: [],
    });
    await writeScenarioTest(ctx, 'CHECKOUT-002', {
      validate: async () => [],
      startApp: false,
      appUrl: 'http://127.0.0.1:4173',
    });
    const { prompt, system } = tasks[0]!;
    expect(system).toContain('TEST AUTHOR');
    expect(prompt).toContain('runs at http://127.0.0.1:4173');
    expect(prompt).toContain('## Models of the other pages these scenarios visit');
    expect(prompt).toContain("button 'Do Home'");
    expect(prompt).not.toContain("button 'Do Login'");
    expect(prompt).toContain('Every locator must match exactly one element');

    const related = relatedPages(appModel, appModel.pages[1]!, [journey]);
    expect(related.map((p) => p.route)).toEqual(['/']);
    expect('files' in related[0]!).toBe(false);
    // A spec with a cross-page scenario is outdated when the other page changes; other specs are not.
    const checkout = appModel.pages[1]!;
    const changed = { pages: [page('/', 'Home', { headings: ['New'] }), checkout] };
    expect(specHash(ctx, checkout, [journey], changed)).not.toBe(
      specHash(ctx, checkout, [journey], appModel),
    );
    expect(specHash(ctx, checkout, [scenario('CHECKOUT-001')], changed)).toBe(
      specHash(ctx, checkout, [scenario('CHECKOUT-001')], appModel),
    );
  });

  it('sends a test back to its author when it breaks a reliability rule', async () => {
    const { ctx, tasks, answer } = setup([scenario('CHECKOUT-001')]);
    answer({
      code: `test('CHECKOUT-001: one', async ({ page }) => {\n  await page.goto('/checkout');\n  await page.waitForTimeout(500);\n});`,
      notes: [],
    });
    await expect(
      writeScenarioTest(ctx, 'CHECKOUT-001', { validate: async () => [], startApp: false }),
    ).rejects.toThrow(/waitForTimeout/);
    expect(tasks).toHaveLength(3);
    expect(tasks[1]!.prompt).toContain('Uses page.waitForTimeout');
  });
});

describe('lintSpec', () => {
  const body = (line: string): string => `test('A-001: x', async ({ page }) => {\n  ${line}\n});`;

  it('accepts a test that follows the rules', () => {
    expect(
      lintSpec(
        body(
          `// do not use waitForTimeout or { force: true } here\n  await page.goto('https://example.com/a');\n  await expect(page.getByRole('heading', { name: 'Checkout', exact: true })).toBeVisible();`,
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    ['await page.waitForTimeout(300);', 'waitForTimeout'],
    ['await new Promise((r) => setTimeout(r, 300));', 'setTimeout'],
    ["await page.waitForLoadState('networkidle');", 'networkidle'],
    ['await page.getByText("x").click({ force: true });', 'force: true'],
    ["await page.locator('xpath=//div[2]').click();", 'XPath'],
    ["await page.locator('//button').click();", 'XPath'],
  ])('flags %s', (line, word) => {
    const problems = lintSpec(body(line));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(word);
  });

  it('flags skipped tests, serial mode and direct Playwright imports', () => {
    expect(lintSpec("test.skip('A-001: x', async () => {});")[0]).toContain('test.skip');
    expect(lintSpec("test.describe.only('x', () => {});")[0]).toContain('test.only');
    expect(lintSpec("test.describe.configure({ mode: 'serial' });")[0]).toContain('serial');
    expect(lintSpec("import { test } from '@playwright/test';")[0]).toContain('@playwright/test');
  });

  it('tells the test author the same rules it enforces', () => {
    const rules = testRules({ config: { viewports: { desktop: {}, mobile: {} } } } as unknown as QaContext);
    for (const word of [
      'waitForTimeout',
      'networkidle',
      'force: true',
      'test.skip',
      'XPath',
      '@desktop, @mobile',
    ]) {
      expect(rules).toContain(word);
    }
  });
});

const outcome = (id: string, extra: Partial<TestOutcome> = {}): TestOutcome => ({
  key: `${id}@chromium-desktop`,
  scenarioId: id,
  title: `${id}: scenario`,
  file: '.qa/tests/checkout.spec.ts',
  line: 41,
  project: 'chromium-desktop',
  tags: [],
  status: 'failed',
  attempts: 2,
  durationMs: 10,
  error: { message: 'Expected: "$16.20"\nReceived: "$18.00"' },
  annotations: [],
  artifacts: { video: null, trace: null, screenshots: [], errorContext: null, logs: null, design: [] },
  ...extra,
});

describe('triage', () => {
  const design = {
    '.qa/design-system.json': { colors: [{ name: 'color/primary', value: '#2563EB' }], screens: [] },
  };

  it('gets the model of every page the scenario visits and what the run tested', () => {
    const { ctx } = setup([scenario('CHECKOUT-002', { routes: ['/checkout', '/'], critical: true })], design);
    const prompt = buildTriagePrompt(
      ctx,
      outcome('CHECKOUT-002'),
      'http://127.0.0.1:4173 (production build)',
    );
    expect(prompt).toContain("button 'Do Checkout'");
    expect(prompt).toContain("button 'Do Home'");
    expect(prompt).not.toContain("button 'Do Login'");
    expect(prompt).toContain('- Ran against: http://127.0.0.1:4173 (production build)');
    expect(prompt).toContain('"critical": true');
  });

  it('gets the Figma data only for a design-related failure', () => {
    const { ctx } = setup(
      [scenario('CHECKOUT-001'), scenario('CHECKOUT-003', { category: 'visual' })],
      design,
    );
    expect(buildTriagePrompt(ctx, outcome('CHECKOUT-001'))).not.toContain('#2563EB');
    expect(buildTriagePrompt(ctx, outcome('CHECKOUT-001'))).toContain('not a design check');
    expect(buildTriagePrompt(ctx, outcome('CHECKOUT-003'))).toContain('#2563EB');
    const annotated = outcome('CHECKOUT-001', {
      annotations: [{ type: 'design-tokens', description: 'backgroundColor: expected #2563EB, got #1D4ED8' }],
    });
    expect(buildTriagePrompt(ctx, annotated)).toContain('"value":"#2563EB"');
  });
});

describe('fix plan', () => {
  it('starts from the triage verdict of each failure when the run was triaged', () => {
    const run = {
      runId: 'r',
      runDir: 'x',
      outcomes: [outcome('CHECKOUT-001'), outcome('CHECKOUT-002')],
      globalErrors: [],
      exitCode: 1,
      stats: { passed: 0, failed: 2, flaky: 0, skipped: 0 },
    } as TestRunResult;
    const triage = {
      failures: [
        {
          key: 'CHECKOUT-001@chromium-desktop',
          classification: 'PRODUCT_BUG',
          confidence: 0.9,
          summary: 'Total ignores the discount',
          bug: { suspectedRootCause: 'src/Checkout.tsx:29' },
          testProblem: null,
        },
      ],
    } as unknown as Parameters<typeof collectFailures>[2];
    const failures = collectFailures(run, [scenario('CHECKOUT-001', { critical: true })], triage);
    expect(failures[0]!.triage).toEqual({
      classification: 'PRODUCT_BUG',
      confidence: 0.9,
      summary: 'Total ignores the discount',
      suspectedRootCause: 'src/Checkout.tsx:29',
      testProblem: null,
    });
    expect(failures[0]!.scenario).toMatchObject({ critical: true });
    expect(failures[1]!.triage).toBeUndefined();
    expect(collectFailures(run, [])[0]!.triage).toBeUndefined();
  });
});

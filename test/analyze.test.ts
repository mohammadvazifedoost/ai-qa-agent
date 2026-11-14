import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeApp,
  APP_MODEL_VERSION,
  AppModelFileSchema,
  AppModelSchema,
  criticalFlows,
  modelProblems,
  rankedFlows,
  unmodeledRoutes,
  type AppModel,
  type Flow,
  type PageModel,
} from '../src/analyze/app.js';
import { jsonSchemaOf } from '../src/ai/engine.js';
import { qaPaths } from '../src/core/paths.js';
import type { QaContext } from '../src/pipeline/context.js';
import { StateStore } from '../src/state/state.js';
import { makeProject } from './helpers.js';

const page = (route: string, file: string, extra: Partial<PageModel> = {}): PageModel => ({
  route,
  name: route,
  purpose: 'p',
  importance: 'secondary',
  access: 'public',
  files: ['src/main.tsx', file],
  headings: [],
  interactiveElements: [],
  forms: [],
  states: { loading: null, empty: null, error: null },
  dataDependencies: [],
  preconditions: [],
  navigatesTo: [],
  responsiveBehavior: [],
  businessRules: [],
  ...extra,
});

const flow = (name: string, routes: string[], extra: Partial<Flow> = {}): Flow => ({
  name,
  feature: 'f',
  kind: 'happy-path',
  criticality: 'critical',
  criticalityReason: 'because',
  preconditions: [],
  steps: ['do it'],
  outcome: 'done',
  routes,
  implementation: 'complete',
  gaps: [],
  ...extra,
});

const model = (extra: Partial<AppModel> = {}): AppModel => ({
  summary: 'A shop',
  pages: [page('/', 'src/pages/Home.tsx'), page('/login', 'src/pages/Login.tsx')],
  flows: [flow('Sign in', ['/login'])],
  auth: 'email + password',
  stateManagement: 'context',
  integrations: [],
  testData: ['a@b.c / secret'],
  styling: { approach: 'css', tokens: {} },
  unknowns: [],
  ...extra,
});

/** A project with two routes; the fake AI answers each task from `answers`, in order. */
function project(answers: unknown[]) {
  const root = makeProject({
    'package.json': {
      name: 'app',
      dependencies: { react: '19', 'react-router-dom': '7' },
      devDependencies: { vite: '6' },
    },
    'src/main.tsx': `createBrowserRouter([{ path: '/', element: <Home/> }, { path: '/login', element: <Login/> }]);`,
    'src/pages/Home.tsx': 'home v1',
    'src/pages/Login.tsx': 'login v1',
    '.qa/project.json': {
      routes: [
        { path: '/', file: 'src/main.tsx' },
        { path: '/login', file: 'src/main.tsx' },
      ],
    },
  });
  const paths = qaPaths(root);
  const tasks: Array<{ name: string; prompt: string; system?: string }> = [];
  const ctx = {
    root,
    paths,
    state: new StateStore(paths.state),
    config: { source: { include: ['src'], exclude: ['node_modules'] } },
    ai: {
      run: async (task: { name: string; prompt: string; system?: string }) => {
        tasks.push(task);
        const output = answers[tasks.length - 1];
        if (output === undefined) throw new Error(`unexpected AI task ${task.name}`);
        return { output };
      },
    },
  } as unknown as QaContext;
  const saved = () => AppModelFileSchema.parse(JSON.parse(fs.readFileSync(paths.appModel, 'utf8')));
  return { root, ctx, tasks, saved };
}

describe('application model', () => {
  it('reads models written before journeys were ranked, and knows they are outdated', () => {
    const old = AppModelFileSchema.parse({
      summary: 's',
      pages: [{ ...page('/', 'a'), importance: undefined, access: undefined, navigatesTo: undefined }],
      flows: [{ name: 'Buy', feature: 'checkout', steps: ['x'], routes: ['/'] }],
      auth: null,
      stateManagement: '',
      testData: [],
      styling: { approach: '', tokens: {} },
      unknowns: [],
      analyzedAt: 'x',
      pageHashes: {},
    });
    expect(old.modelVersion).toBe(1);
    expect(old.flows[0]).toMatchObject({ kind: 'happy-path', criticality: 'important', gaps: [] });
    expect(criticalFlows(old)).toEqual([]);
  });

  it('requires the analyst to rank every journey: defaults are for old files, not for the AI', () => {
    const schema = jsonSchemaOf(AppModelSchema) as {
      properties: {
        flows: { items: { required: string[] } };
        pages: { items: { required: string[] } };
      };
      required: string[];
    };
    expect(schema.properties.flows.items.required).toEqual(
      expect.arrayContaining([
        'kind',
        'criticality',
        'criticalityReason',
        'outcome',
        'implementation',
        'gaps',
      ]),
    );
    expect(schema.properties.pages.items.required).toEqual(
      expect.arrayContaining(['importance', 'access', 'navigatesTo']),
    );
    expect(schema.required).toContain('integrations');
  });

  it('ranks journeys and selects the critical happy paths', () => {
    const app = {
      flows: [
        flow('FAQ', ['/'], { criticality: 'secondary' }),
        flow('Declined card', ['/'], { kind: 'error-path' }),
        flow('Buy', ['/']),
        flow('Wishlist', ['/'], { criticality: 'important' }),
      ],
    };
    expect(rankedFlows(app).map((f) => f.name)).toEqual(['Buy', 'Declined card', 'Wishlist', 'FAQ']);
    expect(criticalFlows(app).map((f) => f.name)).toEqual(['Buy']);
  });

  it('reports what makes a model unreliable', () => {
    const { ctx } = project([]);
    const problems = modelProblems(
      ctx,
      model({
        pages: [page('/', 'src/pages/Home.tsx', { importance: 'essential' })],
        flows: [flow('Wander', ['/nowhere'], { criticality: 'important' })],
      }),
    );
    expect(problems.join('\n')).toContain('Route /login exists in the project');
    expect(problems.join('\n')).toContain('visits routes without a page model: /nowhere');
    expect(problems.join('\n')).toContain('No journey is ranked critical');
    expect(problems.join('\n')).toContain('Page / is essential but no journey goes through it');
    expect(
      modelProblems(ctx, model({ pages: [...model().pages], flows: [flow('Sign in', ['/', '/login'])] })),
    ).toEqual([]);
    expect(unmodeledRoutes(ctx, [{ route: '/LOGIN/' }])).toEqual(['/']);
  });
});

describe('analyzeApp', () => {
  it('analyzes the whole app with the analyst role and saves a current model', async () => {
    const { ctx, tasks, saved } = project([model()]);
    await analyzeApp(ctx);
    expect(tasks.map((t) => t.name)).toEqual(['app-analyze']);
    expect(tasks[0]!.system).toContain('APPLICATION ANALYST');
    expect(tasks[0]!.prompt).toContain('Every route in the discovery above gets a page model');
    expect(saved()).toMatchObject({ modelVersion: APP_MODEL_VERSION, summary: 'A shop' });
    // Unchanged source: nothing is asked again.
    await analyzeApp(ctx);
    expect(tasks).toHaveLength(1);
  });

  it('analyzes the routes the first pass skipped, so no page is left out', async () => {
    const partial = {
      summary: 'A shop, complete',
      auth: 'email + password',
      stateManagement: 'context',
      integrations: ['login() in src/api.ts (simulated)'],
      pages: [page('/login', 'src/pages/Login.tsx')],
      flows: [flow('Sign in', ['/login'])],
      testData: ['a@b.c / secret'],
      unknowns: [],
    };
    const { ctx, tasks, saved } = project([
      model({ pages: [page('/', 'src/pages/Home.tsx')], flows: [] }),
      partial,
    ]);
    await analyzeApp(ctx);
    expect(tasks.map((t) => t.name)).toEqual(['app-analyze', 'app-analyze-1-pages']);
    expect(tasks[1]!.prompt).toContain('for these routes ONLY: /login');
    expect(saved().pages.map((p) => p.route)).toEqual(['/', '/login']);
    expect(saved().unknowns).toEqual([]);
  });

  it('records the problems of a model in its unknowns', async () => {
    const { ctx, saved } = project([model({ flows: [flow('Browse', ['/'], { criticality: 'secondary' })] })]);
    await analyzeApp(ctx);
    expect(saved().unknowns).toEqual([
      'Model check: No journey is ranked critical, so critical-flow testing has nothing to select.',
    ]);
  });

  it('re-analyzes in full a model that predates journey ranking, even when the source is unchanged', async () => {
    const { ctx, tasks, saved } = project([model(), model({ summary: 'Analyzed again' })]);
    await analyzeApp(ctx);
    const file = JSON.parse(fs.readFileSync(ctx.paths.appModel, 'utf8')) as Record<string, unknown>;
    delete file.modelVersion;
    fs.writeFileSync(ctx.paths.appModel, JSON.stringify(file));
    await analyzeApp(ctx);
    expect(tasks.map((t) => t.name)).toEqual(['app-analyze', 'app-analyze']);
    expect(saved()).toMatchObject({ modelVersion: APP_MODEL_VERSION, summary: 'Analyzed again' });
  });

  it('updates the app-level facts and journeys when one page changes', async () => {
    const update = {
      summary: 'A shop with a new login',
      auth: 'magic link',
      stateManagement: 'context',
      integrations: ['sendLink() in src/api.ts'],
      pages: [page('/login', 'src/pages/Login.tsx', { purpose: 'sign in by link' })],
      flows: [flow('Sign in by link', ['/login'])],
      testData: ['a@b.c'],
      unknowns: ['how the link expires'],
    };
    const { root, ctx, tasks, saved } = project([model(), update]);
    await analyzeApp(ctx);
    fs.writeFileSync(path.join(root, 'src/pages/Login.tsx'), 'login v2');
    await analyzeApp(ctx);
    expect(tasks[1]!.name).toBe('app-analyze-1-pages');
    // The analyst sees the current app-level facts and is asked for complete, updated lists.
    expect(tasks[1]!.prompt).toContain('a@b.c / secret');
    expect(tasks[1]!.prompt).toContain('App summary:\nA shop');
    const after = saved();
    expect(after).toMatchObject({ summary: 'A shop with a new login', auth: 'magic link' });
    // Stale test data and journeys are replaced, not accumulated.
    expect(after.testData).toEqual(['a@b.c']);
    expect(after.flows.map((f) => f.name)).toEqual(['Sign in by link']);
    expect(after.pages.find((p) => p.route === '/')!.purpose).toBe('p');
    expect(after.pages.find((p) => p.route === '/login')!.purpose).toBe('sign in by link');
  });
});

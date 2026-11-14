import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { projectInfoJson, projectRules, systemPrompt } from '../ai/context.js';
import { hashFiles, listFiles, readJson, sha256, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import type { QaContext } from '../pipeline/context.js';

const log = logger('analyze');

const FieldSchema = z.object({
  label: z.string().describe('Accessible label as rendered'),
  type: z.string(),
  validation: z.array(z.string()).describe('Validation rules with exact messages, as implemented'),
});

/**
 * Version of the model's shape. Models written before journeys were ranked (version 1) cannot
 * drive scenario prioritization or critical-flow selection, so they are analyzed again in full.
 */
export const APP_MODEL_VERSION = 2;

export const PageModelSchema = z.object({
  route: z.string().describe('Route path exactly as in project discovery, e.g. "/checkout", "/orders/:id"'),
  name: z.string(),
  purpose: z.string().describe('What a user comes to this page to do, in one or two sentences'),
  importance: z
    .enum(['essential', 'secondary', 'optional'])
    .default('secondary')
    .describe(
      'essential: needed for the core purpose of the app or part of a critical journey; secondary: supports a main feature; optional: informational or rarely needed',
    ),
  access: z
    .string()
    .default('unknown')
    .describe(
      'Who can open the page as enforced in code: "public", or the sign-in/role required and what a visitor without it gets (redirect, message)',
    ),
  /** Source files (relative to project root) that implement this page, including shared layout/components. */
  files: z.array(z.string()),
  headings: z.array(z.string()).describe('Visible headings/titles as rendered text'),
  interactiveElements: z
    .array(z.string())
    .describe(
      'Buttons/links/inputs as role + exact accessible name + what they do, e.g. "button \'Add Ceramic Mug to cart\' (adds one unit to the cart)". Mention a data-testid when the element has one.',
    ),
  forms: z.array(
    z.object({
      name: z.string(),
      fields: z.array(FieldSchema),
      submitLabel: z.string(),
      successBehavior: z.string(),
      errorBehavior: z.string(),
    }),
  ),
  states: z.object({
    loading: z.string().nullable(),
    empty: z.string().nullable(),
    error: z.string().nullable(),
  }),
  dataDependencies: z
    .array(z.string())
    .describe('API calls, stores and contexts the page reads or writes, with the file that defines them'),
  preconditions: z
    .array(z.string())
    .describe('What must be true before the page is usable, e.g. "cart has items"'),
  navigatesTo: z
    .array(z.string())
    .default([])
    .describe('Routes a user can reach from this page through its own links, buttons and redirects'),
  responsiveBehavior: z
    .array(z.string())
    .describe('Media queries / breakpoints that affect this page, with values'),
  businessRules: z
    .array(z.string())
    .describe(
      'Calculations, conditions and rules as implemented, citing file:line. Prefix a rule that looks wrong with "SUSPICIOUS:" and say what a user would expect instead.',
    ),
});
export type PageModel = z.infer<typeof PageModelSchema>;

/** A user journey: a goal a user completes across one or more pages. */
export const FlowSchema = z.object({
  name: z.string().describe('The user goal, e.g. "Buy a product with a coupon"'),
  feature: z.string().describe('Short kebab-case feature key, e.g. "checkout", "auth"'),
  kind: z
    .enum(['happy-path', 'alternate', 'error-path'])
    .default('happy-path')
    .describe(
      'happy-path: the normal successful way to reach the goal; alternate: another successful way; error-path: a journey about recovering from a failure',
    ),
  criticality: z
    .enum(['critical', 'important', 'secondary'])
    .default('important')
    .describe(
      'critical: the app fails its core purpose if this journey breaks; important: a main feature users rely on, but the app still serves its purpose without it; secondary: convenience or rarely used',
    ),
  criticalityReason: z
    .string()
    .default('')
    .describe('One sentence: what the user or the business loses when this journey is broken'),
  preconditions: z
    .array(z.string())
    .default([])
    .describe('State the journey needs before its first step (signed in as…, data that must exist)'),
  steps: z
    .array(z.string())
    .describe(
      'User actions in order, naming controls by exact accessible name, with the INTENDED result of each key action',
    ),
  outcome: z
    .string()
    .default('')
    .describe(
      'The final INTENDED result that proves the journey succeeded, with the exact visible text when the code has one',
    ),
  routes: z.array(z.string()).describe('Routes visited, in order'),
  implementation: z
    .enum(['complete', 'partial', 'missing', 'unknown'])
    .default('unknown')
    .describe(
      'complete: the code implements every step and the outcome; partial: it works but a rule or result looks wrong; missing: a step or the outcome is not implemented at all; unknown: could not be determined',
    ),
  gaps: z
    .array(z.string())
    .default([])
    .describe('Every difference between the intended journey and what the code does, with file:line'),
});
export type Flow = z.infer<typeof FlowSchema>;

export const AppModelSchema = z.object({
  summary: z
    .string()
    .describe(
      'What the app is for, who uses it, its routes and how its parts work together. Facts only; open questions go in "unknowns".',
    ),
  pages: z.array(PageModelSchema),
  flows: z.array(FlowSchema),
  auth: z
    .string()
    .nullable()
    .describe(
      'How a session starts and is stored, which routes and actions it guards, the roles, and what a signed-out user gets. null when the app has no authentication.',
    ),
  stateManagement: z.string(),
  integrations: z
    .array(z.string())
    .default([])
    .describe(
      'Every API call or backend interaction: endpoint or function, what it sends and returns, how errors are handled, the file, the routes that use it, and whether it is real or simulated',
    ),
  testData: z
    .array(z.string())
    .describe('Valid test inputs found in code (credentials, coupon codes, ids...)'),
  styling: z.object({
    approach: z.string(),
    tokens: z.record(z.string(), z.string()).describe('Design tokens as implemented in code (CSS vars etc.)'),
  }),
  unknowns: z.array(z.string()),
});
export type AppModel = z.infer<typeof AppModelSchema>;

export const AppModelFileSchema = AppModelSchema.extend({
  /** See {@link APP_MODEL_VERSION}; missing in models written before it existed. */
  modelVersion: z.number().default(1),
  analyzedAt: z.string(),
  /** Hash of each page's own source files at analysis time; used to detect changed pages. */
  pageHashes: z.record(z.string(), z.string()),
  /** Per-file hashes of files shared by every page (router, layout, global styles). */
  globalFileHashes: z.record(z.string(), z.string()).default({}),
});
export type AppModelFile = z.infer<typeof AppModelFileSchema>;

/** True for a model written before journeys were ranked; it has to be analyzed again in full. */
export function isOutdatedModel(model: Pick<AppModelFile, 'modelVersion'>): boolean {
  return model.modelVersion < APP_MODEL_VERSION;
}

function sourceFiles(ctx: QaContext): string[] {
  return ctx.config.source.include.flatMap((dir) => {
    const full = path.join(ctx.root, dir);
    if (!fs.existsSync(full)) return [];
    return fs.statSync(full).isDirectory() ? listFiles(full, ctx.config.source.exclude) : [full];
  });
}

/**
 * Files that every page depends on (router entry, layout, global styles). They are hashed
 * separately so that registering a new route does not mark every existing page as changed.
 */
export function globalFilesOf(pages: ReadonlyArray<Pick<PageModel, 'files'>>): string[] {
  if (pages.length < 2) return [];
  return pages[0]!.files.filter((f) => pages.every((p) => p.files.includes(f))).sort();
}

/** Hash of the files a page depends on, excluding global files (missing files are ignored). */
export function pageHash(
  root: string,
  page: Pick<PageModel, 'files'>,
  globalFiles: readonly string[] = [],
): string {
  const files = page.files
    .filter((f) => !globalFiles.includes(f))
    .map((f) => path.join(root, f))
    .filter((f) => fs.existsSync(f));
  return hashFiles(root, files);
}

/** True for models written before shared files were hashed separately. */
export function isLegacyModel(model: AppModelFile): boolean {
  return Object.keys(model.globalFileHashes).length === 0 && globalFilesOf(model.pages).length > 0;
}

export function fileHashes(root: string, files: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    files
      .filter((f) => fs.existsSync(path.join(root, f)))
      .map((f) => [f, hashFiles(root, [path.join(root, f)])]),
  );
}

export function loadAppModel(ctx: QaContext): AppModelFile | undefined {
  return readJson(ctx.paths.appModel, AppModelFileSchema);
}

/**
 * The application model scenario design works from. Every testing mode calls this, so standard,
 * per-page and critical-flow scenarios are all derived from the same analysis.
 */
export function requireAppModel(ctx: QaContext): AppModelFile {
  const app = loadAppModel(ctx);
  if (!app) throw new Error('No .qa/app-model.json yet. Run `ai-qa-agent analyze` first.');
  if (isOutdatedModel(app)) {
    throw new Error(
      '.qa/app-model.json was written by an older version and has no ranked journeys. Run `ai-qa-agent analyze` to rebuild it.',
    );
  }
  return app;
}

/** The journeys every testing mode works from, most important first. */
export function rankedFlows(app: Pick<AppModel, 'flows'>): Flow[] {
  const rank = { critical: 0, important: 1, secondary: 2 } as const;
  const kind = { 'happy-path': 0, alternate: 1, 'error-path': 2 } as const;
  return [...app.flows].sort(
    (a, b) => rank[a.criticality] - rank[b.criticality] || kind[a.kind] - kind[b.kind],
  );
}

/** The critical happy paths: what critical-flow testing selects from the shared analysis. */
export function criticalFlows(app: Pick<AppModel, 'flows'>): Flow[] {
  return app.flows.filter((f) => f.criticality === 'critical' && f.kind === 'happy-path');
}

/** What the model must contain. Shared by the full analysis and the update of changed pages. */
const MODEL_RULES = `## What to record

Pages (one model per route):
- What a user sees and can do: headings, every button/link/input with its role and exact accessible name (derive it from aria-label, label/htmlFor, visible text) and what it does, forms with their validation rules and exact messages, loading/empty/error states, conditional rendering, preconditions.
- purpose and importance: what the page is for and how much the app depends on it. access: who can open it, as enforced in code. navigatesTo: where its links, buttons and redirects lead.
- dataDependencies: the stores, contexts and API calls it uses. businessRules: calculations and rules AS IMPLEMENTED, with file:line. Describe what the code does even when it looks wrong, and prefix such a rule with "SUSPICIOUS:" plus what a user would expect instead. Do not speculate beyond the code.
- responsiveBehavior: CSS media queries with exact breakpoint values and what changes.
- "files" lists every source file that affects the page (page component, layout, shared components, styles, state, api). Change detection depends on it.

Journeys ("flows"): the goals users complete, across as many pages as it takes.
- Include every happy path: the normal successful way to do each thing the app offers. Add an alternate or error-path journey only when it is a flow of its own (e.g. pay with a declined card). Single-field validation belongs to the page model, not here.
- steps and outcome state the INTENDED journey: user actions with exact accessible names, and what the user is meant to get. Where the code does something else (a wrong calculation, a button without a handler, a missing confirmation), keep the intended wording in steps/outcome, set "implementation" to partial or missing, and put the difference in "gaps" with file:line. Never hide a defect by writing the broken behaviour into a step, and never describe the current behaviour in "outcome": it holds the intended result only.
- A journey that is only the opening steps of another journey in the list is not a journey of its own.
- criticality ranks the journey by the app's purpose, not by how much code it has:
  critical = the app cannot fulfil its core purpose if this breaks (signing in when the app requires an account, the main purchase / submit / create action, paying). Most apps have between one and five. An app that lets users do anything has at least one.
  important = a main feature users rely on regularly, but the app still serves its purpose without it.
  secondary = convenience, informational or rarely used.
  criticalityReason says what the user or the business loses. If you cannot name a concrete loss, the journey is not critical.
- Every essential page is part of at least one critical or important journey.
- Order the list from the most to the least important journey.

App level:
- summary: what the app is for and how its parts work together. auth: how a session starts, where it is stored, what it guards. integrations: every API call or backend interaction and whether it is real or simulated. stateManagement: what state exists, where it lives and when it is lost (reload, navigation).
- testData: valid inputs found in code (credentials, coupon codes, product names) and the results they produce. Values a user enters or picks only: no URLs, ports or commands.
- styling tokens as implemented (CSS custom properties, theme values) with exact values.
- unknowns: anything you could not determine. Do not fill a gap with an assumption.`;

export interface AnalyzeOptions {
  /** Re-analyze everything, ignoring caches. */
  force?: boolean;
  /** Only (re)analyze these routes; other pages of the existing model are kept as they are. */
  routes?: string[];
}

function saveModel(ctx: QaContext, model: AppModel, inputHash: string, modelVersion: number): AppModelFile {
  const globalFiles = globalFilesOf(model.pages);
  const pageHashes = Object.fromEntries(
    model.pages.map((p) => [p.route, pageHash(ctx.root, p, globalFiles)]),
  );
  const file: AppModelFile = {
    ...model,
    modelVersion,
    analyzedAt: new Date().toISOString(),
    pageHashes,
    globalFileHashes: fileHashes(ctx.root, globalFiles),
  };
  writeJson(ctx.paths.appModel, file);
  ctx.state.markStage('analyze', inputHash);
  return file;
}

const normalizeRoute = (r: string): string => (r.length > 1 ? r.replace(/\/+$/, '') : r).toLowerCase();

/** Routes found deterministically in the project (file system / router) that have no page model. */
export function unmodeledRoutes(ctx: QaContext, pages: ReadonlyArray<Pick<PageModel, 'route'>>): string[] {
  let info: { routes?: Array<{ path?: string }> };
  try {
    info = JSON.parse(projectInfoJson(ctx)) as typeof info;
  } catch {
    return [];
  }
  const discovered = (info.routes ?? []).map((r) => r.path).filter((p): p is string => typeof p === 'string');
  const known = new Set(pages.map((p) => normalizeRoute(p.route)));
  return [...new Set(discovered)].filter((r) => !known.has(normalizeRoute(r)));
}

/**
 * Deterministic checks on what the analyst returned. Problems are logged and recorded in the
 * model's unknowns, so later agents and people see where the model is weak.
 */
export function modelProblems(ctx: QaContext, model: AppModel): string[] {
  const problems: string[] = [];
  const routes = new Set(model.pages.map((p) => normalizeRoute(p.route)));
  for (const r of unmodeledRoutes(ctx, model.pages)) {
    problems.push(`Route ${r} exists in the project but the analysis returned no page model for it.`);
  }
  for (const f of model.flows) {
    const unknown = f.routes.filter((r) => !routes.has(normalizeRoute(r)));
    if (unknown.length)
      problems.push(`Journey "${f.name}" visits routes without a page model: ${unknown.join(', ')}.`);
    if (f.criticality === 'critical' && !f.criticalityReason.trim()) {
      problems.push(`Journey "${f.name}" is ranked critical without a reason.`);
    }
  }
  if (model.flows.length > 0 && criticalFlows(model).length === 0) {
    problems.push('No journey is ranked critical, so critical-flow testing has nothing to select.');
  }
  for (const p of model.pages) {
    if (
      p.importance === 'essential' &&
      !model.flows.some((f) => f.routes.some((r) => normalizeRoute(r) === normalizeRoute(p.route)))
    ) {
      problems.push(`Page ${p.route} is essential but no journey goes through it.`);
    }
  }
  return problems;
}

function withProblems(ctx: QaContext, model: AppModel): AppModel {
  const marker = 'Model check: ';
  const problems = modelProblems(ctx, model);
  for (const p of problems) log.warn(p);
  return {
    ...model,
    unknowns: [...model.unknowns.filter((u) => !u.startsWith(marker)), ...problems.map((p) => marker + p)],
  };
}

/**
 * Builds/updates `.qa/app-model.json`: the one analysis every testing mode works from (standard,
 * per page, changed pages, critical flows). With an existing model, only pages whose source files
 * changed (or that were added) are re-analyzed, so unchanged pages keep their model verbatim and
 * downstream caches (scenarios, tests) stay valid for them; journeys and app-level facts are
 * updated for the whole app on every change.
 */
export async function analyzeApp(ctx: QaContext, opts: AnalyzeOptions = {}): Promise<AppModelFile> {
  const files = sourceFiles(ctx);
  const inputHash = sha256(hashFiles(ctx.root, files) + projectRules(ctx));
  const existing = loadAppModel(ctx);
  const outdated = !!existing && isOutdatedModel(existing);
  if (outdated) {
    log.info('The application model predates journey ranking; analyzing the whole application again');
  }
  if (!opts.force && existing && !outdated && ctx.state.isStageFresh('analyze', inputHash)) {
    if (isLegacyModel(existing)) {
      // Models from before per-page change tracking: the source is unchanged, so the new hashes
      // can be computed now without any AI work.
      log.info('Upgrading app-model.json hashes for per-page change detection');
      return saveModel(ctx, existing, inputHash, existing.modelVersion);
    }
    log.info('Application model is up to date');
    return existing;
  }
  if (existing && !opts.force && !outdated) {
    // Lazy import: changes/detect.ts imports this module.
    const { detectCodeChanges, routesToAnalyze } = await import('../changes/detect.js');
    const changes = detectCodeChanges(ctx, existing);
    const routes = opts.routes ?? routesToAnalyze(changes);
    const remaining = existing.pages.filter((p) => !changes.removedPages.includes(p.route));
    if (routes.length === 0) {
      if (changes.removedPages.length) log.info(`Dropping removed pages: ${changes.removedPages.join(', ')}`);
      else log.info('Source changed but no page is affected; model kept');
      const flows = existing.flows.filter((f) => !f.routes.some((r) => changes.removedPages.includes(r)));
      return saveModel(ctx, { ...existing, pages: remaining, flows }, inputHash, existing.modelVersion);
    }
    log.info(`Analyzing changed/new pages only: ${routes.join(', ')}`);
    const updated = await analyzeRoutes(ctx, { ...existing, pages: remaining }, routes);
    return saveModel(ctx, withProblems(ctx, updated), inputHash, existing.modelVersion);
  }

  log.info(`Analyzing application source (${files.length} files in ${ctx.config.source.include.join(', ')})`);
  const res = await ctx.ai.run({
    name: 'app-analyze',
    cwd: ctx.root,
    system: systemPrompt('app-analyst'),
    prompt: `## Task
Analyze the complete source code of this web application and produce its application model: every page, how the pages work together, the journeys users complete, and which journeys are critical. A QA engineer must be able to design and write end-to-end tests from your model without reading the code.

## Project discovery (deterministic, from package.json and the file system)
${projectInfoJson(ctx)}

## Scope
Source directories to read: ${ctx.config.source.include.join(', ')}
Do not read node_modules, build output or the .qa directory.
Every route in the discovery above gets a page model, using the route path exactly as written there. Routes you find in the code that discovery missed get one too.

## Procedure
1. Read the router / entry point and the shared layout. List every route, including nested, dynamic, redirecting and guarded ones.
2. For EVERY route, read its page component and follow its imports: components, state (stores, contexts, hooks), API clients, validation and styles. Never describe a page from its file name or from a similar page.
3. Read the code behind every API call or backend interaction: what is sent, what comes back, how errors are handled, whether it is real or simulated.
4. Read authentication and authorization: how a session starts, where it is stored, which routes and actions it guards, what a signed-out user gets.
5. Only after every page is read, derive the journeys across pages and rank them.
6. Check your model before answering: every route has a page model; every form, API call and guarded route appears in it; every journey step names a control that exists in a page model; every essential page is part of a journey; at least one journey is critical.

${MODEL_RULES}${projectRules(ctx)}`,
    schema: AppModelSchema,
    tools: ['Read', 'Glob', 'Grep'],
  });
  let model: AppModel = res.output;

  // The analyst must cover the whole app: routes it skipped are analyzed in a second pass.
  const missing = unmodeledRoutes(ctx, model.pages);
  if (missing.length) {
    log.warn(`Analysis skipped ${missing.length} route(s): ${missing.join(', ')}; analyzing them now`);
    model = await analyzeRoutes(ctx, model, missing);
  }
  model = withProblems(ctx, model);
  const file = saveModel(ctx, model, inputHash, APP_MODEL_VERSION);
  log.info(
    `Application model: ${model.pages.length} pages, ${model.flows.length} journeys (${criticalFlows(model).length} critical), ${model.testData.length} test data items`,
  );
  return file;
}

const PartialModelSchema = z.object({
  summary: AppModelSchema.shape.summary.describe('Updated summary of the whole app'),
  auth: AppModelSchema.shape.auth,
  stateManagement: z.string(),
  integrations: z.array(z.string()).describe('Complete, updated list for the whole app'),
  pages: z.array(PageModelSchema).describe('Only the requested routes'),
  flows: z.array(FlowSchema).describe('Complete, updated list of journeys for the whole app'),
  testData: z.array(z.string()).describe('Complete, updated list of test data for the whole app'),
  unknowns: z.array(z.string()).describe('Complete, updated list'),
});

/** Re-analyze a subset of routes and merge the result into the existing model. */
async function analyzeRoutes(ctx: QaContext, existing: AppModel, routes: string[]): Promise<AppModel> {
  const others = existing.pages.filter((p) => !routes.includes(p.route));
  const res = await ctx.ai.run({
    name: `app-analyze-${routes.length}-pages`,
    cwd: ctx.root,
    system: systemPrompt('app-analyst'),
    prompt: `## Task
Update the application model for these routes ONLY: ${routes.join(', ')}
They were added, their source files changed, or the previous analysis left them out. The other pages are unchanged: do not re-analyze them, but do update everything that describes the app as a whole (summary, authentication, integrations, journeys, test data), because a changed page can change a journey that crosses it.

## Project discovery (deterministic, from package.json and the file system)
${projectInfoJson(ctx)}

## Current application model

App summary:
${existing.summary}

Authentication:
${existing.auth ?? 'none found'}

State management:
${existing.stateManagement}

Integrations:
${JSON.stringify(existing.integrations, null, 2)}

Previous model of the pages to update (may be outdated; verify every statement against the code):
${JSON.stringify(
  existing.pages.filter((p) => routes.includes(p.route)),
  null,
  2,
)}

Unchanged pages (context only):
${JSON.stringify(
  others.map((p) => ({
    route: p.route,
    name: p.name,
    purpose: p.purpose,
    importance: p.importance,
    navigatesTo: p.navigatesTo,
    files: p.files,
  })),
  null,
  2,
)}

Journeys:
${JSON.stringify(existing.flows, null, 2)}

Test data:
${JSON.stringify(existing.testData, null, 2)}

Unknowns:
${JSON.stringify(existing.unknowns, null, 2)}

## Procedure
1. Read the router / entry point to locate the requested routes, then each page component and everything it imports (components, state, API clients, validation, styles).
2. Write a fresh page model for each requested route, using the route path exactly as given.
3. Update the journeys: keep those that are still correct, correct those that cross a requested route, add journeys the new or changed pages make possible, and drop journeys the code no longer supports. Re-rank criticality only where the change affects it.
4. Update summary, authentication, state management, integrations, test data and unknowns so they are true for the whole app as it is now. Remove test data and unknowns the code no longer supports.
5. Return the page models of the requested routes only, and complete lists for everything else.

${MODEL_RULES}${projectRules(ctx)}`,
    schema: PartialModelSchema,
    tools: ['Read', 'Glob', 'Grep'],
  });
  const returned = res.output.pages.filter((p) => routes.includes(p.route));
  const missing = routes.filter((r) => !returned.some((p) => p.route === r));
  if (missing.length) log.warn(`Analysis returned no model for: ${missing.join(', ')}`);
  const stale = existing.pages.filter((p) => missing.includes(p.route));
  return {
    ...existing,
    summary: res.output.summary,
    auth: res.output.auth,
    stateManagement: res.output.stateManagement,
    integrations: res.output.integrations,
    pages: [...others, ...stale, ...returned].sort((a, b) => a.route.localeCompare(b.route)),
    flows: res.output.flows,
    testData: res.output.testData,
    unknowns: res.output.unknowns,
  };
}

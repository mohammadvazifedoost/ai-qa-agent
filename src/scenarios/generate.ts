import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_SYSTEM, projectRules } from '../ai/context.js';
import { loadAppModel, type AppModelFile, type PageModel } from '../analyze/app.js';
import { listFiles, readJson, sha256, slugify, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import type { DesignSystemFile } from '../design/schema.js';
import type { QaContext } from '../pipeline/context.js';
import { ScenarioFileSchema, ScenarioSchema, type Scenario, type ScenarioFile } from './schema.js';

const log = logger('scenarios');

export function scenarioFilePath(ctx: QaContext, route: string): string {
  return path.join(ctx.paths.scenariosDir, `${pageSlug(route)}.json`);
}

export function pageSlug(route: string): string {
  return route === '/' ? 'home' : slugify(route);
}

export function loadDesign(ctx: QaContext): DesignSystemFile | undefined {
  if (!fs.existsSync(ctx.paths.designSystem)) return undefined;
  return JSON.parse(fs.readFileSync(ctx.paths.designSystem, 'utf8')) as DesignSystemFile;
}

export function loadAllScenarios(ctx: QaContext): Scenario[] {
  return listFiles(ctx.paths.scenariosDir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => readJson(f, ScenarioFileSchema)?.scenarios ?? []);
}

/** The subset of the design system relevant to one page (keeps prompts small). */
function designForPage(design: DesignSystemFile | undefined, route: string): unknown {
  if (!design) return null;
  const screens = design.screens.filter((s) => s.route === route);
  const refs = new Set(design.references.map((r) => r.screen));
  return {
    colors: design.colors,
    typography: design.typography,
    spacing: design.spacing,
    radius: design.radius,
    breakpoints: design.breakpoints,
    components: design.components,
    layoutRules: design.layoutRules,
    screens: screens.map((s) => ({ ...s, hasReferenceImage: refs.has(s.name) })),
    unknowns: design.unknowns,
  };
}

function inputHashFor(
  ctx: QaContext,
  app: AppModelFile,
  page: PageModel,
  design: DesignSystemFile | undefined,
): string {
  return sha256(
    JSON.stringify({
      page: app.pageHashes[page.route],
      model: page,
      design: designForPage(design, page.route),
      viewports: ctx.config.viewports,
      rules: projectRules(ctx),
    }),
  );
}

export interface ScenarioScope {
  page?: string;
  /** Limit to these routes (used by `run --changed`). */
  pages?: string[];
  force?: boolean;
  maxPerPage?: number;
}

export async function generateScenarios(ctx: QaContext, scope: ScenarioScope = {}): Promise<Scenario[]> {
  const app = loadAppModel(ctx);
  if (!app) throw new Error('No .qa/app-model.json yet. Run `ai-qa analyze` first.');
  const design = loadDesign(ctx);
  const pages = selectPages(app.pages, scope.page).filter(
    (p) => !scope.pages || scope.pages.includes(p.route),
  );

  for (const page of pages) {
    const file = scenarioFilePath(ctx, page.route);
    const existing = readJson(file, ScenarioFileSchema);
    const inputHash = inputHashFor(ctx, app, page, design);
    if (!scope.force && existing && existing.inputHash === inputHash) {
      log.info(`Scenarios for ${page.route} are up to date (${existing.scenarios.length})`);
      continue;
    }
    if (existing) log.info(`Inputs for ${page.route} changed — updating scenarios`);
    const scenarios = await generateForPage(ctx, app, page, design, existing, scope.maxPerPage ?? 10);
    writeJson(file, {
      page: page.route,
      generatedAt: new Date().toISOString(),
      inputHash,
      scenarios,
    } satisfies ScenarioFile);
    log.info(`Wrote ${scenarios.length} scenarios for ${page.route}`);
  }
  ctx.state.markStage('scenarios');
  return loadAllScenarios(ctx);
}

/**
 * Normalize a user-supplied page argument. Git Bash on Windows rewrites "/checkout" into
 * "C:/Program Files/Git/checkout", so undo that and accept "checkout", "/checkout" or "home".
 */
export function normalizePageArg(arg: string): string {
  const unmangled = arg.replace(/^[A-Za-z]:[\\/](?:Program Files[\\/])?Git[\\/]/i, '/');
  const q = unmangled.trim().toLowerCase();
  if (q === 'home' || q === '/') return '/';
  return q.startsWith('/') ? q : `/${q}`;
}

export function matchesPage(page: Pick<PageModel, 'route' | 'name'>, query: string): boolean {
  const q = normalizePageArg(query);
  return (
    page.route.toLowerCase() === q || `/${pageSlug(page.route)}` === q || `/${page.name.toLowerCase()}` === q
  );
}

/** Select pages by an optional query, failing loudly when nothing matches. */
export function selectPages<T extends Pick<PageModel, 'route' | 'name'>>(pages: T[], query?: string): T[] {
  if (!query) return pages;
  const hits = pages.filter((p) => matchesPage(p, query));
  if (hits.length === 0) {
    throw new Error(`No page matches "${query}". Known pages: ${pages.map((p) => p.route).join(', ')}`);
  }
  return hits;
}

async function generateForPage(
  ctx: QaContext,
  app: AppModelFile,
  page: PageModel,
  design: DesignSystemFile | undefined,
  existing: ScenarioFile | undefined,
  max: number,
): Promise<Scenario[]> {
  const prefix = pageSlug(page.route).toUpperCase().replace(/-/g, '');
  const flows = app.flows.filter((f) => f.routes.includes(page.route));
  const res = await ctx.ai.run({
    name: `scenarios-${pageSlug(page.route)}`,
    cwd: ctx.root,
    system: BASE_SYSTEM,
    prompt: `Design end-to-end test scenarios for the page ${page.route} ("${page.name}").

## Page model (from source analysis)
${JSON.stringify(page, null, 2)}

## User flows touching this page
${JSON.stringify(flows, null, 2)}

## Test data found in code
${JSON.stringify(app.testData)}

## Design system from Figma (null = no Figma design available)
${JSON.stringify(designForPage(design, page.route), null, 2)}

## Viewports available
${JSON.stringify(ctx.config.viewports)}

${existing ? `## Existing scenarios (keep ids stable for scenarios that still apply; keep "approved" values)\n${JSON.stringify(existing.scenarios, null, 2)}\n` : ''}
## Instructions
- Produce at most ${max} high-value scenarios for this page across categories: functional, visual, responsive. Quality over quantity: no trivial duplicates.
- functional: happy paths, validation, empty/error/loading states, navigation, and business rules (calculations!).
- visual: compare against Figma. Use design.tokens with EXACT values from the Figma data above (e.g. a primary button's backgroundColor/borderRadius/height). Only reference a Figma screen in design.screen if it has hasReferenceImage=true. If no Figma data exists, do not create visual scenarios.
- responsive: behaviour at tablet/mobile viewports (navigation collapse, no horizontal overflow, stacking), based on the design's mobile screens when available and general usability expectations.
- EXPECTED RESULTS MUST DESCRIBE CORRECT, INTENDED BEHAVIOUR — derived from the design, the UI copy and standard product conventions — NOT whatever the code happens to do. The page model flags suspicious logic; if code looks wrong (e.g. a discount shown but not subtracted from the total), the expected result must state the correct behaviour so the test can catch the bug.
- Steps must be concrete and use visible text / accessible names from the page model, and include the preconditions needed (e.g. add products on / first, since the cart is in-memory).
- ids: "${prefix}-001", "${prefix}-002", ... (reuse existing ids when updating).
- source.figma = the expectation comes from Figma data; source.code = derived from reading code.
- Set approved: true for new scenarios.${projectRules(ctx)}`,
    schema: z.object({ scenarios: z.array(ScenarioSchema) }),
    tools: ['Read', 'Glob', 'Grep'],
  });
  const viewports = Object.keys(ctx.config.viewports);
  return res.output.scenarios.map((s) => {
    if (!viewports.includes(s.viewport)) {
      log.warn(`Scenario ${s.id} uses unknown viewport "${s.viewport}", using "${viewports[0]}"`);
      return { ...s, viewport: viewports[0]! };
    }
    return s;
  });
}

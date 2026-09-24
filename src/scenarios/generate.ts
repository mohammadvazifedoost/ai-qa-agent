import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_SYSTEM, projectRules } from '../ai/context.js';
import { loadAppModel, type AppModelFile, type PageModel } from '../analyze/app.js';
import { listFiles, readJson, sha256, slugify, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import type { DesignSystemFile } from '../design/schema.js';
import type { QaContext } from '../pipeline/context.js';
import {
  AiScenarioSchema,
  isPersonScenario,
  ScenarioFileSchema,
  type RemovedScenario,
  type Scenario,
  type ScenarioFile,
} from './schema.js';

const log = logger('scenarios');

export function scenarioFilePath(ctx: QaContext, route: string): string {
  return path.join(ctx.paths.scenariosDir, `${pageSlug(route)}.json`);
}

export function pageSlug(route: string): string {
  return route === '/' ? 'home' : slugify(route);
}

/** Id prefix of a page's scenarios, e.g. "/order-history" → "ORDERHISTORY". */
export function scenarioIdPrefix(route: string): string {
  return pageSlug(route).toUpperCase().replace(/-/g, '');
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
  if (!app) throw new Error('No .qa/app-model.json yet. Run `ai-qa-agent analyze` first.');
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
      removed: existing?.removed ?? [],
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

/** Prompt section listing scenarios a person deleted, so the AI does not recreate them. */
export function removedSection(removed: readonly RemovedScenario[]): string {
  if (removed.length === 0) return '';
  const list = removed
    .map((r) => `- ${r.id}: ${r.title}${r.reason ? ` (reason: ${r.reason})` : ''}`)
    .join('\n');
  return `## Removed scenarios — DO NOT recreate
A person deleted these as unnecessary or unusable. Do not return them again, do not return scenarios that test the same thing under another title, and do not reuse their ids for new scenarios.
${list}
`;
}

const normalizeTitle = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Guard against the AI ignoring the instruction: drop anything matching a removed id or title. */
export function dropRemoved(scenarios: Scenario[], removed: readonly RemovedScenario[]): Scenario[] {
  const ids = new Set(removed.map((r) => r.id));
  const titles = new Set(removed.map((r) => normalizeTitle(r.title)));
  return scenarios.filter((s) => {
    const hit = ids.has(s.id) || titles.has(normalizeTitle(s.title));
    if (hit) log.warn(`Dropping ${s.id} "${s.title}": it was removed by a person`);
    return !hit;
  });
}

/** Prompt section listing scenarios a person wrote or edited, which the AI must leave alone. */
export function personSection(person: readonly Scenario[]): string {
  if (person.length === 0) return '';
  return `## Scenarios written by a person — keep as they are
These are maintained by a person and are kept exactly as written. Do not return them, do not return scenarios that test the same thing, and do not reuse their ids.
${person.map((s) => `- ${s.id}: ${s.title}`).join('\n')}
`;
}

/**
 * Merge the AI's scenarios with the ones a person owns: person scenarios win on id and title,
 * and the result is ordered by id.
 */
export function mergePersonScenarios(ai: Scenario[], person: readonly Scenario[]): Scenario[] {
  const ids = new Set(person.map((s) => s.id));
  const titles = new Set(person.map((s) => normalizeTitle(s.title)));
  const kept = ai.filter((s) => {
    const hit = ids.has(s.id) || titles.has(normalizeTitle(s.title));
    if (hit) log.warn(`Dropping ${s.id} "${s.title}": it collides with a scenario written by a person`);
    return !hit;
  });
  return [...kept, ...person].sort((a, b) => a.id.localeCompare(b.id));
}

async function generateForPage(
  ctx: QaContext,
  app: AppModelFile,
  page: PageModel,
  design: DesignSystemFile | undefined,
  existing: ScenarioFile | undefined,
  max: number,
): Promise<Scenario[]> {
  const prefix = scenarioIdPrefix(page.route);
  const person = existing?.scenarios.filter(isPersonScenario) ?? [];
  const aiExisting = existing?.scenarios.filter((s) => !isPersonScenario(s)) ?? [];
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

${aiExisting.length ? `## Existing scenarios (keep ids stable for scenarios that still apply; keep "approved" values)\n${JSON.stringify(aiExisting, null, 2)}\n` : ''}${personSection(person)}${removedSection(existing?.removed ?? [])}
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
    schema: z.object({ scenarios: z.array(AiScenarioSchema) }),
    tools: ['Read', 'Glob', 'Grep'],
  });
  const viewports = Object.keys(ctx.config.viewports);
  // Strip ownership fields in case an engine returns them anyway: only a person sets them.
  const fromAi = res.output.scenarios.map(({ origin: _o, editedAt: _e, ...s }: Scenario): Scenario => s);
  const ai = dropRemoved(fromAi, existing?.removed ?? []).map((s) => {
    if (!viewports.includes(s.viewport)) {
      log.warn(`Scenario ${s.id} uses unknown viewport "${s.viewport}", using "${viewports[0]}"`);
      return { ...s, viewport: viewports[0]! };
    }
    return s;
  });
  return mergePersonScenarios(ai, person);
}

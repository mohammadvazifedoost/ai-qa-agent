import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { projectRules, systemPrompt } from '../ai/context.js';
import { EXPECTATION_RULES, LOW_VALUE_RULES, PRIORITY_RUBRIC, STEP_RULES } from '../ai/prompts.js';
import {
  rankedFlows,
  requireAppModel,
  type AppModelFile,
  type Flow,
  type PageModel,
} from '../analyze/app.js';
import { listFiles, readJson, sha256, slugify, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import type { DesignSystemFile } from '../design/schema.js';
import type { QaContext } from '../pipeline/context.js';
import {
  AiScenarioSchema,
  isCriticalScenario,
  isPersonScenario,
  ScenarioFileSchema,
  type RemovedScenario,
  type Scenario,
  type ScenarioFile,
  withKnownRoutes,
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

/** The journeys that go through a page, most important first. */
export function flowsThrough(app: Pick<AppModelFile, 'flows'>, route: string): Flow[] {
  return rankedFlows(app).filter((f) => f.routes.includes(route));
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
      flows: flowsThrough(app, page.route),
      design: designForPage(design, page.route),
      viewports: ctx.config.viewports,
      rules: projectRules(ctx),
    }),
  );
}

export interface ScenarioPageStatus {
  route: string;
  scenarios: number;
  /** Scenarios a person wrote or edited; generation never changes them. */
  person: number;
  /** Scenarios a person removed; generation does not bring them back. */
  removed: number;
  /** `outdated`: the analysis, design or rules changed since the page's scenarios were written. */
  state: 'current' | 'outdated' | 'none';
}

/** Per page of the model: its scenarios and whether `generateScenarios` would write them again. */
export function scenarioPageStatus(ctx: QaContext, app: AppModelFile): ScenarioPageStatus[] {
  const design = loadDesign(ctx);
  return app.pages.map((page) => {
    const file = readJson(scenarioFilePath(ctx, page.route), ScenarioFileSchema);
    return {
      route: page.route,
      scenarios: file?.scenarios.length ?? 0,
      person: file?.scenarios.filter(isPersonScenario).length ?? 0,
      removed: file?.removed.length ?? 0,
      state: !file
        ? 'none'
        : file.inputHash === inputHashFor(ctx, app, page, design)
          ? 'current'
          : 'outdated',
    };
  });
}

export interface ScenarioScope {
  page?: string;
  /** Limit to these routes (used by `run --changed`). */
  pages?: string[];
  force?: boolean;
  /** Overrides `scenarios.maxPerPage` from the config; neither set means no limit. */
  maxPerPage?: number;
}

export async function generateScenarios(ctx: QaContext, scope: ScenarioScope = {}): Promise<Scenario[]> {
  const app = requireAppModel(ctx);
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
    const scenarios = await generateForPage(
      ctx,
      app,
      page,
      design,
      existing,
      scope.maxPerPage ?? ctx.config.scenarios.maxPerPage,
    );
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

/** Prompt section listing the critical flows that start on a page, which page generation keeps. */
export function criticalSection(critical: readonly Scenario[]): string {
  if (critical.length === 0) return '';
  return `## Critical flows starting on this page — keep as they are
These end-to-end smoke journeys are maintained by \`ai-qa-agent scenarios --critical\`. Do not return them, do not return scenarios that test the same journey, and do not reuse their ids.
${critical.map((s) => `- ${s.id}: ${s.title}`).join('\n')}
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
  /** Undefined means no limit. */
  max: number | undefined,
): Promise<Scenario[]> {
  const prefix = scenarioIdPrefix(page.route);
  const person = existing?.scenarios.filter(isPersonScenario) ?? [];
  // Critical flows belong to `scenarios --critical`: page regeneration keeps them as they are.
  const critical = existing?.scenarios.filter((s) => isCriticalScenario(s) && !isPersonScenario(s)) ?? [];
  const aiExisting = existing?.scenarios.filter((s) => !isPersonScenario(s) && !isCriticalScenario(s)) ?? [];
  const flows = flowsThrough(app, page.route);
  const otherPages = app.pages
    .filter((p) => p.route !== page.route)
    .map((p) => ({ route: p.route, name: p.name, purpose: p.purpose, preconditions: p.preconditions }));
  const res = await ctx.ai.run({
    name: `scenarios-${pageSlug(page.route)}`,
    cwd: ctx.root,
    system: systemPrompt('scenario-designer'),
    prompt: `## Task
Design the end-to-end test scenarios for the page ${page.route} ("${page.name}"). The whole application has already been analyzed; the model below is your source. Read source files only to confirm a detail the model leaves open.

## Application
${app.summary}

Authentication: ${app.auth ?? 'none'}
State: ${app.stateManagement}

## Page model (from the application analysis)
${JSON.stringify(page, null, 2)}

## Journeys through this page (ranked by the application analysis, most important first)
${JSON.stringify(flows, null, 2)}

## Other pages (for steps that start or continue elsewhere)
${JSON.stringify(otherPages, null, 2)}

## Test data found in code
${JSON.stringify(app.testData)}

## Design system from Figma (null = no Figma design available)
${JSON.stringify(designForPage(design, page.route), null, 2)}

## Viewports available
${JSON.stringify(ctx.config.viewports)}

${
  aiExisting.length
    ? `## Existing scenarios (keep ids stable for scenarios that still apply; keep "approved" values)
${JSON.stringify(aiExisting, null, 2)}
`
    : ''
}${personSection(person)}${criticalSection(critical)}${removedSection(existing?.removed ?? [])}
## Procedure
1. List what a user can do on this page and what the page must get right: its part in each journey above, its forms, its business rules and calculations, and the states (empty, error, loading) a user really reaches.
2. Rank every candidate with the priority scale below, and discard the ones the value rules exclude.
3. Cover first, in this order: this page's part in every critical and important journey; every business rule and calculation, with values worked out from the test data; each form's successful submission and its most important validation failures; then the remaining states and navigation.
4. Add visual, responsive and accessibility scenarios only as described under Categories.
5. Write each scenario following the step and expectation rules.
6. Review the set before answering: every scenario has an action and an outcome that proves something; no two scenarios would fail for the same defect; nothing important in step 1 is left without a scenario.

## How many
${max ? `Return at most ${max} high-value scenarios: the ${max} that matter most by the priority scale.` : 'Return what the page really needs and no more. Each scenario must earn its place; a simple page may need only two or three, a page with forms and calculations more.'}

## Priority
${PRIORITY_RUBRIC}

## Value
${LOW_VALUE_RULES}

## Categories
- functional: journeys, business rules, form submission and validation, states, navigation. This is where most of the value is.
- visual: only when Figma data exists. Compare against Figma with design.tokens holding EXACT values from the Figma data above (e.g. a primary button's backgroundColor / borderRadius / height). Set design.screen only to a screen with hasReferenceImage=true. One scenario per designed state, not one per element.
- responsive: behaviour that changes at tablet/mobile viewports according to the page model or the design (navigation collapse, stacking, no horizontal overflow). Skip it when nothing on the page changes with the viewport.
- accessibility: one or two per page, checking WCAG 2.1 A/AA with an automated audit in the states that matter (the page loaded, a form showing its validation errors, an open dialog or menu). Steps reach the state; expected results name what must be accessible (labels, alt text, contrast, headings, keyboard-reachable controls).

## Writing rules
${STEP_RULES}
${EXPECTATION_RULES}
- "rationale" names the functionality the scenario protects and what users lose if it breaks.
- ids: "${prefix}-001", "${prefix}-002", ... (reuse existing ids when updating).
- source.figma = the expectation comes from Figma data; source.code = derived from reading code.
- Set approved: true for new scenarios.${projectRules(ctx)}`,
    schema: z.object({ scenarios: z.array(AiScenarioSchema) }),
    tools: ['Read', 'Glob', 'Grep'],
  });
  const viewports = Object.keys(ctx.config.viewports);
  // Strip ownership fields in case an engine returns them anyway: only a person sets them.
  const fromAi = res.output.scenarios.map(
    ({ origin: _o, editedAt: _e, critical: _c, ...s }: Scenario): Scenario => s,
  );
  const known = app.pages.map((p) => p.route);
  const ai = dropRemoved(fromAi, existing?.removed ?? []).map((raw) => {
    // A scenario belongs to the page it was designed for, whatever the AI wrote.
    const s = withKnownRoutes({ ...raw, page: page.route }, known);
    if (!viewports.includes(s.viewport)) {
      log.warn(`Scenario ${s.id} uses unknown viewport "${s.viewport}", using "${viewports[0]}"`);
      return { ...s, viewport: viewports[0]! };
    }
    return s;
  });
  return mergePersonScenarios(ai, [...person, ...critical]);
}

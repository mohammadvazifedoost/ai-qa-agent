/**
 * Critical flows: a small smoke layer of the app's core end-to-end journeys (log in, checkout, the
 * primary create/submit action). They are ordinary scenarios marked `critical: true`, stored on the
 * page where the journey starts, so test generation and the runner need no separate pipeline.
 */
import { z } from 'zod';
import { BASE_SYSTEM, projectRules } from '../ai/context.js';
import { loadAppModel, type AppModelFile } from '../analyze/app.js';
import { readJson, sha256, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import type { QaContext } from '../pipeline/context.js';
import type { TestFilter } from '../runner/run.js';
import { nextScenarioId } from './author.js';
import {
  dropRemoved,
  loadAllScenarios,
  personSection,
  removedSection,
  scenarioFilePath,
} from './generate.js';
import { normalizeId } from './manage.js';
import {
  AiScenarioSchema,
  isCriticalScenario,
  isPersonScenario,
  ScenarioFileSchema,
  type Scenario,
  type ScenarioFile,
} from './schema.js';

const log = logger('scenarios');

export const DEFAULT_MAX_CRITICAL = 5;

const normalizeTitle = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Everything the critical flows are derived from; a change makes `scenarios --critical` ask the AI again. */
export function criticalInputHash(ctx: QaContext, app: AppModelFile): string {
  return sha256(
    JSON.stringify({
      pageHashes: app.pageHashes,
      pages: app.pages,
      flows: app.flows,
      testData: app.testData,
      auth: app.auth,
      viewports: ctx.config.viewports,
      rules: projectRules(ctx),
    }),
  );
}

/** A compact view of the app: enough to pick journeys without every page's full model. */
function appOutline(app: AppModelFile): unknown {
  return app.pages.map((p) => ({
    route: p.route,
    name: p.name,
    purpose: p.purpose,
    forms: p.forms.map((f) => ({ name: f.name, submitLabel: f.submitLabel, success: f.successBehavior })),
    interactiveElements: p.interactiveElements,
    preconditions: p.preconditions,
  }));
}

export function buildCriticalPrompt(
  ctx: QaContext,
  app: AppModelFile,
  existing: { ai: readonly Scenario[]; person: readonly Scenario[]; removed: ScenarioFile['removed'] },
  max: number,
): string {
  const viewport = Object.keys(ctx.config.viewports)[0];
  return `Identify the CRITICAL user journeys of this application and write one end-to-end test scenario for each.
Critical journeys are the few core flows a user must be able to complete for the app to be considered working, such as logging in, the main purchase or checkout flow, or the primary create/submit action. Together they form a smoke test that answers "is the app basically working?".

## App summary
${app.summary}

## Authentication
${app.auth ?? 'none found'}

## Pages
${JSON.stringify(appOutline(app), null, 2)}

## User flows found in code
${JSON.stringify(app.flows, null, 2)}

## Test data found in code
${JSON.stringify(app.testData)}

${existing.ai.length ? `## Existing critical flows (keep ids stable for journeys that still apply; keep "approved" values)\n${JSON.stringify(existing.ai, null, 2)}\n` : ''}${personSection(existing.person)}${removedSection(existing.removed)}
## Instructions
- Return at most ${max} scenarios, one per critical journey. Fewer is better: only journeys whose failure would make the app unusable or block its main purpose. No secondary features, edge cases, validation errors, visual, responsive or accessibility checks.
- Every scenario is category "functional", priority "high", and the happy path, completed end to end. A journey may span several pages: "page" is the route where it starts, and the steps move through the following pages with visible links and buttons.
- Steps must be concrete and use visible text / accessible names from the pages above. Include the preconditions and test data the journey needs (e.g. credentials found in code).
- Expected results describe CORRECT, INTENDED behaviour, including the final outcome of the journey (e.g. the order confirmation is shown), not whatever the code happens to do.
- feature: kebab-case key of the journey, e.g. auth, checkout. viewport: "${viewport}". design: null. source.code = true.
- ids: reuse the id of an existing critical flow that still applies. For a new journey use NEW-001, NEW-002, ...; it is renumbered for its page.
- Set approved: true for new scenarios.${projectRules(ctx)}`;
}

/**
 * Fold the AI's critical flows into the page files. Only AI-written critical flows are replaced:
 * regular scenarios, person scenarios and tombstones are kept, removed flows are not brought back,
 * and an existing scenario with the same title is marked critical instead of duplicated.
 * Returns the files that changed, by route.
 */
export function mergeCriticalScenarios(
  files: ReadonlyMap<string, ScenarioFile | undefined>,
  fromAi: readonly Scenario[],
  viewports: readonly string[],
): Map<string, ScenarioFile> {
  const all = [...files.values()].flatMap((f) => f?.scenarios ?? []);
  const removed = [...files.values()].flatMap((f) => f?.removed ?? []);
  const personTitles = new Set(all.filter(isPersonScenario).map((s) => normalizeTitle(s.title)));

  const incoming = dropRemoved(
    fromAi.map(({ origin: _o, editedAt: _e, ...s }): Scenario => ({
      ...s,
      category: 'functional',
      priority: 'high',
      design: null,
      viewport: viewports.includes(s.viewport) ? s.viewport : viewports[0]!,
      critical: true,
    })),
    removed,
  ).filter((s) => {
    if (!files.has(s.page)) {
      log.warn(`Dropping critical flow "${s.title}": unknown start page ${s.page}`);
      return false;
    }
    if (personTitles.has(normalizeTitle(s.title))) {
      log.warn(`Dropping critical flow "${s.title}": it duplicates a scenario written by a person`);
      return false;
    }
    return true;
  });

  const changed = new Map<string, ScenarioFile>();
  for (const [route, original] of files) {
    const before = original?.scenarios ?? [];
    const oldCritical = before.filter((s) => isCriticalScenario(s) && !isPersonScenario(s));
    const mine = incoming.filter((s) => s.page === route);
    if (oldCritical.length === 0 && mine.length === 0) continue;

    const file: ScenarioFile = original
      ? {
          ...original,
          scenarios: before.filter((s) => !oldCritical.includes(s)).map((s) => ({ ...s })),
        }
      : // An empty input hash makes the next `ai-qa-agent scenarios` fill in the page's other scenarios.
        { page: route, generatedAt: new Date().toISOString(), inputHash: '', scenarios: [], removed: [] };
    for (const s of mine) {
      const same = file.scenarios.find(
        (x) => !isPersonScenario(x) && normalizeTitle(x.title) === normalizeTitle(s.title),
      );
      if (same) {
        if (!isCriticalScenario(same)) log.info(`Marking ${same.id} "${same.title}" as a critical flow`);
        same.critical = true;
        continue;
      }
      // The same journey keeps its id, matched by id or, when the AI did not reuse it, by title.
      const kept =
        oldCritical.find((x) => x.id === s.id) ??
        oldCritical.find((x) => normalizeTitle(x.title) === normalizeTitle(s.title));
      // Dropped flows' ids stay used, so a new journey never inherits an old one's results.
      const id =
        kept && !file.scenarios.some((x) => x.id === kept.id)
          ? kept.id
          : nextScenarioId(route, { ...file, scenarios: [...file.scenarios, ...oldCritical] });
      file.scenarios.push({ ...s, id, approved: kept ? kept.approved : s.approved });
    }
    file.scenarios.sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(file.scenarios) !== JSON.stringify(before)) changed.set(route, file);
  }
  return changed;
}

export interface CriticalScope {
  force?: boolean;
  /** Maximum number of critical flows (default 5). */
  max?: number;
}

/** Ask the AI for the app's critical flows and merge them into the scenario files. */
export async function generateCriticalScenarios(
  ctx: QaContext,
  scope: CriticalScope = {},
): Promise<Scenario[]> {
  const app = loadAppModel(ctx);
  if (!app) throw new Error('No .qa/app-model.json yet. Run `ai-qa-agent analyze` first.');
  const files = new Map(
    app.pages.map((p) => [p.route, readJson(scenarioFilePath(ctx, p.route), ScenarioFileSchema)] as const),
  );
  const all = [...files.values()].flatMap((f) => f?.scenarios ?? []);
  const critical = all.filter(isCriticalScenario);
  const inputHash = criticalInputHash(ctx, app);
  if (!scope.force && critical.length && ctx.state.data.criticalInputs === inputHash) {
    log.info(`Critical flows are up to date (${critical.length})`);
    return critical;
  }

  const existing = {
    ai: critical.filter((s) => !isPersonScenario(s)),
    person: critical.filter(isPersonScenario),
    removed: [...files.values()].flatMap((f) => f?.removed ?? []),
  };
  const res = await ctx.ai.run({
    name: 'scenarios-critical',
    cwd: ctx.root,
    system: BASE_SYSTEM,
    prompt: buildCriticalPrompt(ctx, app, existing, scope.max ?? DEFAULT_MAX_CRITICAL),
    schema: z.object({ scenarios: z.array(AiScenarioSchema) }),
    tools: ['Read', 'Glob', 'Grep'],
  });
  const changed = mergeCriticalScenarios(files, res.output.scenarios, Object.keys(ctx.config.viewports));
  for (const [route, file] of changed) {
    writeJson(scenarioFilePath(ctx, route), file);
    log.info(`Updated critical flows on ${route}`);
  }
  ctx.state.data.criticalInputs = inputHash;
  ctx.state.save();
  return loadAllScenarios(ctx).filter(isCriticalScenario);
}

/**
 * Narrow a test filter to the approved critical flows. Selection is by scenario id, so it does not
 * depend on how a spec was tagged; category/feature tags and `--grep` ids narrow it further.
 */
export function criticalTestFilter(ctx: QaContext, filter: TestFilter = {}): TestFilter {
  const tags = (filter.tags ?? []).map((t) => t.replace(/^@/, ''));
  const ids = filter.scenarioIds?.map(normalizeId);
  const picked = loadAllScenarios(ctx).filter(
    (s) =>
      s.approved &&
      isCriticalScenario(s) &&
      (tags.length === 0 || tags.includes(s.category) || tags.includes(s.feature)) &&
      (!ids || ids.includes(s.id)),
  );
  if (picked.length === 0) {
    throw new Error(
      'No approved critical flows match. Run `ai-qa-agent scenarios --critical` and `ai-qa-agent generate --critical` first.',
    );
  }
  return { files: filter.files, scenarioIds: picked.map((s) => s.id) };
}

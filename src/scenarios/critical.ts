/**
 * Critical flows: a small smoke layer of the app's core end-to-end journeys (log in, checkout, the
 * primary create/submit action). They are ordinary scenarios marked `critical: true`, stored on the
 * page where the journey starts, so test generation and the runner need no separate pipeline.
 *
 * Which journeys are critical is decided once, by the application analysis every testing mode
 * shares (`flows[].criticality` in the app model). This module only selects those journeys and has
 * a scenario written for each; it never analyzes the app on its own.
 */
import { z } from 'zod';
import { projectRules, systemPrompt } from '../ai/context.js';
import { EXPECTATION_RULES, STEP_RULES } from '../ai/prompts.js';
import { criticalFlows, requireAppModel, type AppModelFile, type Flow } from '../analyze/app.js';
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
  withKnownRoutes,
  type Scenario,
  type ScenarioFile,
} from './schema.js';

const log = logger('scenarios');

const normalizeTitle = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The journeys critical-flow testing covers: the critical happy paths of the shared analysis, in
 * the analyst's order of importance, cut to `max` when a limit is set.
 */
export function selectCriticalJourneys(app: Pick<AppModelFile, 'flows'>, max?: number): Flow[] {
  const journeys = criticalFlows(app);
  return max ? journeys.slice(0, max) : journeys;
}

/** The page models a set of journeys needs, without the fields that only matter for other test types. */
function journeyPages(app: AppModelFile, journeys: readonly Flow[]): unknown[] {
  const routes = new Set(journeys.flatMap((j) => j.routes));
  return app.pages
    .filter((p) => routes.has(p.route))
    .map(({ files: _f, responsiveBehavior: _r, ...page }) => page);
}

/** Everything the critical flows are derived from; a change makes `scenarios --critical` ask the AI again. */
export function criticalInputHash(ctx: QaContext, app: AppModelFile, max?: number): string {
  const journeys = selectCriticalJourneys(app, max);
  return sha256(
    JSON.stringify({
      journeys,
      pages: journeyPages(app, journeys),
      testData: app.testData,
      auth: app.auth,
      viewports: ctx.config.viewports,
      rules: projectRules(ctx),
    }),
  );
}

/** The viewport critical flows run in: desktop when the project has one, otherwise its first viewport. */
function preferredViewport(viewports: readonly string[]): string {
  return viewports.includes('desktop') ? 'desktop' : viewports[0]!;
}

export interface CriticalContext {
  ai: readonly Scenario[];
  person: readonly Scenario[];
  removed: ScenarioFile['removed'];
  /** Approved functional scenarios that are not critical flows; one may already cover a journey. */
  regular: readonly Scenario[];
}

export function buildCriticalPrompt(
  ctx: QaContext,
  app: AppModelFile,
  journeys: readonly Flow[],
  existing: CriticalContext,
): string {
  const routes = new Set(journeys.flatMap((j) => j.routes));
  const otherPages = app.pages
    .filter((p) => !routes.has(p.route))
    .map((p) => ({ route: p.route, name: p.name, purpose: p.purpose }));
  const regular = existing.regular.length
    ? `## Existing scenarios that may already cover a journey\n${existing.regular.map((s) => `- ${s.id} (${s.page}, ${s.priority}): ${s.title}`).join('\n')}\n`
    : '';
  return `## Task
Write one end-to-end test scenario for each critical journey listed below. Together they are the smoke test that answers "can users still do what this application exists for?".
The journeys were identified and ranked by the application analysis that every testing mode shares. Your job is to turn each one into a scenario, not to choose different journeys.

## Critical journeys to cover (from the application model, most important first)
${JSON.stringify(journeys, null, 2)}

## Application
${app.summary}

Authentication: ${app.auth ?? 'none found'}
State: ${app.stateManagement}
Integrations: ${JSON.stringify(app.integrations)}

## Page models of every route these journeys visit
${JSON.stringify(journeyPages(app, journeys), null, 2)}

## Other pages (context only)
${JSON.stringify(otherPages)}

## Test data found in code
${JSON.stringify(app.testData)}

${existing.ai.length ? `## Existing critical flows (keep ids stable for journeys that still apply; keep "approved" values)\n${JSON.stringify(existing.ai, null, 2)}\n` : ''}${regular}${personSection(existing.person)}${removedSection(existing.removed)}
## Procedure
1. Take the journeys one by one, in the order given. Check every step against the page models: the control exists under that exact name, and the state the step needs has been built by the steps before it. Open the source file named in a journey's "gaps" or in a page's businessRules when the model leaves a doubt.
2. If an existing scenario from the list above already performs the whole journey end to end and checks its outcome, return it in "promote" instead of writing a duplicate.
3. Otherwise write the scenario for the journey.
4. A journey that cannot be turned into a scenario (a person removed it, a person already wrote it, or it needs something a browser test cannot do) goes in "skipped" with the reason. Never drop a journey silently.

## Rules
- Exactly one scenario per journey, the happy path completed end to end. "journey" repeats the journey's name exactly as given.
- Every scenario is category "functional" and priority "high". "page" is the route where the journey starts; the steps move through the following pages using visible links and buttons, the way a user would (a URL load can reset in-memory state).
- Each scenario runs on its own from a fresh browser with no session. When a journey needs a signed-in user, signing in is part of its preconditions and steps.
- Expected results follow the journey: after each step that changes page or state, one checkpoint that proves it worked (e.g. the cart count, the heading of the next page); the journey's final outcome comes last.
- Only the journey itself: no validation errors, edge cases, visual, responsive or accessibility checks.
${STEP_RULES}
${EXPECTATION_RULES}
- A journey with implementation "partial" or "missing" still gets its scenario: the expected results state the intended outcome, so the smoke test fails until the application is fixed. Copy the relevant gap into "rationale".
- feature: kebab-case key of the journey, e.g. auth, checkout. viewport: "${preferredViewport(Object.keys(ctx.config.viewports))}". design: null. source.code = true.
- ids: reuse the id of an existing critical flow that still applies. For a new journey use NEW-001, NEW-002, ...; it is renumbered for its page.
- "rationale" says why the app cannot do without this journey (use the journey's criticalityReason).
- Set approved: true for new scenarios.${projectRules(ctx)}`;
}

/**
 * Fold the AI's critical flows into the page files. Only AI-written critical flows are replaced:
 * regular scenarios, person scenarios and tombstones are kept, removed flows are not brought back,
 * and an existing scenario with the same title, or one named in `promote`, is marked critical
 * instead of duplicated. Returns the files that changed, by route.
 */
export function mergeCriticalScenarios(
  files: ReadonlyMap<string, ScenarioFile | undefined>,
  fromAi: readonly Scenario[],
  viewports: readonly string[],
  /** Ids of existing scenarios that already cover a critical journey. */
  promote: readonly string[] = [],
): Map<string, ScenarioFile> {
  const all = [...files.values()].flatMap((f) => f?.scenarios ?? []);
  const removed = [...files.values()].flatMap((f) => f?.removed ?? []);
  const personTitles = new Set(all.filter(isPersonScenario).map((s) => normalizeTitle(s.title)));
  const knownRoutes = [...files.keys()];
  const promoted = new Set(promote.map(normalizeId));

  const incoming = dropRemoved(
    fromAi.map(({ origin: _o, editedAt: _e, ...s }): Scenario =>
      withKnownRoutes(
        {
          ...s,
          category: 'functional',
          priority: 'high',
          design: null,
          viewport: viewports.includes(s.viewport) ? s.viewport : preferredViewport(viewports),
          critical: true,
        },
        knownRoutes,
      ),
    ),
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
    // A promoted scenario is kept as it is and marked critical; it is not a flow to replace.
    const oldCritical = before.filter(
      (s) => isCriticalScenario(s) && !isPersonScenario(s) && !promoted.has(s.id),
    );
    const mine = incoming.filter((s) => s.page === route);
    const toPromote = before.filter((s) => promoted.has(s.id) && !isCriticalScenario(s));
    if (oldCritical.length === 0 && mine.length === 0 && toPromote.length === 0) continue;

    const file: ScenarioFile = original
      ? {
          ...original,
          scenarios: before.filter((s) => !oldCritical.includes(s)).map((s) => ({ ...s })),
        }
      : // An empty input hash makes the next `ai-qa-agent scenarios` fill in the page's other scenarios.
        { page: route, generatedAt: new Date().toISOString(), inputHash: '', scenarios: [], removed: [] };
    for (const s of file.scenarios) {
      if (promoted.has(s.id) && !isCriticalScenario(s)) {
        log.info(`Marking ${s.id} "${s.title}" as a critical flow: it already covers the journey`);
        s.critical = true;
      }
    }
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
  /** Overrides `scenarios.maxCritical` from the config; neither set means no limit. */
  max?: number;
}

const CriticalOutputSchema = z.object({
  scenarios: z.array(
    AiScenarioSchema.extend({
      journey: z.string().describe('Name of the critical journey this scenario covers, exactly as given'),
    }),
  ),
  promote: z
    .array(z.object({ scenarioId: z.string(), journey: z.string() }))
    .describe('Existing scenarios that already cover a journey end to end; empty when there are none'),
  skipped: z
    .array(z.object({ journey: z.string(), reason: z.string() }))
    .describe('Journeys that got no scenario, and why; empty when every journey is covered'),
});

/**
 * Select the critical journeys from the shared application model and have one scenario written for
 * each, merged into the scenario files.
 */
export async function generateCriticalScenarios(
  ctx: QaContext,
  scope: CriticalScope = {},
): Promise<Scenario[]> {
  const app = requireAppModel(ctx);
  const files = new Map(
    app.pages.map((p) => [p.route, readJson(scenarioFilePath(ctx, p.route), ScenarioFileSchema)] as const),
  );
  const all = [...files.values()].flatMap((f) => f?.scenarios ?? []);
  const critical = all.filter(isCriticalScenario);
  const max = scope.max ?? ctx.config.scenarios.maxCritical;
  const journeys = selectCriticalJourneys(app, max);
  if (journeys.length === 0) {
    log.warn(
      'The application analysis ranked no journey as critical, so there is nothing to select. Check "flows" in .qa/app-model.json or run `ai-qa-agent analyze --refresh`.',
    );
    return critical;
  }
  const inputHash = criticalInputHash(ctx, app, max);
  if (!scope.force && critical.length && ctx.state.data.criticalInputs === inputHash) {
    log.info(`Critical flows are up to date (${critical.length})`);
    return critical;
  }

  log.info(
    `Critical journeys selected from the application model: ${journeys.map((j) => `"${j.name}"`).join(', ')}`,
  );
  const existing: CriticalContext = {
    ai: critical.filter((s) => !isPersonScenario(s)),
    person: critical.filter(isPersonScenario),
    removed: [...files.values()].flatMap((f) => f?.removed ?? []),
    regular: all.filter((s) => !isCriticalScenario(s) && s.approved && s.category === 'functional'),
  };
  const res = await ctx.ai.run({
    name: 'scenarios-critical',
    cwd: ctx.root,
    system: systemPrompt('scenario-designer'),
    prompt: buildCriticalPrompt(ctx, app, journeys, existing),
    schema: CriticalOutputSchema,
    tools: ['Read', 'Glob', 'Grep'],
  });
  const out = res.output;
  const promote = (out.promote ?? []).filter((p) => {
    const hit = all.some((s) => s.id === normalizeId(p.scenarioId));
    if (!hit) log.warn(`Ignoring the promotion of unknown scenario ${p.scenarioId}`);
    return hit;
  });
  const skipped = out.skipped ?? [];
  for (const s of skipped) log.warn(`Critical journey "${s.journey}" got no scenario: ${s.reason}`);
  // Every selected journey must be accounted for: written, promoted or skipped with a reason.
  const accounted = new Set(
    [...out.scenarios, ...promote, ...skipped].map((x) => normalizeTitle(x.journey ?? '')),
  );
  for (const j of journeys) {
    if (!accounted.has(normalizeTitle(j.name))) log.warn(`Critical journey "${j.name}" was not covered`);
  }

  const scenarios = out.scenarios.map(({ journey: _j, ...s }): Scenario => s);
  const changed = mergeCriticalScenarios(
    files,
    scenarios,
    Object.keys(ctx.config.viewports),
    promote.map((p) => p.scenarioId),
  );
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

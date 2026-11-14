import { z } from 'zod';
import { projectRules, systemPrompt } from '../ai/context.js';
import { EXPECTATION_RULES, PRIORITY_RUBRIC, STEP_RULES } from '../ai/prompts.js';
import { loadAppModel } from '../analyze/app.js';
import { readJson, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import type { QaContext } from '../pipeline/context.js';
import { flowsThrough, pageSlug, scenarioFilePath, scenarioIdPrefix } from './generate.js';
import { normalizeId } from './manage.js';
import {
  CATEGORIES,
  ScenarioFileSchema,
  ScenarioSchema,
  type Scenario,
  type ScenarioFile,
} from './schema.js';

const log = logger('scenarios');

/** The fields a person fills in on the dashboard form (also what the AI drafts). */
export const ScenarioDraftSchema = z.object({
  title: z.string(),
  category: z.enum(CATEGORIES),
  priority: z.enum(['high', 'medium', 'low']),
  viewport: z.string().describe('Name of a configured viewport'),
  feature: z.string().describe('kebab-case feature key, e.g. checkout, auth, navigation'),
  preconditions: z.array(z.string()),
  steps: z.array(z.string()),
  expectedResults: z.array(z.string()),
  testData: z.array(z.string()),
  rationale: z.string(),
});
export type ScenarioDraft = z.infer<typeof ScenarioDraftSchema>;

export const ScenarioInputSchema = ScenarioDraftSchema.partial({
  feature: true,
  preconditions: true,
  testData: true,
  rationale: true,
}).extend({ page: z.string() });
export type ScenarioInput = z.infer<typeof ScenarioInputSchema>;

/** Input a person can fix: shown to them as-is (HTTP 400 on the dashboard). */
export class ScenarioInputError extends Error {}

const lines = (a: string[] | undefined): string[] => (a ?? []).map((x) => x.trim()).filter(Boolean);

/** Next unused id on a page; removed ids count as used so `restore` never collides. */
export function nextScenarioId(route: string, file: ScenarioFile | undefined): string {
  const prefix = scenarioIdPrefix(route);
  const used = [...(file?.scenarios ?? []), ...(file?.removed ?? [])]
    .map((s) => s.id.match(new RegExp(`^${prefix}-(\\d+)$`))?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return `${prefix}-${String(Math.max(0, ...used) + 1).padStart(3, '0')}`;
}

/**
 * Add a scenario (no `id`) or edit one (with `id`). Either way it becomes a person scenario:
 * approved, and never rewritten or dropped when the AI regenerates the page.
 */
export function saveScenario(ctx: QaContext, raw: unknown, id?: string): Scenario {
  const parsed = ScenarioInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScenarioInputError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
    );
  }
  const input = parsed.data;
  const title = input.title.trim();
  const steps = lines(input.steps);
  const expectedResults = lines(input.expectedResults);
  if (!title) throw new ScenarioInputError('A title is required.');
  if (steps.length === 0) throw new ScenarioInputError('Add at least one step.');
  if (expectedResults.length === 0) throw new ScenarioInputError('Add at least one expected result.');
  if (!(input.viewport in ctx.config.viewports)) {
    throw new ScenarioInputError(
      `Unknown viewport "${input.viewport}". Configured: ${Object.keys(ctx.config.viewports).join(', ')}`,
    );
  }

  const path = scenarioFilePath(ctx, input.page);
  let file = readJson(path, ScenarioFileSchema);
  let existing: Scenario | undefined;
  if (id) {
    const wanted = normalizeId(id);
    existing = file?.scenarios.find((s) => s.id === wanted);
    if (!existing) {
      const elsewhere = loadAppModel(ctx)
        ?.pages.map((p) => readJson(scenarioFilePath(ctx, p.route), ScenarioFileSchema))
        .find((f) => f?.scenarios.some((s) => s.id === wanted));
      throw new ScenarioInputError(
        elsewhere
          ? `${wanted} belongs to ${elsewhere.page}; a scenario cannot move to another page.`
          : `Unknown scenario ${wanted}.`,
      );
    }
  } else if (!file) {
    if (!loadAppModel(ctx)?.pages.some((p) => p.route === input.page)) {
      throw new ScenarioInputError(`Unknown page ${input.page}. Run \`ai-qa-agent analyze\` to find pages.`);
    }
    // An empty input hash makes the next `ai-qa-agent scenarios` fill in the AI's scenarios too.
    file = {
      page: input.page,
      generatedAt: new Date().toISOString(),
      inputHash: '',
      scenarios: [],
      removed: [],
    };
  }

  const feature = (input.feature ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const scenario = ScenarioSchema.parse({
    id: existing?.id ?? nextScenarioId(input.page, file),
    page: input.page,
    feature: feature || existing?.feature || pageSlug(input.page),
    category: input.category,
    priority: input.priority,
    title,
    preconditions: lines(input.preconditions),
    steps,
    expectedResults,
    viewport: input.viewport,
    source: existing?.source ?? { figma: false, code: false },
    testData: lines(input.testData),
    design: existing?.design ?? null,
    rationale: (input.rationale ?? '').trim(),
    approved: true,
    origin: 'person',
    editedAt: new Date().toISOString(),
    // Editing a critical flow keeps it in the smoke tests.
    critical: existing?.critical,
  } satisfies Scenario);

  const data = file!;
  data.scenarios = existing
    ? data.scenarios.map((s) => (s.id === scenario.id ? scenario : s))
    : [...data.scenarios, scenario].sort((a, b) => a.id.localeCompare(b.id));
  writeJson(path, data);
  log.info(`${existing ? 'Edited' : 'Added'} ${scenario.id} on ${data.page}`);
  return scenario;
}

/** What the AI returns for a draft: the form fields plus what it could not confirm in the app. */
const AiDraftSchema = ScenarioDraftSchema.extend({
  concerns: z
    .array(z.string())
    .describe(
      'Anything in the request you could not match to the app (a control, text or feature that does not exist, an ambiguous wording). Empty when the request is clear.',
    ),
});

/** Turn a one-line description into a filled-in form for a person to review. Saves nothing. */
export async function draftScenario(
  ctx: QaContext,
  req: { page: string; description: string },
): Promise<ScenarioDraft & { page: string; concerns: string[] }> {
  const description = req.description.trim();
  if (!description) throw new ScenarioInputError('Describe what the scenario should check.');
  const app = loadAppModel(ctx);
  const page = app?.pages.find((p) => p.route === req.page);
  if (!app || !page) {
    throw new ScenarioInputError(`Unknown page ${req.page}. Run \`ai-qa-agent analyze\` first.`);
  }
  const existing = readJson(scenarioFilePath(ctx, page.route), ScenarioFileSchema)?.scenarios ?? [];
  const otherPages = app.pages
    .filter((p) => p.route !== page.route)
    .map((p) => ({ route: p.route, name: p.name, purpose: p.purpose, preconditions: p.preconditions }));
  const res = await ctx.ai.run({
    name: `draft-scenario-${pageSlug(page.route)}`,
    cwd: ctx.root,
    system: systemPrompt('scenario-designer'),
    prompt: `## Task
A person wants to add one end-to-end test scenario for the page ${page.route} ("${page.name}").
Their description: ${JSON.stringify(description)}

Turn it into one concrete scenario that they will review before saving. Stay faithful to what they asked for: do not add unrelated checks, and do not change what they want to verify.

## Page model (from the application analysis)
${JSON.stringify(page, null, 2)}

## Journeys through this page
${JSON.stringify(flowsThrough(app, page.route), null, 2)}

## Other pages (for steps that start or continue elsewhere)
${JSON.stringify(otherPages)}

## Test data found in code
${JSON.stringify(app.testData)}

## Viewports available
${JSON.stringify(ctx.config.viewports)}

## Scenarios that already exist on this page (do not duplicate them)
${existing.map((s) => `- ${s.id}: ${s.title}`).join('\n') || '(none)'}

## Procedure
1. Find in the page model the controls, texts and rules the description refers to. Read the source file when the model does not settle it.
2. Write the steps and expected results following the rules below.
3. List in "concerns" whatever in the description you could not match to the app, and what you assumed instead. If the request duplicates an existing scenario, say which one.

## Rules
${STEP_RULES.split('\n').slice(0, 3).join('\n')}
${EXPECTATION_RULES}
- priority, by this scale:
${PRIORITY_RUBRIC}
- feature: kebab-case key, e.g. checkout, auth, navigation. viewport: one of the names above.
- "rationale" names the functionality the scenario protects and what users lose if it breaks.${projectRules(ctx)}`,
    schema: AiDraftSchema,
    tools: ['Read', 'Glob', 'Grep'],
  });
  return { ...res.output, concerns: res.output.concerns ?? [], page: page.route };
}

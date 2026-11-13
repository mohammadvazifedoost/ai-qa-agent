import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_SYSTEM, projectRules } from '../ai/context.js';
import { loadAppModel, type PageModel } from '../analyze/app.js';
import { readJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { rel } from '../core/paths.js';
import type { QaContext } from '../pipeline/context.js';
import { ensureApp } from '../runner/server.js';
import { normalizeId, playwrightValidator, type SpecValidator } from '../scenarios/manage.js';
import { loadAllScenarios, scenarioFilePath, selectPages } from '../scenarios/generate.js';
import {
  isCriticalScenario,
  isPersonScenario,
  ScenarioFileSchema,
  type Scenario,
} from '../scenarios/schema.js';
import { listTestIds, upsertTestBlock } from '../scenarios/spec-edit.js';
import {
  BROWSER_TOOLS,
  designSummary,
  generateTests,
  HELPER_API,
  recordScenarioTests,
  scenarioTestHash,
  specHash,
  specKey,
  specPath,
  testRules,
} from './playwright.js';

const log = logger('generate');

/** `missing`: the spec has no test for it. `outdated`: the scenario changed after its test was written. */
export type ScenarioTestState = 'missing' | 'outdated';

function approvedOn(ctx: QaContext, route: string): Scenario[] {
  return (readJson(scenarioFilePath(ctx, route), ScenarioFileSchema)?.scenarios ?? []).filter(
    (s) => s.approved,
  );
}

function pageStates(ctx: QaContext, page: PageModel): Record<string, ScenarioTestState> {
  const scenarios = approvedOn(ctx, page.route);
  const spec = specPath(ctx, page.route);
  const out: Record<string, ScenarioTestState> = {};
  if (!fs.existsSync(spec)) {
    for (const s of scenarios) out[s.id] = 'missing';
    return out;
  }
  const ids = new Set(listTestIds(fs.readFileSync(spec, 'utf8')));
  const specFresh = ctx.state.data.generatedSpecs[specKey(ctx, spec)] === specHash(ctx, page, scenarios);
  for (const s of scenarios) {
    const recorded = ctx.state.data.scenarioTests[s.id];
    if (!ids.has(s.id)) out[s.id] = 'missing';
    else if (recorded !== undefined ? recorded !== scenarioTestHash(s) : !specFresh && isPersonScenario(s)) {
      // Without a fingerprint (tests written before they were recorded) only a person's edit is a
      // known change; the spec cache tells whether anything changed at all.
      out[s.id] = 'outdated';
    }
  }
  return out;
}

/** Approved scenarios whose test is missing or older than the scenario. Up-to-date ones are left out. */
export function scenarioTestStates(ctx: QaContext): Record<string, ScenarioTestState> {
  const app = loadAppModel(ctx);
  return Object.assign({}, ...(app?.pages ?? []).map((p) => pageStates(ctx, p)));
}

const SingleTestSchema = z.object({
  code: z.string().min(20).describe('Only the one test(...) statement, no imports or helpers'),
  notes: z.array(z.string()),
});

function buildPrompt(
  ctx: QaContext,
  page: PageModel,
  scenario: Scenario,
  file: string,
  current: string,
): string {
  return `Write the Playwright test for one scenario on ${page.route}. It goes into the existing file ${rel(ctx.root, file)}; the app runs at ${ctx.config.app.baseUrl} (baseURL is configured; use relative URLs).

## Scenario
${JSON.stringify(scenario, null, 2)}

## The current test file (for its imports and helpers; it is not yours to change)
\`\`\`ts
${current}
\`\`\`

## Page model (from source analysis)
${JSON.stringify(page, null, 2)}

## Figma screens for this route
${JSON.stringify(designSummary(ctx, page.route))}

## Helper API
${HELPER_API}

## Rules
- Return ONLY one statement: test('${scenario.id}: <title>', { tag: [...] }, async ({ page, qa }) => { ... }). No imports, no helpers outside it, no other tests. It replaces the existing test for ${scenario.id} if there is one, or is added after the last test.
- You may call helpers and use imports that already exist in the file. Anything else you need goes inside the test body.
${testRules(ctx)}${projectRules(ctx)}`;
}

export interface WrittenTest {
  id: string;
  page: string;
  file: string;
  /** `generated`: the page had no spec yet, so the whole file was generated. */
  action: 'replaced' | 'added' | 'generated';
}

/**
 * Write (or rewrite) the test of one scenario and splice it into the page's spec, leaving every
 * other test untouched. The result is checked with Playwright; on failure the original file is kept.
 */
export async function writeScenarioTest(
  ctx: QaContext,
  rawId: string,
  opts: { validate?: SpecValidator; startApp?: boolean } = {},
): Promise<WrittenTest> {
  const id = normalizeId(rawId);
  const scenario = loadAllScenarios(ctx).find((s) => s.id === id);
  if (!scenario) throw new Error(`Unknown scenario ${id}.`);
  if (!scenario.approved) throw new Error(`${id} is not approved; approve it before writing its test.`);
  const page = loadAppModel(ctx)?.pages.find((p) => p.route === scenario.page);
  if (!page)
    throw new Error(`Page ${scenario.page} is not in .qa/app-model.json; run \`ai-qa-agent analyze\`.`);
  const file = specPath(ctx, page.route);
  if (!fs.existsSync(file)) {
    await generateTests(ctx, { page: page.route, force: true });
    return { id, page: page.route, file: rel(ctx.root, file), action: 'generated' };
  }

  const validate = opts.validate ?? playwrightValidator;
  const original = fs.readFileSync(file, 'utf8');
  const expected = [...new Set([...listTestIds(original), id])];
  // The AI may open the running app to confirm accessible names.
  const server =
    opts.startApp === false
      ? undefined
      : await ensureApp(ctx.root, ctx.config, path.join(ctx.paths.logsDir, 'app-server.log'));
  let action: 'replaced' | 'added' = 'added';
  let problems: string[] = [];
  try {
    let prompt = buildPrompt(ctx, page, scenario, file, original);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await ctx.ai.run({
        name: `test-${id.toLowerCase()}${attempt > 1 ? `-fix${attempt - 1}` : ''}`,
        cwd: ctx.root,
        system: BASE_SYSTEM,
        prompt,
        schema: SingleTestSchema,
        tools: ['Read', 'Glob', 'Grep'],
        mcpServers: ctx.config.ai.mcpServers.playwright
          ? { playwright: ctx.config.ai.mcpServers.playwright }
          : {},
        mcpTools: ctx.config.ai.mcpServers.playwright ? BROWSER_TOOLS : [],
      });
      try {
        const up = upsertTestBlock(original, id, res.output.code);
        action = up.action;
        fs.writeFileSync(file, up.code);
        problems = await validate(ctx, file, expected);
      } catch (err) {
        problems = [(err as Error).message];
      }
      if (problems.length === 0) break;
      fs.writeFileSync(file, original);
      log.warn(
        `Test for ${id}, attempt ${attempt}: ${problems.length} problem(s); asking the AI to fix them`,
      );
      prompt =
        `Your test for ${id} had problems. Fix them and return the corrected test statement only.\n\nYour code:\n\`\`\`ts\n${res.output.code}\n\`\`\`\n\nProblems:\n${problems.map((p) => `- ${p}`).join('\n')}\n\n` +
        `Original task, for reference:\n${buildPrompt(ctx, page, scenario, file, original)}`;
    }
  } finally {
    server?.stop();
  }
  if (problems.length) {
    fs.writeFileSync(file, original);
    throw new Error(
      `Could not write a valid test for ${id}; the spec was left unchanged.\n${problems.join('\n')}`,
    );
  }

  recordScenarioTests(ctx, [scenario]);
  // When every test on the page is now in sync, mark the spec current so `generate` keeps it.
  if (Object.keys(pageStates(ctx, page)).length === 0) {
    ctx.state.data.generatedSpecs[specKey(ctx, file)] = specHash(ctx, page, approvedOn(ctx, page.route));
  }
  ctx.state.save();
  log.info(`${action === 'added' ? 'Added' : 'Rewrote'} the test for ${id} in ${rel(ctx.root, file)}`);
  return { id, page: page.route, file: rel(ctx.root, file), action };
}

/**
 * Write the tests of the approved critical flows only (`generate --critical`). A page without a spec
 * gets one holding just its critical tests (a later full `generate` adds the rest); on a page with a
 * spec, each missing or outdated critical test is spliced in, leaving the other tests untouched.
 * Returns the absolute paths of the spec files written.
 */
export async function generateCriticalTests(
  ctx: QaContext,
  scope: { page?: string; force?: boolean } = {},
): Promise<string[]> {
  const app = loadAppModel(ctx);
  if (!app) throw new Error('No .qa/app-model.json. Run `ai-qa-agent analyze` first.');
  const pages = selectPages(app.pages, scope.page).filter((p) =>
    approvedOn(ctx, p.route).some(isCriticalScenario),
  );
  if (pages.length === 0) {
    log.warn('No approved critical flows; run `ai-qa-agent scenarios --critical`');
    return [];
  }
  const fresh = pages.filter((p) => !fs.existsSync(specPath(ctx, p.route)));
  const written = fresh.length
    ? await generateTests(ctx, { pages: fresh.map((p) => p.route), force: true, only: isCriticalScenario })
    : [];

  const states = scenarioTestStates(ctx);
  const todo = pages
    .filter((p) => !fresh.includes(p))
    .flatMap((p) => approvedOn(ctx, p.route).filter(isCriticalScenario))
    .filter((s) => scope.force || states[s.id]);
  if (todo.length === 0) {
    if (written.length === 0) log.info('Critical flow tests are up to date');
    return written;
  }
  // Start the app once for every test instead of once per test.
  const server = await ensureApp(ctx.root, ctx.config, path.join(ctx.paths.logsDir, 'app-server.log'));
  try {
    for (const s of todo) {
      const res = await writeScenarioTest(ctx, s.id, { startApp: false });
      written.push(path.resolve(ctx.root, res.file));
    }
  } finally {
    server.stop();
  }
  return [...new Set(written)];
}

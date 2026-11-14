import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { projectRules, systemPrompt } from '../ai/context.js';
import { loadAppModel, type AppModelFile, type PageModel } from '../analyze/app.js';
import { ensureDir, readJson, sha256 } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { rel } from '../core/paths.js';
import { run } from '../core/process.js';
import type { QaContext } from '../pipeline/context.js';
import { playwrightCli, writePlaywrightConfig } from '../runner/playwright-config.js';
import { fileFilterArg, playwrightEnv } from '../runner/run.js';
import { stripAnsi } from '../runner/results.js';
import { ensureApp } from '../runner/server.js';
import { pageSlug, scenarioFilePath, selectPages } from '../scenarios/generate.js';
import { ScenarioFileSchema, scenarioRoutes, type Scenario } from '../scenarios/schema.js';

const log = logger('generate');

/** Browser tools the generator may use to verify selectors on the running app (no arbitrary code execution). */
export const BROWSER_TOOLS = [
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_find',
  'mcp__playwright__browser_click',
  'mcp__playwright__browser_type',
  'mcp__playwright__browser_fill_form',
  'mcp__playwright__browser_press_key',
  'mcp__playwright__browser_resize',
  'mcp__playwright__browser_wait_for',
  'mcp__playwright__browser_navigate_back',
  'mcp__playwright__browser_close',
];

export const HELPER_API = `
Import ONLY from the helper package (it re-exports Playwright's test/expect with QA fixtures):
  import { test, expect, type Page, type Locator } from '@mohammadvazifedoost/ai-qa-agent/playwright';
Never import from '@playwright/test' directly (not even types).

Fixtures available in every test: { page, qa } (plus all standard Playwright fixtures).
Console errors, page errors and failed network requests are captured automatically.

qa.expectDesignTokens(locator, { cssProperty: expectedValue, ... }, label?)
  Deterministically compares computed CSS (and width/height from the bounding box) with Figma values.
  Values: colors as hex ('#2563EB'), lengths in px ('8px'), fontWeight as number string ('600'),
  fontFamily as the family name ('Inter'; compared against the first family in the CSS stack).
  Use camelCase property names (backgroundColor, borderRadius, fontSize, lineHeight, height, paddingLeft...).

await qa.compareWithDesign(screenName, locator?)
  Pixel-compares the full page (or an element) with the Figma reference image for that screen and fails
  on a mismatch beyond the configured tolerance. Only use it for screens listed with hasReferenceImage=true.
  Set the page to the same state the design shows before calling it.

await qa.expectNoHorizontalOverflow()
  Fails if the document scrolls horizontally and reports which elements stick out.

await qa.expectAccessible({ include?: Locator, disableRules?: string[], label?: string })
  Runs axe-core against WCAG 2.1 A/AA on the page (or only \`include\`). Fails on serious or critical
  violations and attaches every violation to the report. Reach the state to check before calling it.
`;

export function specPath(ctx: QaContext, route: string): string {
  return path.join(ctx.paths.testsDir, `${pageSlug(route)}.spec.ts`);
}

export function designSummary(ctx: QaContext, route: string): unknown {
  if (!fs.existsSync(ctx.paths.designSystem)) return null;
  const ds = JSON.parse(fs.readFileSync(ctx.paths.designSystem, 'utf8')) as {
    screens: Array<{ name: string; route: string | null; viewport: string }>;
    references: Array<{ screen: string }>;
  };
  const refs = new Set(ds.references.map((r) => r.screen));
  return ds.screens
    .filter((s) => s.route === route)
    .map((s) => ({ name: s.name, viewport: s.viewport, hasReferenceImage: refs.has(s.name) }));
}

/**
 * The models of the other pages a set of scenarios visits (a journey that starts on / and ends on
 * /checkout needs both), without the fields a test author has no use for.
 */
export function relatedPages(
  app: Pick<AppModelFile, 'pages'> | undefined,
  page: Pick<PageModel, 'route'>,
  scenarios: ReadonlyArray<Pick<Scenario, 'page' | 'routes'>>,
): Array<Omit<PageModel, 'files' | 'responsiveBehavior'>> {
  const routes = new Set(scenarios.flatMap(scenarioRoutes).filter((r) => r !== page.route));
  return (app?.pages ?? [])
    .filter((p) => routes.has(p.route))
    .map(({ files: _f, responsiveBehavior: _r, ...rest }) => rest);
}

/** Prompt section with the models of the other pages the scenarios visit; empty when there are none. */
export function relatedPagesSection(related: readonly unknown[]): string {
  if (related.length === 0) return '';
  return `## Models of the other pages these scenarios visit
${JSON.stringify(related, null, 2)}

`;
}

/** How every generated test must be written; shared by whole-file and single-test generation. */
export function testRules(ctx: QaContext): string {
  const viewports = Object.keys(ctx.config.viewports);
  return `Tags
- Tag every test: { tag: ['@<category>', '@<feature>', '@<viewport>', '@<priority>'] } where viewport is one of ${viewports.map((v) => `@${v}`).join(', ')} — the tag selects the browser viewport the test runs in. Use the scenario's own values. When the scenario has "critical": true, also add '@critical' (a smoke test of a core journey).

Assertions
- Encode every expected result as an assertion on what the user gets after the action: a text, a value, a URL, a count, a state. "The element is visible" is not enough when the expected result names a value.
- Expected results describe CORRECT behaviour; never weaken or drop one so that the test passes against what the code currently does. A failing test is how bugs are found.
- When an expected result has no exact text (the behaviour is not implemented in the app yet), assert the generic outcome it describes through roles (e.g. a status, alert or heading appears; the list is empty). Never invent copy, URLs or selectors, and add a short comment saying the behaviour was not found in the app.
- Give an assertion on a business value a message that names it: expect(total, 'Total after SAVE10 on $18.00').toHaveText('$16.20').

Locators
- Order of preference: (1) getByRole with the exact accessible name ({ name: '…', exact: true }); (2) getByTestId when the page model or the DOM shows a data-testid; (3) getByLabel / getByPlaceholder / getByAltText; (4) getByText with the exact text, scoped inside a container found by role; (5) a stable application attribute via locator('[data-…]').
- Never use: generated or hashed class names, generated ids, XPath, selectors that follow the DOM structure (div > div:nth-child(2)), or .first() / .nth() / .last() to choose among matches that a more precise locator would tell apart.
- Every locator must match exactly one element. When a name occurs more than once on the page (several 'Remove' buttons, a link in the header and in the footer), find the container first (the list item by its text, the navigation or region by its name) and search inside it.
- Confirm before you rely on it: with browser tools available, open the running app, reach the state, and check the role and accessible name of each control in the snapshot. For names and roles the running app is right when it differs from the page model; report the difference in "notes". The browser never decides what an expected result should be.

Waiting
- No page.waitForTimeout, no setTimeout sleeps, no waitForLoadState('networkidle'), no polling loops. Web-first assertions (toBeVisible, toHaveText, toHaveURL, toHaveCount, toBeEnabled…) wait on their own.
- After an action that loads data or navigates, first assert the state that shows it finished (the new heading, the URL, the loading indicator gone), then assert the details. To observe a transient loading state, assert it right after the action that triggers it.

No hidden failures
- No try/catch around actions or assertions, no "if (await x.isVisible())" branches, no { force: true }, no test.skip / test.fixme / test.only, no retry loops, no serial mode. A step that cannot be performed is a failure and must fail the test.

Independence
- Every test starts from a fresh page and builds the state it needs through the UI (e.g. add products on / before visiting /checkout). State kept in memory is lost on page.goto, so move between pages through links and buttons when state must survive.
- No state shared between tests and no dependence on their order. Use the scenario's test data literally; only a value that must be unique per run (e.g. a sign-up email) gets a unique suffix.

Structure
- Wrap each scenario step in test.step() using the step's wording, so a failure shows where the journey stopped. Keep helpers local to the file.
- Visual scenarios: use qa.expectDesignTokens with the scenario's design.tokens, and qa.compareWithDesign only when design.screen is set and has a reference image. Call qa.compareWithDesign FIRST (right after reaching the designed state), then token checks; use expect.soft for any extra custom visual assertions so every design check runs and is reported.
- Responsive scenarios: use qa.expectNoHorizontalOverflow() where overflow matters, and assert visibility of responsive elements.
- Accessibility scenarios: reach the state each step describes (e.g. submit an empty form, open the menu), then call await qa.expectAccessible() for it; scope with { include: locator } when the scenario is about one region. Add plain assertions for anything the expected results name that axe does not check.
- Never modify application code.`;
}

/** Remove comments, so that a rule is not triggered by a word in a comment. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const LINT_RULES: Array<[RegExp, string]> = [
  [/\bwaitForTimeout\s*\(/, 'Uses page.waitForTimeout; replace with web-first assertions.'],
  [/\bsetTimeout\s*\(/, 'Sleeps with setTimeout; wait for an application state with a web-first assertion.'],
  [
    /['"`]networkidle['"`]/,
    "Waits for 'networkidle'; assert the state that shows the page is ready instead.",
  ],
  [
    /\bforce\s*:\s*true\b/,
    'Uses { force: true }, which acts on elements a user cannot use; fix the locator or the state.',
  ],
  [
    /\btest(?:\.describe)?\.(?:only|skip|fixme)\b/,
    'Uses test.only / test.skip / test.fixme; every scenario must run.',
  ],
  [
    /\.describe\.serial\b|mode\s*:\s*['"`]serial['"`]/,
    'Runs tests in serial mode; every test must be independent.',
  ],
  [
    /from\s+['"]@playwright\/test['"]/,
    "Imports from '@playwright/test'; import only from the helper package.",
  ],
  [
    /['"`]xpath=|locator\(\s*['"`]\/\//,
    'Uses an XPath selector; use a role, test id, label or text locator.',
  ],
];

/**
 * Deterministic reliability checks on generated test code: the patterns that make tests flaky or
 * hide real failures. Returns problems (empty = OK) that are sent back to the test author.
 */
export function lintSpec(code: string): string[] {
  const clean = withoutComments(code);
  return LINT_RULES.filter(([re]) => re.test(clean)).map(([, problem]) => problem);
}

function buildPrompt(
  ctx: QaContext,
  app: AppModelFile,
  page: PageModel,
  scenarios: Scenario[],
  file: string,
  appUrl: string,
): string {
  return `## Task
Write a Playwright test file (TypeScript) that implements the approved test scenarios below for ${page.route}, one test per scenario.
The file will be saved as ${rel(ctx.root, file)}. The app (production build) runs at ${appUrl}; baseURL is configured, so use relative URLs like page.goto('${page.route}').

## Scenarios
${JSON.stringify(scenarios, null, 2)}

## Page model (from the application analysis)
${JSON.stringify(page, null, 2)}

${relatedPagesSection(relatedPages(app, page, scenarios))}## Figma screens for this route
${JSON.stringify(designSummary(ctx, page.route))}

## Helper API
${HELPER_API}

## Procedure
1. Read every scenario. From the page models, list the controls each one uses and how the state it needs is built.
2. Decide the locator of every control by the locator rules, and confirm role and accessible name in the running app when browser tools are available.
3. Write shared local helpers for steps several scenarios repeat (e.g. adding a product), then one test per scenario.
4. Before answering, check each test against its scenario: every step is performed, every expected result has an assertion, and nothing in the rules below is violated.

## Rules
- One test per scenario. Title MUST start with the scenario id: test('${scenarios[0]?.id ?? 'PAGE-001'}: <title>', ...).
${testRules(ctx)}
- Return the complete file content in "code", the scenario ids implemented in "coveredScenarioIds", and in "notes" anything a reviewer must know (a control the app names differently from the model, an expected result you could only assert generically).${projectRules(ctx)}`;
}

const GeneratedSchema = z.object({
  code: z.string().min(50),
  coveredScenarioIds: z.array(z.string()),
  notes: z.array(z.string()),
});

/**
 * Compile/list the spec with Playwright and check that every scenario has its test; returns problems
 * (empty = OK). Reliability rules are checked on newly written code with {@link lintSpec}.
 */
export async function validateSpec(
  ctx: QaContext,
  file: string,
  scenarios: ReadonlyArray<Pick<Scenario, 'id'>>,
): Promise<string[]> {
  const args = [
    playwrightCli(),
    'test',
    '--config',
    ctx.paths.playwrightConfig,
    '--list',
    fileFilterArg(ctx.paths.testsDir, file),
  ];
  const proc = await run(process.execPath, args, {
    cwd: ctx.paths.qaDir,
    env: playwrightEnv(ctx),
  });
  const out = stripAnsi(proc.stdout + '\n' + proc.stderr);
  const problems: string[] = [];
  if (proc.code !== 0) problems.push(`Playwright could not load the file:\n${out.slice(0, 4000)}`);
  else {
    for (const s of scenarios) {
      if (!out.includes(`${s.id}:`))
        problems.push(
          `Scenario ${s.id} is not implemented as a test (or its title does not start with "${s.id}:").`,
        );
    }
  }
  return problems;
}

/** Cache key of a spec in `state.generatedSpecs`: the approved scenarios it implements + page model + design. */
export function specHash(
  ctx: QaContext,
  page: PageModel,
  approved: Scenario[],
  app: Pick<AppModelFile, 'pages'> | undefined = loadAppModel(ctx),
): string {
  const related = relatedPages(app, page, approved);
  return sha256(
    JSON.stringify({
      scenarios: approved,
      page,
      design: designSummary(ctx, page.route),
      // Only present for scenarios that cross pages, so other specs keep their hash.
      ...(related.length ? { related } : {}),
    }),
  );
}

export function specKey(ctx: QaContext, file: string): string {
  return rel(ctx.paths.qaDir, file);
}

export interface GenerateScope {
  page?: string;
  /** Limit to these routes (used by `run --changed`). */
  pages?: string[];
  force?: boolean;
  /** Only write tests for these scenarios (e.g. the critical flows on a page without a spec yet). */
  only?: (s: Scenario) => boolean;
}

/** Per page: its approved scenarios and whether its spec is up to date with them. */
function specTasks(
  ctx: QaContext,
  app: AppModelFile,
  pages: PageModel[],
  only: (s: Scenario) => boolean = () => true,
) {
  return pages.map((page) => {
    const scenarios = (
      readJson(scenarioFilePath(ctx, page.route), ScenarioFileSchema)?.scenarios ?? []
    ).filter((s) => s.approved && only(s));
    const file = specPath(ctx, page.route);
    const hash = specHash(ctx, page, scenarios, app);
    const key = specKey(ctx, file);
    const fresh = fs.existsSync(file) && ctx.state.data.generatedSpecs[key] === hash;
    return { page, scenarios, file, hash, key, fresh };
  });
}

/**
 * Fingerprint of everything in a scenario that its test encodes (not who wrote it or why), stored in
 * `state.scenarioTests` when its test is written so an edit shows the test is out of date.
 */
export function scenarioTestHash(s: Scenario): string {
  const { approved: _a, origin: _o, editedAt: _e, rationale: _r, ...tested } = s;
  return sha256(JSON.stringify(tested));
}

export function recordScenarioTests(ctx: QaContext, scenarios: readonly Scenario[]): void {
  for (const s of scenarios) ctx.state.data.scenarioTests[s.id] = scenarioTestHash(s);
}

export async function generateTests(ctx: QaContext, scope: GenerateScope = {}): Promise<string[]> {
  const app = loadAppModel(ctx);
  if (!app) throw new Error('No .qa/app-model.json. Run `ai-qa-agent analyze` first.');
  ensureDir(ctx.paths.testsDir);
  writePlaywrightConfig(ctx.paths, ctx.config);
  const written: string[] = [];
  const pages = selectPages(app.pages, scope.page).filter(
    (p) => !scope.pages || scope.pages.includes(p.route),
  );
  const todo = specTasks(ctx, app, pages, scope.only).filter((t) => {
    if (t.scenarios.length === 0)
      log.warn(`No approved scenarios for ${t.page.route}; run \`ai-qa-agent scenarios\``);
    else if (t.fresh && !scope.force) log.info(`${t.key} is up to date`);
    return t.scenarios.length > 0 && (!t.fresh || scope.force);
  });
  if (todo.length === 0) return written;

  // The test author opens the live app to confirm locators, so make sure it is running.
  const server = await ensureApp(ctx.root, ctx.config, path.join(ctx.paths.logsDir, 'app-server.log'));
  try {
    for (const t of todo) {
      const task = buildPrompt(ctx, app, t.page, t.scenarios, t.file, server.url);
      let prompt = task;
      let problems: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await ctx.ai.run({
          name: `generate-${pageSlug(t.page.route)}${attempt > 1 ? `-fix${attempt - 1}` : ''}`,
          cwd: ctx.root,
          system: systemPrompt('test-author'),
          prompt,
          schema: GeneratedSchema,
          tools: ['Read', 'Glob', 'Grep'],
          mcpServers: ctx.config.ai.mcpServers.playwright
            ? { playwright: ctx.config.ai.mcpServers.playwright }
            : {},
          mcpTools: ctx.config.ai.mcpServers.playwright ? BROWSER_TOOLS : [],
        });
        const header = `// Generated by AI QA Agent from .qa/scenarios/${pageSlug(t.page.route)}.json — regenerated when scenarios change.\n`;
        fs.writeFileSync(
          t.file,
          header + res.output.code.replace(/^\/\/ Generated by (?:ai-qa-agent|AI QA Agent).*\n/, ''),
        );
        problems = [...(await validateSpec(ctx, t.file, t.scenarios)), ...lintSpec(res.output.code)];
        if (problems.length === 0) break;
        log.warn(`${t.key} attempt ${attempt} has ${problems.length} problem(s); asking the AI to fix them`);
        prompt =
          `The test file you wrote (${rel(ctx.root, t.file)}) has problems. Read it, fix them, and return the complete corrected file.\n\nProblems:\n${problems.map((p) => `- ${p}`).join('\n')}\n\n` +
          `Original task, for reference:\n${task}`;
      }
      if (problems.length) {
        throw new Error(`Could not generate a valid ${t.key}:\n${problems.join('\n')}`);
      }
      ctx.state.data.generatedSpecs[t.key] = t.hash;
      recordScenarioTests(ctx, t.scenarios);
      ctx.state.save();
      written.push(t.file);
      log.info(`Generated ${t.key} (${t.scenarios.length} scenarios)`);
    }
  } finally {
    server.stop();
  }
  ctx.state.markStage('generate');
  return written;
}

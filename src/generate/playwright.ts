import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_SYSTEM, projectRules } from '../ai/context.js';
import { loadAppModel, type PageModel } from '../analyze/app.js';
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
import { ScenarioFileSchema, type Scenario } from '../scenarios/schema.js';

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
  import { test, expect, type Page, type Locator } from '@company/ai-qa-agent/playwright';
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

/** How every generated test must be written; shared by whole-file and single-test generation. */
export function testRules(ctx: QaContext): string {
  const viewports = Object.keys(ctx.config.viewports);
  return `- Tag every test: { tag: ['@<category>', '@<feature>', '@<viewport>', '@<priority>'] } where viewport is one of ${viewports.map((v) => `@${v}`).join(', ')} — the tag selects the browser viewport the test runs in. Use the scenario's own values.
- Encode the scenario's expectedResults as assertions. They describe CORRECT behaviour; never weaken them to match what the code currently does. A failing test is how bugs are found.
- Locators: prefer getByRole / getByLabel / getByText with exact accessible names; use getByTestId only where the page model lists a data-testid. No CSS/XPath selectors unless nothing else identifies the element.
- No page.waitForTimeout / arbitrary sleeps. Rely on auto-waiting assertions (toBeVisible, toHaveText, toHaveURL...). To observe a transient loading state, assert it right after the action that triggers it.
- Build preconditions through the UI (e.g. add products on / before visiting /checkout; the cart is in-memory, so navigate client-side via links instead of page.goto when state must survive).
- Use test.step() for each scenario step so the report shows progress. Keep helpers local to the file.
- Visual scenarios: use qa.expectDesignTokens with the scenario's design.tokens, and qa.compareWithDesign only when design.screen is set and has a reference image. Call qa.compareWithDesign FIRST (right after reaching the designed state), then token checks; use expect.soft for any extra custom visual assertions so every design check runs and is reported.
- Responsive scenarios: use qa.expectNoHorizontalOverflow() where overflow matters, and assert visibility of responsive elements.
- Accessibility scenarios: reach the state each step describes (e.g. submit an empty form, open the menu), then call await qa.expectAccessible() for it; scope with { include: locator } when the scenario is about one region. Add plain assertions for anything the expected results name that axe does not check.
- Never modify application code. You may use the browser tools to open the running app and confirm accessible names before writing locators.`;
}

function buildPrompt(ctx: QaContext, page: PageModel, scenarios: Scenario[], file: string): string {
  return `Write a Playwright test file (TypeScript) that implements these approved test scenarios for ${page.route}.
The file will be saved as ${rel(ctx.root, file)}. The app runs at ${ctx.config.app.baseUrl} (baseURL is configured; use relative URLs like page.goto('${page.route}')).

## Scenarios
${JSON.stringify(scenarios, null, 2)}

## Page model (from source analysis)
${JSON.stringify(page, null, 2)}

## Figma screens for this route
${JSON.stringify(designSummary(ctx, page.route))}

## Helper API
${HELPER_API}

## Rules
- One test per scenario. Title MUST start with the scenario id: test('CHECKOUT-002: <title>', ...).
${testRules(ctx)}
- Return the complete file content in "code", and the scenario ids implemented in "coveredScenarioIds".${projectRules(ctx)}`;
}

const GeneratedSchema = z.object({
  code: z.string().min(50),
  coveredScenarioIds: z.array(z.string()),
  notes: z.array(z.string()),
});

/** Compile/list the spec with Playwright; returns problems (empty = OK). */
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
    if (/\bwaitForTimeout\(/.test(fs.readFileSync(file, 'utf8')))
      problems.push('Uses page.waitForTimeout; replace with web-first assertions.');
  }
  return problems;
}

/** Cache key of a spec in `state.generatedSpecs`: the approved scenarios it implements + page model + design. */
export function specHash(ctx: QaContext, page: PageModel, approved: Scenario[]): string {
  return sha256(JSON.stringify({ scenarios: approved, page, design: designSummary(ctx, page.route) }));
}

export function specKey(ctx: QaContext, file: string): string {
  return rel(ctx.paths.qaDir, file);
}

export interface GenerateScope {
  page?: string;
  /** Limit to these routes (used by `run --changed`). */
  pages?: string[];
  force?: boolean;
}

/** Per page: its approved scenarios and whether its spec is up to date with them. */
function specTasks(ctx: QaContext, pages: PageModel[]) {
  return pages.map((page) => {
    const scenarios = (
      readJson(scenarioFilePath(ctx, page.route), ScenarioFileSchema)?.scenarios ?? []
    ).filter((s) => s.approved);
    const file = specPath(ctx, page.route);
    const hash = specHash(ctx, page, scenarios);
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
  const todo = specTasks(ctx, pages).filter((t) => {
    if (t.scenarios.length === 0)
      log.warn(`No approved scenarios for ${t.page.route}; run \`ai-qa-agent scenarios\``);
    else if (t.fresh && !scope.force) log.info(`${t.key} is up to date`);
    return t.scenarios.length > 0 && (!t.fresh || scope.force);
  });
  if (todo.length === 0) return written;

  // The generator explores the live app to confirm locators, so make sure it is running.
  const server = await ensureApp(ctx.root, ctx.config, path.join(ctx.paths.logsDir, 'app-server.log'));
  try {
    for (const t of todo) {
      let prompt = buildPrompt(ctx, t.page, t.scenarios, t.file);
      let problems: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await ctx.ai.run({
          name: `generate-${pageSlug(t.page.route)}${attempt > 1 ? `-fix${attempt - 1}` : ''}`,
          cwd: ctx.root,
          system: BASE_SYSTEM,
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
        problems = await validateSpec(ctx, t.file, t.scenarios);
        if (problems.length === 0) break;
        log.warn(`${t.key} attempt ${attempt} has ${problems.length} problem(s); asking the AI to fix them`);
        prompt =
          `The test file you wrote (${rel(ctx.root, t.file)}) has problems. Read it, fix them, and return the complete corrected file.\n\nProblems:\n${problems.map((p) => `- ${p}`).join('\n')}\n\n` +
          `Original task, for reference:\n${buildPrompt(ctx, t.page, t.scenarios, t.file)}`;
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

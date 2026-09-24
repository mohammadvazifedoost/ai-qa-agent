import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_SYSTEM, projectInfoJson, projectRules } from '../ai/context.js';
import { hashFiles, listFiles, readJson, sha256, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import type { QaContext } from '../pipeline/context.js';

const log = logger('analyze');

const FieldSchema = z.object({
  label: z.string().describe('Accessible label as rendered'),
  type: z.string(),
  validation: z.array(z.string()).describe('Validation rules with exact messages, as implemented'),
});

export const PageModelSchema = z.object({
  route: z.string(),
  name: z.string(),
  purpose: z.string(),
  /** Source files (relative to project root) that implement this page, including shared layout/components. */
  files: z.array(z.string()),
  headings: z.array(z.string()).describe('Visible headings/titles as rendered text'),
  interactiveElements: z
    .array(z.string())
    .describe('Buttons/links/inputs with their accessible names, e.g. "button \'Add Ceramic Mug to cart\'"'),
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
  dataDependencies: z.array(z.string()).describe('API calls / stores / contexts the page depends on'),
  preconditions: z
    .array(z.string())
    .describe('What must be true before the page is usable, e.g. "cart has items"'),
  responsiveBehavior: z
    .array(z.string())
    .describe('Media queries / breakpoints that affect this page, with values'),
  businessRules: z.array(z.string()).describe('Calculations and rules as implemented, citing the file'),
});
export type PageModel = z.infer<typeof PageModelSchema>;

export const AppModelSchema = z.object({
  summary: z.string(),
  pages: z.array(PageModelSchema),
  flows: z.array(
    z.object({
      name: z.string(),
      feature: z.string().describe('Short kebab-case feature key, e.g. "checkout", "auth"'),
      steps: z.array(z.string()),
      routes: z.array(z.string()),
    }),
  ),
  auth: z.string().nullable(),
  stateManagement: z.string(),
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
  analyzedAt: z.string(),
  /** Hash of each page's source files at analysis time; used to detect changed pages. */
  pageHashes: z.record(z.string(), z.string()),
});
export type AppModelFile = z.infer<typeof AppModelFileSchema>;

function sourceFiles(ctx: QaContext): string[] {
  return ctx.config.source.include.flatMap((dir) => {
    const full = path.join(ctx.root, dir);
    if (!fs.existsSync(full)) return [];
    return fs.statSync(full).isDirectory() ? listFiles(full, ctx.config.source.exclude) : [full];
  });
}

/** Hash of the files a page depends on (missing files are ignored). */
export function pageHash(root: string, page: Pick<PageModel, 'files'>): string {
  const files = page.files.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
  return hashFiles(root, files);
}

export function loadAppModel(ctx: QaContext): AppModelFile | undefined {
  return readJson(ctx.paths.appModel, AppModelFileSchema);
}

export async function analyzeApp(ctx: QaContext, opts: { force?: boolean } = {}): Promise<AppModelFile> {
  const files = sourceFiles(ctx);
  const inputHash = sha256(hashFiles(ctx.root, files) + projectRules(ctx));
  const existing = loadAppModel(ctx);
  if (!opts.force && existing && ctx.state.isStageFresh('analyze', inputHash)) {
    log.info('Application model is up to date');
    return existing;
  }
  log.info(`Analyzing application source (${files.length} files in ${ctx.config.source.include.join(', ')})`);

  const previous = existing
    ? `\nA previous analysis exists at .qa/app-model.json. Re-verify it against the current code; keep what is still true.`
    : '';
  const res = await ctx.ai.run({
    name: 'app-analyze',
    cwd: ctx.root,
    system: BASE_SYSTEM,
    prompt: `Analyze this web application's source code so that a QA engineer can write end-to-end tests without reading the code.

Project discovery (deterministic, from package.json and the file system):
${projectInfoJson(ctx)}

Source directories to read: ${ctx.config.source.include.join(', ')}
Do not read node_modules, build output or the .qa directory.${previous}

Instructions:
- Read the router/entry point first, then every page and the components/state they use. Use Glob/Grep/Read.
- For every route, record exactly what a user sees and can do: headings, accessible names of buttons/links/inputs (derive from aria-label, label/htmlFor, visible text), forms with validation rules and exact messages, loading/empty/error states, preconditions.
- Record business rules and calculations as implemented (e.g. how totals are computed), citing file paths. Describe what the code DOES, even if it looks wrong — note suspicious logic in businessRules with the file path, but do not speculate beyond the code.
- Record responsive behaviour from CSS media queries with exact breakpoint values and what changes.
- Record styling tokens as implemented (CSS custom properties, theme values) with exact values.
- "files" per page must list every source file that affects that page (page component, layout, shared components, styles, state, api).
- testData: valid inputs found in code (credentials, coupon codes, product names).
- Anything you could not determine goes in "unknowns".${projectRules(ctx)}`,
    schema: AppModelSchema,
    tools: ['Read', 'Glob', 'Grep'],
  });

  const model = res.output;
  const pageHashes = Object.fromEntries(model.pages.map((p) => [p.route, pageHash(ctx.root, p)]));
  const file: AppModelFile = { ...model, analyzedAt: new Date().toISOString(), pageHashes };
  writeJson(ctx.paths.appModel, file);
  ctx.state.markStage('analyze', inputHash);
  log.info(
    `Application model: ${model.pages.length} pages, ${model.flows.length} flows, ${model.testData.length} test data items`,
  );
  return file;
}

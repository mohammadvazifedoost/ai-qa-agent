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
  /** Hash of each page's own source files at analysis time; used to detect changed pages. */
  pageHashes: z.record(z.string(), z.string()),
  /** Per-file hashes of files shared by every page (router, layout, global styles). */
  globalFileHashes: z.record(z.string(), z.string()).default({}),
});
export type AppModelFile = z.infer<typeof AppModelFileSchema>;

function sourceFiles(ctx: QaContext): string[] {
  return ctx.config.source.include.flatMap((dir) => {
    const full = path.join(ctx.root, dir);
    if (!fs.existsSync(full)) return [];
    return fs.statSync(full).isDirectory() ? listFiles(full, ctx.config.source.exclude) : [full];
  });
}

/**
 * Files that every page depends on (router entry, layout, global styles). They are hashed
 * separately so that registering a new route does not mark every existing page as changed.
 */
export function globalFilesOf(pages: ReadonlyArray<Pick<PageModel, 'files'>>): string[] {
  if (pages.length < 2) return [];
  return pages[0]!.files.filter((f) => pages.every((p) => p.files.includes(f))).sort();
}

/** Hash of the files a page depends on, excluding global files (missing files are ignored). */
export function pageHash(
  root: string,
  page: Pick<PageModel, 'files'>,
  globalFiles: readonly string[] = [],
): string {
  const files = page.files
    .filter((f) => !globalFiles.includes(f))
    .map((f) => path.join(root, f))
    .filter((f) => fs.existsSync(f));
  return hashFiles(root, files);
}

/** True for models written before shared files were hashed separately. */
export function isLegacyModel(model: AppModelFile): boolean {
  return Object.keys(model.globalFileHashes).length === 0 && globalFilesOf(model.pages).length > 0;
}

export function fileHashes(root: string, files: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    files
      .filter((f) => fs.existsSync(path.join(root, f)))
      .map((f) => [f, hashFiles(root, [path.join(root, f)])]),
  );
}

export function loadAppModel(ctx: QaContext): AppModelFile | undefined {
  return readJson(ctx.paths.appModel, AppModelFileSchema);
}

const INSTRUCTIONS = `Instructions:
- For every route, record exactly what a user sees and can do: headings, accessible names of buttons/links/inputs (derive from aria-label, label/htmlFor, visible text), forms with validation rules and exact messages, loading/empty/error states, preconditions.
- Record business rules and calculations as implemented (e.g. how totals are computed), citing file paths. Describe what the code DOES, even if it looks wrong — note suspicious logic in businessRules with the file path, but do not speculate beyond the code.
- Record responsive behaviour from CSS media queries with exact breakpoint values and what changes.
- Record styling tokens as implemented (CSS custom properties, theme values) with exact values.
- "files" per page must list every source file that affects that page (page component, layout, shared components, styles, state, api).
- testData: valid inputs found in code (credentials, coupon codes, product names).
- Anything you could not determine goes in "unknowns".`;

export interface AnalyzeOptions {
  /** Re-analyze everything, ignoring caches. */
  force?: boolean;
  /** Only (re)analyze these routes; other pages of the existing model are kept as they are. */
  routes?: string[];
}

function saveModel(ctx: QaContext, model: AppModel, inputHash: string): AppModelFile {
  const globalFiles = globalFilesOf(model.pages);
  const pageHashes = Object.fromEntries(
    model.pages.map((p) => [p.route, pageHash(ctx.root, p, globalFiles)]),
  );
  const file: AppModelFile = {
    ...model,
    analyzedAt: new Date().toISOString(),
    pageHashes,
    globalFileHashes: fileHashes(ctx.root, globalFiles),
  };
  writeJson(ctx.paths.appModel, file);
  ctx.state.markStage('analyze', inputHash);
  return file;
}

/**
 * Builds/updates `.qa/app-model.json`. With an existing model, only pages whose source files
 * changed (or that were added) are re-analyzed, so unchanged pages keep their model verbatim and
 * downstream caches (scenarios, tests) stay valid for them.
 */
export async function analyzeApp(ctx: QaContext, opts: AnalyzeOptions = {}): Promise<AppModelFile> {
  const files = sourceFiles(ctx);
  const inputHash = sha256(hashFiles(ctx.root, files) + projectRules(ctx));
  const existing = loadAppModel(ctx);
  if (!opts.force && existing && ctx.state.isStageFresh('analyze', inputHash)) {
    if (isLegacyModel(existing)) {
      // Models from before per-page change tracking: the source is unchanged, so the new hashes
      // can be computed now without any AI work.
      log.info('Upgrading app-model.json hashes for per-page change detection');
      return saveModel(ctx, existing, inputHash);
    }
    log.info('Application model is up to date');
    return existing;
  }
  if (existing && !opts.force) {
    // Lazy import: changes/detect.ts imports this module.
    const { detectCodeChanges, routesToAnalyze } = await import('../changes/detect.js');
    const changes = detectCodeChanges(ctx, existing);
    const routes = opts.routes ?? routesToAnalyze(changes);
    const remaining = existing.pages.filter((p) => !changes.removedPages.includes(p.route));
    if (routes.length === 0) {
      if (changes.removedPages.length) log.info(`Dropping removed pages: ${changes.removedPages.join(', ')}`);
      else log.info('Source changed but no page is affected; model kept');
      return saveModel(ctx, { ...existing, pages: remaining }, inputHash);
    }
    log.info(`Analyzing changed/new pages only: ${routes.join(', ')}`);
    const updated = await analyzeRoutes(ctx, { ...existing, pages: remaining }, routes);
    return saveModel(ctx, updated, inputHash);
  }

  log.info(`Analyzing application source (${files.length} files in ${ctx.config.source.include.join(', ')})`);
  const res = await ctx.ai.run({
    name: 'app-analyze',
    cwd: ctx.root,
    system: BASE_SYSTEM,
    prompt: `Analyze this web application's source code so that a QA engineer can write end-to-end tests without reading the code.

Project discovery (deterministic, from package.json and the file system):
${projectInfoJson(ctx)}

Source directories to read: ${ctx.config.source.include.join(', ')}
Do not read node_modules, build output or the .qa directory.

${INSTRUCTIONS}
- Read the router/entry point first, then every page and the components/state they use. Use Glob/Grep/Read.${projectRules(ctx)}`,
    schema: AppModelSchema,
    tools: ['Read', 'Glob', 'Grep'],
  });
  const model = res.output;
  const file = saveModel(ctx, model, inputHash);
  log.info(
    `Application model: ${model.pages.length} pages, ${model.flows.length} flows, ${model.testData.length} test data items`,
  );
  return file;
}

const PartialModelSchema = z.object({
  pages: z.array(PageModelSchema).describe('Only the requested routes'),
  flows: AppModelSchema.shape.flows.describe('Complete, updated list of flows for the whole app'),
  testData: z.array(z.string()).describe('New or changed test data only'),
  unknowns: z.array(z.string()),
});

/** Re-analyze a subset of routes and merge the result into the existing model. */
async function analyzeRoutes(ctx: QaContext, existing: AppModelFile, routes: string[]): Promise<AppModel> {
  const others = existing.pages.filter((p) => !routes.includes(p.route));
  const res = await ctx.ai.run({
    name: `app-analyze-${routes.length}-pages`,
    cwd: ctx.root,
    system: BASE_SYSTEM,
    prompt: `Update the QA analysis of this web application for these routes ONLY: ${routes.join(', ')}
They were added or their source files changed. Other pages are unchanged and must not be re-analyzed.

Project discovery (deterministic, from package.json and the file system):
${projectInfoJson(ctx)}

Existing analysis of the pages to update (may be outdated; re-verify against the code):
${JSON.stringify(
  existing.pages.filter((p) => routes.includes(p.route)),
  null,
  2,
)}

Unchanged pages (for context — routes, names and files only):
${JSON.stringify(
  others.map((p) => ({ route: p.route, name: p.name, files: p.files })),
  null,
  2,
)}

Existing flows:
${JSON.stringify(existing.flows, null, 2)}

${INSTRUCTIONS}
- Read the router/entry point to locate the requested routes, then their pages and the components/state they use.
- Return page models for the requested routes only, the complete updated flow list (keep existing flows that still apply, add flows for the new/changed pages), new/changed test data, and unknowns.${projectRules(ctx)}`,
    schema: PartialModelSchema,
    tools: ['Read', 'Glob', 'Grep'],
  });
  const returned = res.output.pages.filter((p) => routes.includes(p.route));
  const missing = routes.filter((r) => !returned.some((p) => p.route === r));
  if (missing.length) log.warn(`Analysis returned no model for: ${missing.join(', ')}`);
  const stale = existing.pages.filter((p) => missing.includes(p.route));
  return {
    ...existing,
    pages: [...others, ...stale, ...returned].sort((a, b) => a.route.localeCompare(b.route)),
    flows: res.output.flows,
    testData: [...new Set([...existing.testData, ...res.output.testData])],
    unknowns: res.output.unknowns,
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ToolCallRecord } from '../ai/claude.js';
import { BASE_SYSTEM, figmaFileKey, projectInfoJson, projectRules } from '../ai/context.js';
import { ensureDir, sha256, slugify, writeJson } from '../core/fs.js';
import { pageStructureHashes } from '../changes/detect.js';
import { logger } from '../core/logger.js';
import { rel } from '../core/paths.js';
import type { QaContext } from '../pipeline/context.js';
import { DesignSystemFileSchema, DesignSystemSchema, type DesignSystemFile } from './schema.js';

const log = logger('design');

/** Read-only Figma MCP tools. `use_figma` is deliberately excluded because it can modify the file. */
export const FIGMA_READ_TOOLS = [
  'mcp__figma__get_metadata',
  'mcp__figma__get_variable_defs',
  'mcp__figma__get_screenshot',
  'mcp__figma__get_design_context',
];

const ScreenshotMeta = z.object({
  image_url: z.string().url(),
  width: z.number(),
  height: z.number(),
  original_width: z.number(),
  original_height: z.number(),
});

function buildPrompt(ctx: QaContext, fileKey: string): string {
  const figma = ctx.config.figma!;
  const pinned = figma.frames.length
    ? `The project pins these frames (use them as screens with the given route/viewport):\n${JSON.stringify(figma.frames, null, 2)}`
    : 'No frames are pinned; discover the screens yourself.';
  return `Extract the design system and screen inventory from this Figma file.

Figma file key: ${fileKey}
File URL: ${figma.fileUrl}

Viewports configured for testing (name → size):
${JSON.stringify(ctx.config.viewports)}

Target application (detected from source):
${projectInfoJson(ctx)}

${pinned}

Procedure:
1. Call get_metadata WITHOUT a nodeId to list pages. Then call get_metadata for each page id to see frames, components and their sizes.
2. Identify top-level SCREEN frames (full pages) and COMPONENTS / COMPONENT SETS.
3. Call get_variable_defs on each screen and component to collect the variables (colors, spacing, radius, sizes) actually used.
4. For each component set, call get_design_context (excludeScreenshot: true) to read exact styles per variant (fill, radius, height, padding, text style). You are only reading styles; do not generate code for the project.
5. REQUIRED: for EVERY screen frame call get_screenshot with maxDimension equal to max(width, height) of that frame, so the image is rendered at 1x. Use the default response (no base64) — the tool host downloads the image. Only set enableBase64Response when you need to look at a screen to describe its key elements.
6. Map each screen to an app route when the name or content makes it clear (certainty "inferred"), otherwise route null / certainty "unknown". Map its width to the closest configured viewport.

Output rules:
- Values must come from Figma data. Colors as uppercase hex (#RRGGBB), sizes in px, font weights as numbers.
- certainty "observed" = read directly from variables/styles/node properties; "inferred" = derived; never invent tokens.
- Components: list variants and, per variant, CSS-like properties (backgroundColor, color, borderRadius, height, paddingLeft, fontSize, fontWeight, borderColor...).
- breakpoints: only infer from screen widths that exist (certainty "inferred").
- Put anything you could not determine in "unknowns".${projectRules(ctx)}`;
}

/** Save 1x reference images for each screen from the screenshots the agent requested. */
async function saveReferences(
  ctx: QaContext,
  screens: Array<{ name: string; nodeId: string; width: number; height: number }>,
  calls: ToolCallRecord[],
): Promise<DesignSystemFile['references']> {
  ensureDir(ctx.paths.designRefsDir);
  const refs: DesignSystemFile['references'] = [];
  for (const screen of screens) {
    const candidates = calls
      .filter((c) => c.name === 'mcp__figma__get_screenshot' && !c.isError)
      .filter((c) => {
        const id = (c.input as { nodeId?: string } | undefined)?.nodeId?.replace('-', ':');
        return id === screen.nodeId;
      })
      .map((c) => {
        const json = c.text.match(/\{[^{}]*"image_url"[^{}]*\}/)?.[0];
        const meta = json ? ScreenshotMeta.safeParse(JSON.parse(json)) : undefined;
        return meta?.success ? meta.data : undefined;
      })
      .filter((m): m is z.infer<typeof ScreenshotMeta> => !!m)
      .sort((a, b) => b.width - a.width);
    const best = candidates[0];
    if (!best) {
      log.warn(
        `No screenshot captured for screen "${screen.name}" (${screen.nodeId}); visual comparison disabled for it`,
      );
      continue;
    }
    if (best.width !== best.original_width) {
      log.warn(
        `Screenshot of "${screen.name}" is scaled (${best.width} vs ${best.original_width}px); skipping`,
      );
      continue;
    }
    const res = await fetch(best.image_url);
    if (!res.ok) {
      log.warn(`Downloading reference for "${screen.name}" failed: HTTP ${res.status}`);
      continue;
    }
    const file = path.join(ctx.paths.designRefsDir, `${slugify(screen.name)}.png`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    refs.push({
      screen: screen.name,
      nodeId: screen.nodeId,
      file: rel(ctx.paths.qaDir, file),
      width: best.width,
      height: best.height,
    });
    log.info(`Saved design reference ${rel(ctx.root, file)} (${best.width}x${best.height})`);
  }
  return refs;
}

export async function extractDesign(
  ctx: QaContext,
  opts: { force?: boolean } = {},
): Promise<DesignSystemFile | null> {
  const figma = ctx.config.figma;
  if (!figma) {
    log.info(
      'No figma section in .qa/config.ts — skipping design extraction (visual tests will use code only)',
    );
    return null;
  }
  if (!ctx.config.ai.mcpServers.figma) {
    throw new Error(
      'config.figma is set but ai.mcpServers.figma is missing. Add the Figma MCP server (see README).',
    );
  }
  const fileKey = figmaFileKey(figma.fileUrl);
  const inputHash = sha256(JSON.stringify({ figma, viewports: ctx.config.viewports }));
  if (!opts.force && fs.existsSync(ctx.paths.designSystem) && ctx.state.isStageFresh('design', inputHash)) {
    const existing = DesignSystemFileSchema.parse(
      JSON.parse(fs.readFileSync(ctx.paths.designSystem, 'utf8')),
    );
    log.info('Design system is up to date (use --refresh to re-extract from Figma)');
    return fetchMissingReferences(ctx, fileKey, existing);
  }

  const res = await ctx.ai.run({
    name: 'design-extract',
    cwd: ctx.root,
    system: BASE_SYSTEM,
    prompt: buildPrompt(ctx, fileKey),
    schema: DesignSystemSchema,
    tools: ['Read'],
    mcpServers: { figma: ctx.config.ai.mcpServers.figma },
    mcpTools: FIGMA_READ_TOOLS,
  });
  reportFigmaErrors(res.toolCalls);
  const design = res.output;
  // Pinned frames from config win over the agent's route inference.
  for (const pin of figma.frames) {
    const s = design.screens.find((x) => x.nodeId === pin.nodeId.replace('-', ':'));
    if (s) Object.assign(s, { route: pin.route, routeCertainty: 'observed', viewport: pin.viewport });
  }
  const references = await saveReferences(ctx, design.screens, res.toolCalls);
  const file: DesignSystemFile = {
    ...design,
    extractedAt: new Date().toISOString(),
    figmaPageHashes: pageStructureHashes(res.toolCalls),
    references,
  };
  writeJson(ctx.paths.designSystem, file);
  ctx.state.markStage('design', inputHash);
  log.info(
    `Design system: ${design.colors.length} colors, ${design.typography.length} text styles, ${design.components.length} components, ${design.screens.length} screens, ${references.length} reference images`,
  );
  return file;
}

const RATE_LIMIT = /tool call limit|rate limit|too many requests/i;

/** Surface Figma plan/rate-limit errors loudly: they silently degrade visual testing otherwise. */
function reportFigmaErrors(calls: ToolCallRecord[]): boolean {
  const limited = calls.filter(
    (c) => c.isError && c.name.startsWith('mcp__figma__') && RATE_LIMIT.test(c.text),
  );
  if (limited.length === 0) return false;
  log.warn(
    `Figma MCP rejected ${limited.length} call(s) because of plan limits: "${limited[0]!.text.trim().slice(0, 160)}". ` +
      'Starter plans allow 20 read calls/month; Dev/Full seats on paid plans allow 200+/day. ' +
      'Results below are partial; re-run `ai-qa analyze` after the limit resets to fill the gaps.',
  );
  return true;
}

/**
 * Screens whose 1x reference image is missing (e.g. because a previous extraction hit a rate limit)
 * are fetched with a minimal task: one get_screenshot call per missing screen, nothing else.
 */
async function fetchMissingReferences(
  ctx: QaContext,
  fileKey: string,
  file: DesignSystemFile,
): Promise<DesignSystemFile> {
  const have = new Set(file.references.map((r) => r.nodeId));
  const missing = file.screens.filter((s) => !have.has(s.nodeId));
  if (missing.length === 0) return file;
  const last = ctx.state.data.designRefsAttemptAt;
  if (last && Date.now() - Date.parse(last) < 24 * 60 * 60 * 1000) {
    log.info(
      `${missing.length} design reference image(s) still missing; last fetch attempt ${last.slice(0, 16)} — retrying after 24h or with --refresh`,
    );
    return file;
  }
  ctx.state.data.designRefsAttemptAt = new Date().toISOString();
  ctx.state.save();
  log.info(`Fetching ${missing.length} missing design reference image(s)`);
  const res = await ctx.ai.run({
    name: 'design-refs',
    cwd: ctx.root,
    system: BASE_SYSTEM,
    prompt: `For each node below, call mcp__figma__get_screenshot exactly once with fileKey "${fileKey}", the nodeId, and maxDimension set to the given value. Use the default response (no base64). Do not call any other tool. Report which node ids returned an image.

${missing.map((s) => `- nodeId ${s.nodeId} ("${s.name}"), maxDimension ${Math.max(s.width, s.height)}`).join('\n')}`,
    schema: z.object({
      captured: z.array(z.string()),
      failed: z.array(z.object({ nodeId: z.string(), error: z.string() })),
    }),
    tools: [],
    mcpServers: { figma: ctx.config.ai.mcpServers.figma! },
    mcpTools: ['mcp__figma__get_screenshot'],
  });
  reportFigmaErrors(res.toolCalls);
  const added = await saveReferences(ctx, missing, res.toolCalls);
  const updated: DesignSystemFile = { ...file, references: [...file.references, ...added] };
  writeJson(ctx.paths.designSystem, updated);
  return updated;
}

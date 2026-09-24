import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_SYSTEM, figmaFileKey } from '../ai/context.js';
import {
  fileHashes,
  globalFilesOf,
  isLegacyModel,
  loadAppModel,
  pageHash,
  type AppModelFile,
} from '../analyze/app.js';
import { sha256, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { detectProject } from '../discovery/detect.js';
import type { DesignSystemFile } from '../design/schema.js';
import type { QaContext } from '../pipeline/context.js';

const log = logger('changes');

export interface CodeChanges {
  /** Routes found in the code that the app model does not know yet. */
  newPages: Array<{ route: string; file: string }>;
  /** Known routes whose source files changed since they were analyzed. */
  changedPages: string[];
  /** Known routes whose source files all disappeared. */
  removedPages: string[];
  unchangedPages: string[];
  /** Shared files (router, layout, global styles) that changed; they affect every page. */
  changedGlobalFiles: string[];
  hasModel: boolean;
}

/** Deterministic, free: compares the current source tree with the hashes stored at analysis time. */
export function detectCodeChanges(ctx: QaContext, model = loadAppModel(ctx)): CodeChanges {
  const project = detectProject(ctx.root);
  writeJson(path.join(ctx.paths.qaDir, 'project.json'), project);
  if (!model) {
    return {
      newPages: project.routes.map((r) => ({ route: r.path, file: r.file })),
      changedPages: [],
      removedPages: [],
      unchangedPages: [],
      changedGlobalFiles: [],
      hasModel: false,
    };
  }
  const known = new Set(model.pages.map((p) => p.route));
  const newPages = project.routes
    .filter((r) => !known.has(r.path))
    .map((r) => ({ route: r.path, file: r.file }));
  // Legacy models hashed shared files into every page; compare the same way until re-analyzed.
  const globalFiles = isLegacyModel(model) ? [] : globalFilesOf(model.pages);
  const changedPages: string[] = [];
  const removedPages: string[] = [];
  const unchangedPages: string[] = [];
  for (const page of model.pages) {
    const own = page.files.filter((f) => !globalFiles.includes(f));
    const exists = own.some((f) => fs.existsSync(path.join(ctx.root, f)));
    if (!exists) removedPages.push(page.route);
    else if (pageHash(ctx.root, page, globalFiles) !== model.pageHashes[page.route])
      changedPages.push(page.route);
    else unchangedPages.push(page.route);
  }
  const currentGlobal = fileHashes(ctx.root, globalFiles);
  const changedGlobalFiles = globalFiles.filter((f) => currentGlobal[f] !== model.globalFileHashes[f]);
  return { newPages, changedPages, removedPages, unchangedPages, changedGlobalFiles, hasModel: true };
}

/** Routes that need (re)analysis: new and changed pages. */
export function routesToAnalyze(c: CodeChanges): string[] {
  return [...c.newPages.map((p) => p.route), ...c.changedPages];
}

export interface DesignChanges {
  /** Top-level frames in Figma that are not in design-system.json. */
  newScreens: Array<{ nodeId: string; name: string; width: number; height: number }>;
  /** Figma pages whose structure (node tree) changed since extraction. */
  changedPages: string[];
  removedScreens: string[];
  /** True when the Figma file could not be inspected (quota, auth); nothing is known then. */
  inspected: boolean;
  note?: string;
}

const FrameList = z.object({
  pages: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      frames: z.array(
        z.object({ nodeId: z.string(), name: z.string(), width: z.number(), height: z.number() }),
      ),
    }),
  ),
});

/** Hash of the metadata XML of each Figma page, captured from get_metadata tool results. */
export function pageStructureHashes(
  calls: Array<{ name: string; input: unknown; text: string; isError: boolean }>,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const c of calls) {
    if (c.name !== 'mcp__figma__get_metadata' || c.isError) continue;
    const nodeId = (c.input as { nodeId?: string } | undefined)?.nodeId?.replace('-', ':');
    if (!nodeId || !/<canvas /.test(c.text)) continue;
    // Positions/sizes/names/ids are all in the XML, so any structural or layout change alters the hash.
    hashes[nodeId] = sha256(c.text.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim());
  }
  return hashes;
}

/**
 * Costs 1 + (number of Figma pages) MCP read calls. Compares the frame list and page structure
 * with what was extracted last time. Content changes inside a frame show up as a page hash change.
 */
export async function detectDesignChanges(ctx: QaContext, design: DesignSystemFile): Promise<DesignChanges> {
  const figma = ctx.config.figma;
  const none: DesignChanges = { newScreens: [], changedPages: [], removedScreens: [], inspected: false };
  if (!figma || !ctx.config.ai.mcpServers.figma) return { ...none, note: 'Figma not configured' };
  const fileKey = figmaFileKey(figma.fileUrl);
  const res = await ctx.ai.run({
    name: 'design-changes',
    cwd: ctx.root,
    system: BASE_SYSTEM,
    prompt: `List the pages and top-level frames of Figma file ${fileKey}.
Call mcp__figma__get_metadata once WITHOUT nodeId to list pages, then once per page id. Do not call any other tool.
Return every page with its top-level frames (direct children of the canvas that are frames/sections/components): nodeId, name, width, height.`,
    schema: FrameList,
    tools: [],
    mcpServers: { figma: ctx.config.ai.mcpServers.figma },
    mcpTools: ['mcp__figma__get_metadata'],
  });
  const errors = res.toolCalls.filter((c) => c.isError && c.name.startsWith('mcp__figma__'));
  if (errors.length) {
    log.warn(`Figma could not be inspected: ${errors[0]!.text.trim().slice(0, 160)}`);
    return { ...none, note: errors[0]!.text.trim().slice(0, 200) };
  }
  const known = new Map(design.screens.map((s) => [s.nodeId, s]));
  const frames = res.output.pages.flatMap((p) => p.frames);
  const newScreens = frames.filter((f) => !known.has(f.nodeId.replace('-', ':')));
  const seen = new Set(frames.map((f) => f.nodeId.replace('-', ':')));
  const removedScreens = design.screens.filter((s) => !seen.has(s.nodeId)).map((s) => s.name);
  const hashes = pageStructureHashes(res.toolCalls);
  const previous = design.figmaPageHashes ?? {};
  const changedPages = Object.entries(hashes)
    .filter(([id, h]) => previous[id] !== undefined && previous[id] !== h)
    .map(([id]) => res.output.pages.find((p) => p.id === id)?.name ?? id);
  return { newScreens, changedPages, removedScreens, inspected: true };
}

export function describeChanges(code: CodeChanges, design?: DesignChanges): string[] {
  const lines: string[] = [];
  if (!code.hasModel) lines.push('No app model yet — everything is new. Run `ai-qa analyze`.');
  for (const p of code.newPages) lines.push(`new page      ${p.route}  (${p.file})`);
  for (const r of code.changedPages) lines.push(`changed page  ${r}`);
  for (const r of code.removedPages) lines.push(`removed page  ${r}`);
  for (const f of code.changedGlobalFiles)
    lines.push(`changed shared file  ${f}  (affects every page — consider a full run)`);
  if (
    code.hasModel &&
    !code.newPages.length &&
    !code.changedPages.length &&
    !code.removedPages.length &&
    !code.changedGlobalFiles.length
  ) {
    lines.push('code: no changes since the last analysis');
  }
  if (design) {
    if (!design.inspected) lines.push(`design: not inspected (${design.note ?? 'unknown reason'})`);
    for (const s of design.newScreens)
      lines.push(`new screen    ${s.name} (${s.nodeId}, ${s.width}x${s.height})`);
    for (const p of design.changedPages) lines.push(`changed figma page  ${p}`);
    for (const s of design.removedScreens) lines.push(`removed screen  ${s}`);
    if (
      design.inspected &&
      !design.newScreens.length &&
      !design.changedPages.length &&
      !design.removedScreens.length
    ) {
      lines.push('design: no changes since the last extraction');
    }
  }
  return lines;
}

export type { AppModelFile };

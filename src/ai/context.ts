import fs from 'node:fs';
import path from 'node:path';
import type { QaContext } from '../pipeline/context.js';

/** Shared system instructions for every AI task. */
export const BASE_SYSTEM = `You are the analysis engine of an automated QA tool.
Rules that always apply:
- Investigate before answering. Never state anything about the code or design that you did not read or observe with a tool.
- If something cannot be determined, say so explicitly (use "unknown" / null) instead of guessing.
- You are read-only. Never suggest that you changed application code; you cannot and must not.
- Be concise and concrete. Prefer exact values, file paths and node ids over prose.
- Your final answer is delivered only through the structured output tool.`;

/** Project-specific rules from `.qa/rules.md`, if the user wrote any. */
export function projectRules(ctx: QaContext): string {
  if (!fs.existsSync(ctx.paths.rules)) return '';
  const text = fs
    .readFileSync(ctx.paths.rules, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  return text ? `\n\n## Project QA rules (from .qa/rules.md)\n${text}` : '';
}

export function projectInfoJson(ctx: QaContext): string {
  const file = path.join(ctx.paths.qaDir, 'project.json');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
}

/** Parse the Figma file key out of a design URL. */
export function figmaFileKey(url: string): string {
  const m = url.match(
    /figma\.com\/(?:design|file)\/([0-9a-zA-Z]{10,128})(?:\/branch\/([0-9a-zA-Z]{10,128}))?/,
  );
  if (!m) throw new Error(`Cannot parse a Figma file key from "${url}"`);
  return m[2] ?? m[1]!;
}

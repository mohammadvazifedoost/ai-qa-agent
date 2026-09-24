import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '../config/schema.js';

/**
 * Read-only capabilities an AI task may use. Anything that can modify files is never granted:
 * the agent reads the target project and returns structured data; the engine writes files.
 * Each provider maps these to its own tool names.
 */
export type ReadOnlyTool = 'Read' | 'Glob' | 'Grep';

export interface AiTask<T extends z.ZodType> {
  /** Short identifier used for transcript file names and logs. */
  name: string;
  prompt: string;
  /** Extra system instructions. */
  system?: string;
  schema: T;
  cwd: string;
  tools?: ReadOnlyTool[];
  /** MCP servers to expose, keyed by server name. */
  mcpServers?: Record<string, McpServer>;
  /**
   * Allowed MCP tools in canonical form `mcp__<server>__<tool>` or `mcp__<server>__*`.
   * Providers translate these to their own naming.
   */
  mcpTools?: string[];
  /** Additional directories the agent may read outside `cwd`. */
  addDirs?: string[];
  /** Images to attach to the prompt where the provider supports it (e.g. a failure screenshot). */
  images?: string[];
}

/** One tool call the agent made, with what the tool returned (captured from the event stream). */
export interface ToolCallRecord {
  /** Canonical name; MCP tools are always reported as `mcp__<server>__<tool>`. */
  name: string;
  input: unknown;
  /** Concatenated text content of the tool result. */
  text: string;
  images: Array<{ mediaType: string; base64: string }>;
  isError: boolean;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiResult<T> {
  output: T;
  /** Dollar cost when the provider reports one, otherwise 0 (see `usage`). */
  costUsd: number;
  usage?: AiUsage;
  durationMs: number;
  numTurns: number;
  transcript: string;
  /** Every tool call and its result, e.g. to pick up Figma screenshot URLs deterministically. */
  toolCalls: ToolCallRecord[];
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly transcript?: string,
  ) {
    super(message);
  }
}

export const PROVIDERS = ['claude-code', 'codex', 'opencode'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** The AI backend every pipeline stage talks to. */
export interface AiEngine {
  readonly provider: Provider;
  /** Sum of `costUsd` of all tasks run through this instance. */
  totalCostUsd: number;
  run<T extends z.ZodType>(task: AiTask<T>): Promise<AiResult<z.output<T>>>;
  /** How a prompt should refer to an MCP tool for this provider (e.g. `figma_get_screenshot`). */
  toolRef(server: string, tool: string): string;
}

export interface EngineSettings {
  provider: Provider;
  /** Executable to run (`claude`, `codex`, `opencode` or a path). */
  command: string;
  model?: string;
  maxBudgetUsdPerTask: number;
  transcriptDir: string;
}

/** Split a canonical `mcp__server__tool` name. */
export function parseMcpName(name: string): { server: string; tool: string } | undefined {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? { server: m[1]!, tool: m[2]! } : undefined;
}

export function transcriptPath(dir: string, taskName: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${stamp}_${taskName}.jsonl`);
}

// ---------------------------------------------------------------------------------------------
// Structured output for providers without a native JSON-schema mode (Codex, OpenCode):
// the schema goes into the prompt, the final message is parsed and validated, and one
// correction round is attempted if it does not match.
// ---------------------------------------------------------------------------------------------

export function jsonSchemaOf(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'output' });
}

export function structuredOutputInstruction(schema: z.ZodType): string {
  return `

## Output format (mandatory)
When you have finished investigating, your FINAL message must be ONLY one JSON object that
validates against this JSON Schema — no prose before or after it, no Markdown code fences:
${JSON.stringify(jsonSchemaOf(schema))}`;
}

/**
 * Pull a JSON value out of a model's final message: the whole text, a fenced ```json block, or the
 * outermost balanced {...} object (string-aware, so braces inside strings do not count).
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const attempts: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fence) attempts.push(fence[1]!);
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        attempts.push(trimmed.slice(start, i + 1));
        break;
      }
    }
  }
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      // try the next candidate
    }
  }
  throw new Error('no JSON object found in the final message');
}

export type ParseOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

export function parseStructured<T extends z.ZodType>(
  schema: T,
  text: string | undefined,
): ParseOutcome<z.output<T>> {
  if (!text?.trim()) return { ok: false, error: 'the final message was empty' };
  let value: unknown;
  try {
    value = extractJson(text);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 12)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: `JSON does not match the schema — ${issues}` };
}

export function correctionPrompt(error: string): string {
  return `Your previous final message could not be used: ${error}.
Reply now with ONLY the corrected JSON object that validates against the schema from the task. No prose, no code fences.`;
}

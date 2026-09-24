import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '../config/schema.js';
import { ensureDir } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { run } from '../core/process.js';

const log = logger('ai');

/**
 * Built-in Claude Code tools an AI task may use. Anything that can execute code or
 * modify files (Bash, Edit, Write, ...) is deliberately excluded: the QA agent reads the
 * target project and returns structured data; the engine itself writes files. This is how
 * we guarantee the agent never edits application code.
 */
export type ReadOnlyTool = 'Read' | 'Glob' | 'Grep';

export interface AiTask<T extends z.ZodType> {
  /** Short identifier used for transcript file names and logs. */
  name: string;
  prompt: string;
  /** Extra system instructions appended to Claude Code's default system prompt. */
  system?: string;
  schema: T;
  cwd: string;
  tools?: ReadOnlyTool[];
  /** MCP servers to expose; keys become the `mcp__<key>__` prefix. */
  mcpServers?: Record<string, McpServer>;
  /** Specific MCP tool names (e.g. `mcp__figma__get_screenshot`) or `mcp__<server>__*` wildcards. */
  mcpTools?: string[];
  /** Additional directories the agent may read outside `cwd`. */
  addDirs?: string[];
}

export interface AiSettings {
  claudePath: string;
  model: string;
  maxBudgetUsdPerTask: number;
  transcriptDir: string;
}

/** One tool call the agent made, with what the tool returned (captured from the event stream). */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  /** Concatenated text content of the tool result. */
  text: string;
  images: Array<{ mediaType: string; base64: string }>;
  isError: boolean;
}

export interface AiResult<T> {
  output: T;
  costUsd: number;
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

const ContentBlock = z.looseObject({ type: z.string() });
const StreamEvent = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(ContentBlock)]).optional() }).optional(),
});
const ResultEvent = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  num_turns: z.number().optional(),
  permission_denials: z.array(z.unknown()).optional(),
});

/**
 * Runs one AI task through the locally installed, already-authenticated Claude Code CLI in
 * headless mode (`claude -p`). Authentication is whatever the user configured for Claude Code
 * (e.g. a Claude Max subscription login); this tool never reads or stores credentials.
 */
export class ClaudeRunner {
  /** Total spend of all tasks run through this instance (USD, as reported by Claude Code). */
  totalCostUsd = 0;

  constructor(private readonly settings: AiSettings) {}

  async run<T extends z.ZodType>(task: AiTask<T>): Promise<AiResult<z.output<T>>> {
    ensureDir(this.settings.transcriptDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const transcript = path.join(this.settings.transcriptDir, `${stamp}_${task.name}.jsonl`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-qa-'));
    const mcpConfigFile = path.join(tmp, 'mcp.json');
    fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: task.mcpServers ?? {} }));

    const tools = task.tools ?? ['Read', 'Glob', 'Grep'];
    const jsonSchema = z.toJSONSchema(task.schema, { target: 'draft-7', io: 'output' });
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      this.settings.model,
      '--json-schema',
      JSON.stringify(jsonSchema),
      // Only the listed built-in tools exist in the session at all.
      '--tools',
      tools.join(','),
      '--allowedTools',
      [...tools, ...(task.mcpTools ?? [])].join(','),
      // Anything not explicitly allowed is denied instead of prompting (there is no human).
      '--permission-mode',
      'dontAsk',
      // Isolate from the user's personal plugins/hooks/settings and MCP servers: only what we pass.
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfigFile,
      '--no-session-persistence',
      '--max-budget-usd',
      String(this.settings.maxBudgetUsdPerTask),
    ];
    if (task.system) args.push('--append-system-prompt', task.system);
    for (const dir of task.addDirs ?? []) args.push('--add-dir', dir);

    log.info(`AI task "${task.name}" started (model=${this.settings.model})`);
    log.debug(
      'claude args',
      args.filter((a) => a.length < 200),
    );
    const started = Date.now();
    const out = fs.createWriteStream(transcript);
    const toolCalls: ToolCallRecord[] = [];
    const toolUses = new Map<string, { name: string; input: unknown }>();
    let result: z.infer<typeof ResultEvent> | undefined;

    const onLine = (line: string): void => {
      if (!line.trim()) return;
      out.write(line + '\n');
      let event: z.infer<typeof StreamEvent>;
      try {
        event = StreamEvent.parse(JSON.parse(line));
      } catch {
        log.debug('non-JSON output from claude', line.slice(0, 200));
        return;
      }
      if (event.type === 'result') {
        result = ResultEvent.parse(event);
        return;
      }
      const content = event.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (event.type === 'assistant' && block.type === 'tool_use') {
          const id = String(block.id);
          toolUses.set(id, { name: String(block.name), input: block.input });
          log.debug(`tool → ${String(block.name)}`, block.input);
        }
        if (event.type === 'user' && block.type === 'tool_result') {
          const use = toolUses.get(String(block.tool_use_id));
          const record: ToolCallRecord = {
            name: use?.name ?? 'unknown',
            input: use?.input,
            text: '',
            images: [],
            isError: block.is_error === true,
          };
          const inner =
            typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content;
          for (const part of Array.isArray(inner) ? (inner as Array<Record<string, unknown>>) : []) {
            const source = part.source as { type?: string; media_type?: string; data?: string } | undefined;
            if (part.type === 'text' && typeof part.text === 'string') record.text += part.text + '\n';
            if (part.type === 'image' && source?.type === 'base64' && source.data) {
              record.images.push({ mediaType: source.media_type ?? 'image/png', base64: source.data });
            }
          }
          toolCalls.push(record);
        }
      }
    };

    try {
      const proc = await run(this.settings.claudePath, args, {
        cwd: task.cwd,
        input: task.prompt,
        onStdoutLine: onLine,
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      });
      out.end();
      if (!result) {
        throw new AiError(
          `Claude Code exited with code ${proc.code} without a result. stderr: ${proc.stderr.slice(0, 2000)}`,
          transcript,
        );
      }
      if (result.is_error || result.subtype !== 'success') {
        throw new AiError(
          `AI task "${task.name}" failed (${result.subtype}): ${result.result ?? proc.stderr.slice(0, 1000)}`,
          transcript,
        );
      }
      const parsed = task.schema.safeParse(result.structured_output);
      if (!parsed.success) {
        throw new AiError(
          `AI task "${task.name}" returned output that does not match the schema: ${parsed.error.message}`,
          transcript,
        );
      }
      const costUsd = result.total_cost_usd ?? 0;
      this.totalCostUsd += costUsd;
      const durationMs = Date.now() - started;
      log.info(
        `AI task "${task.name}" done in ${(durationMs / 1000).toFixed(0)}s, ${result.num_turns ?? '?'} turns, $${costUsd.toFixed(3)}`,
      );
      if (result.permission_denials?.length) {
        log.warn(
          `AI task "${task.name}" had ${result.permission_denials.length} denied tool call(s)`,
          result.permission_denials,
        );
      }
      return {
        output: parsed.data,
        costUsd,
        durationMs,
        numTurns: result.num_turns ?? 0,
        transcript,
        toolCalls,
      };
    } finally {
      out.end();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/** Verify the Claude Code CLI is installed and authenticated by running a trivial task. */
export async function checkClaude(claudePath: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const v = await run(claudePath, ['--version']);
    if (v.code !== 0) return { ok: false, detail: v.stderr || 'claude --version failed' };
    return { ok: true, detail: v.stdout.trim() };
  } catch (err) {
    return { ok: false, detail: `Could not execute "${claudePath}": ${(err as Error).message}` };
  }
}

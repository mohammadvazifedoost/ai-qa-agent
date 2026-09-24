import fs from 'node:fs';
import type { z } from 'zod';
import type { McpServer } from '../config/schema.js';
import { logger } from '../core/logger.js';
import { resolveCommand, run } from '../core/process.js';
import {
  AiError,
  correctionPrompt,
  parseMcpName,
  parseStructured,
  structuredOutputInstruction,
  transcriptPath,
  type AiEngine,
  type AiResult,
  type AiTask,
  type EngineSettings,
  type ToolCallRecord,
} from './engine.js';

const log = logger('ai');

/** `-c key=value` values are TOML; JSON strings and string arrays are valid TOML literals. */
const tomlString = (s: string): string => JSON.stringify(s);
const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const tomlTable = (obj: Record<string, string>): string =>
  `{${Object.entries(obj)
    .map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`)
    .join(', ')}}`;

/** `-c` overrides that register the task's MCP servers for this run only (no config.toml edits). */
export function codexMcpArgs(servers: Record<string, McpServer>, mcpTools: readonly string[] = []): string[] {
  const args: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const key = `mcp_servers.${tomlKey(name)}`;
    const set = (field: string, value: string): void => {
      args.push('-c', `${key}.${field}=${value}`);
    };
    if ('command' in server) {
      set('command', tomlString(server.command));
      if (server.args?.length) set('args', JSON.stringify(server.args));
      if (server.env && Object.keys(server.env).length) set('env', tomlTable(server.env));
    } else {
      set('url', tomlString(server.url));
      if (server.headers && Object.keys(server.headers).length)
        set('http_headers', tomlTable(server.headers));
    }
    // Allow-list the task's tools for this server, unless it asked for all of them.
    const wanted = mcpTools.map(parseMcpName).filter((p) => p?.server === name);
    if (wanted.length && !wanted.some((p) => p!.tool === '*')) {
      set('enabled_tools', JSON.stringify(wanted.map((p) => p!.tool)));
    }
  }
  return args;
}

export interface CodexRunState {
  lastMessage?: string;
  toolCalls: ToolCallRecord[];
  inputTokens: number;
  outputTokens: number;
  turns: number;
  errors: string[];
}

export function newCodexState(): CodexRunState {
  return { toolCalls: [], inputTokens: 0, outputTokens: 0, turns: 0, errors: [] };
}

/** Fold one `codex exec --json` event line into the run state. */
export function applyCodexEvent(state: CodexRunState, line: string): void {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (e.type) {
    case 'item.completed': {
      const item = (e.item ?? {}) as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') state.lastMessage = item.text;
      if (item.type === 'mcp_tool_call') {
        const result = (item.result ?? {}) as { content?: Array<Record<string, unknown>> };
        const error = (item.error ?? undefined) as { message?: string } | undefined;
        const record: ToolCallRecord = {
          name: `mcp__${String(item.server)}__${String(item.tool)}`,
          input: item.arguments,
          text: '',
          images: [],
          isError: item.status === 'failed' || !!error,
        };
        for (const c of result.content ?? []) {
          if (c.type === 'text' && typeof c.text === 'string') record.text += c.text + '\n';
          if (c.type === 'image' && typeof c.data === 'string') {
            record.images.push({ mediaType: String(c.mimeType ?? 'image/png'), base64: c.data });
          }
        }
        if (error?.message) record.text += error.message;
        state.toolCalls.push(record);
      }
      break;
    }
    case 'turn.completed': {
      state.turns++;
      const u = (e.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      state.inputTokens += u.input_tokens ?? 0;
      state.outputTokens += u.output_tokens ?? 0;
      break;
    }
    case 'turn.failed': {
      const err = (e.error ?? {}) as { message?: string };
      state.errors.push(err.message ?? 'turn failed');
      break;
    }
    case 'error':
      state.errors.push(String(e.message ?? 'error'));
      break;
  }
}

/**
 * Runs one AI task through the locally installed, already-authenticated OpenAI Codex CLI
 * (`codex exec --json`) in a read-only sandbox with approvals disabled. Codex reports tokens,
 * not dollars, so `costUsd` is 0 and `usage` carries the token counts.
 */
export class CodexRunner implements AiEngine {
  readonly provider = 'codex' as const;
  totalCostUsd = 0;

  constructor(
    private readonly settings: EngineSettings,
    /** Process runner; replaceable in tests. */
    private readonly exec: typeof run = run,
  ) {}

  toolRef(server: string, tool: string): string {
    return `the "${tool}" tool of the "${server}" MCP server`;
  }

  async run<T extends z.ZodType>(task: AiTask<T>): Promise<AiResult<z.output<T>>> {
    const transcript = transcriptPath(this.settings.transcriptDir, task.name);
    const out = fs.createWriteStream(transcript);
    const { command, prefixArgs } = resolveCommand(this.settings.command);
    const started = Date.now();
    const state = newCodexState();
    log.info(
      `AI task "${task.name}" started (codex${this.settings.model ? `, model=${this.settings.model}` : ''})`,
    );

    const attempt = async (message: string): Promise<string | undefined> => {
      state.lastMessage = undefined;
      const args = [
        ...prefixArgs,
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--color',
        'never',
        '-C',
        task.cwd,
        '-c',
        'approval_policy="never"',
        ...codexMcpArgs(task.mcpServers ?? {}, task.mcpTools),
      ];
      if (this.settings.model) args.push('-m', this.settings.model);
      for (const img of task.images ?? []) args.push('-i', img);
      args.push('-'); // prompt from stdin
      const proc = await this.exec(command, args, {
        cwd: task.cwd,
        input: message,
        onStdoutLine: (l) => {
          const line = l.replace(/\r$/, '');
          if (!line.trim()) return;
          out.write(line + '\n');
          applyCodexEvent(state, line);
        },
      });
      if (state.errors.length)
        throw new AiError(`AI task "${task.name}" failed: ${state.errors.at(-1)}`, transcript);
      if (proc.code !== 0 && state.lastMessage === undefined) {
        throw new AiError(`codex exited with code ${proc.code}: ${proc.stderr.slice(0, 1500)}`, transcript);
      }
      return state.lastMessage;
    };

    try {
      const prompt = `${task.system ? `${task.system}\n\n` : ''}${task.prompt}${structuredOutputInstruction(task.schema)}`;
      const first = await attempt(prompt);
      let parsed = parseStructured(task.schema, first);
      if (!parsed.ok) {
        // `codex exec` sessions are ephemeral here, so the correction is a fresh run that includes
        // the rejected answer.
        log.warn(`AI task "${task.name}": ${parsed.error}; asking for a corrected answer`);
        parsed = parseStructured(
          task.schema,
          await attempt(
            `${prompt}\n\n## Your previous final message\n${first ?? '(empty)'}\n\n${correctionPrompt(parsed.error)}`,
          ),
        );
      }
      if (!parsed.ok)
        throw new AiError(`AI task "${task.name}" returned unusable output: ${parsed.error}`, transcript);
      const durationMs = Date.now() - started;
      log.info(
        `AI task "${task.name}" done in ${(durationMs / 1000).toFixed(0)}s, ${state.turns} turn(s), ` +
          `${state.inputTokens + state.outputTokens} tokens`,
      );
      return {
        output: parsed.data,
        costUsd: 0,
        usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
        durationMs,
        numTurns: state.turns,
        transcript,
        toolCalls: state.toolCalls,
      };
    } finally {
      out.end();
    }
  }
}

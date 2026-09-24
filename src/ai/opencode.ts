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

/** Name of the agent injected for every run (read-only permissions, only the task's MCP tools). */
export const OPENCODE_AGENT = 'ai-qa-agent';

/** OpenCode names MCP tools `<server>_<tool>` with anything outside [a-zA-Z0-9_-] replaced by `_`. */
export function sanitizeOpenCode(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

const BUILTIN: Record<string, string[]> = { Read: ['read', 'list'], Glob: ['glob'], Grep: ['grep'] };

/**
 * Per-run OpenCode config, passed through OPENCODE_CONFIG_CONTENT (highest precedence, merged over
 * the user's config). A dedicated primary agent denies everything except the task's read tools and
 * its allowed MCP tools; `opencode run` auto-rejects anything else instead of prompting.
 */
export function buildOpenCodeConfig(
  task: Pick<AiTask<z.ZodType>, 'tools' | 'mcpServers' | 'mcpTools'>,
): Record<string, unknown> {
  const permission: Record<string, string> = { '*': 'deny' };
  const tools: Record<string, boolean> = {};
  for (const t of task.tools ?? ['Read', 'Glob', 'Grep'])
    for (const name of BUILTIN[t] ?? []) permission[name] = 'allow';
  for (const server of Object.keys(task.mcpServers ?? {})) tools[`${sanitizeOpenCode(server)}_*`] = false;
  for (const canonical of task.mcpTools ?? []) {
    const p = parseMcpName(canonical);
    if (!p) continue;
    const name = `${sanitizeOpenCode(p.server)}_${p.tool === '*' ? '*' : sanitizeOpenCode(p.tool)}`;
    permission[name] = 'allow';
    tools[name] = true;
  }
  const mcp: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(task.mcpServers ?? {})) mcp[name] = toOpenCodeMcp(server);
  return {
    agent: {
      [OPENCODE_AGENT]: {
        mode: 'primary',
        description: 'AI QA Agent (read-only analysis)',
        permission,
        tools,
      },
    },
    mcp,
  };
}

function toOpenCodeMcp(server: McpServer): Record<string, unknown> {
  if ('command' in server) {
    return {
      type: 'local',
      command: [server.command, ...(server.args ?? [])],
      environment: server.env,
      enabled: true,
    };
  }
  return { type: 'remote', url: server.url, headers: server.headers, enabled: true };
}

export interface OpenCodeRunState {
  texts: string[];
  toolCalls: ToolCallRecord[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  steps: number;
  sessionId?: string;
  errors: string[];
}

export function newOpenCodeState(): OpenCodeRunState {
  return { texts: [], toolCalls: [], costUsd: 0, inputTokens: 0, outputTokens: 0, steps: 0, errors: [] };
}

/** Map an OpenCode tool name back to the canonical `mcp__<server>__<tool>` when it belongs to an MCP server. */
export function canonicalOpenCodeTool(name: string, servers: readonly string[]): string {
  for (const server of servers) {
    const prefix = `${sanitizeOpenCode(server)}_`;
    if (name.startsWith(prefix)) return `mcp__${server}__${name.slice(prefix.length)}`;
  }
  return name;
}

/** Fold one `opencode run --format json` event line into the run state. */
export function applyOpenCodeEvent(state: OpenCodeRunState, line: string, servers: readonly string[]): void {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof e.sessionID === 'string') state.sessionId = e.sessionID;
  const part = (e.part ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'text':
      if (typeof part.text === 'string') state.texts.push(part.text);
      break;
    case 'tool_use': {
      const st = (part.state ?? {}) as Record<string, unknown>;
      const output = typeof st.output === 'string' ? st.output : st.output ? JSON.stringify(st.output) : '';
      const error = typeof st.error === 'string' ? st.error : '';
      state.toolCalls.push({
        name: canonicalOpenCodeTool(String(part.tool ?? 'unknown'), servers),
        input: st.input,
        text: output || error,
        images: [],
        isError: st.status === 'error',
      });
      break;
    }
    case 'step_finish': {
      state.steps++;
      if (typeof part.cost === 'number') state.costUsd += part.cost;
      const tokens = (part.tokens ?? {}) as { input?: number; output?: number };
      state.inputTokens += tokens.input ?? 0;
      state.outputTokens += tokens.output ?? 0;
      break;
    }
    case 'error': {
      const err = (e.error ?? {}) as { name?: string; data?: { message?: string }; message?: string };
      state.errors.push(
        `${err.name ?? 'Error'}: ${err.data?.message ?? err.message ?? JSON.stringify(e.error)}`,
      );
      break;
    }
  }
}

/**
 * Runs one AI task through the locally installed, already-authenticated OpenCode CLI
 * (`opencode run --format json`). The model is whatever `ai.model` says (provider/model), or the
 * user's OpenCode default.
 */
export class OpenCodeRunner implements AiEngine {
  readonly provider = 'opencode' as const;
  totalCostUsd = 0;

  constructor(
    private readonly settings: EngineSettings,
    /** Process runner; replaceable in tests. */
    private readonly exec: typeof run = run,
  ) {}

  toolRef(server: string, tool: string): string {
    return `${sanitizeOpenCode(server)}_${sanitizeOpenCode(tool)}`;
  }

  async run<T extends z.ZodType>(task: AiTask<T>): Promise<AiResult<z.output<T>>> {
    const transcript = transcriptPath(this.settings.transcriptDir, task.name);
    const out = fs.createWriteStream(transcript);
    const servers = Object.keys(task.mcpServers ?? {});
    const config = JSON.stringify(buildOpenCodeConfig(task));
    const { command, prefixArgs } = resolveCommand(this.settings.command);
    const started = Date.now();
    const state = newOpenCodeState();
    log.info(
      `AI task "${task.name}" started (opencode${this.settings.model ? `, model=${this.settings.model}` : ''})`,
    );

    const attempt = async (message: string, sessionId?: string): Promise<string | undefined> => {
      const args = [...prefixArgs, 'run', '--format', 'json', '--agent', OPENCODE_AGENT];
      if (this.settings.model) args.push('-m', this.settings.model);
      if (sessionId) args.push('--session', sessionId);
      else for (const img of task.images ?? []) args.push('-f', img);
      const before = state.texts.length;
      const proc = await this.exec(command, args, {
        cwd: task.cwd,
        input: message,
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: config },
        onStdoutLine: (l) => {
          const line = l.replace(/\r$/, '');
          if (!line.trim()) return;
          out.write(line + '\n');
          applyOpenCodeEvent(state, line, servers);
        },
      });
      if (state.errors.length)
        throw new AiError(`AI task "${task.name}" failed: ${state.errors.at(-1)}`, transcript);
      if (proc.code !== 0 && state.texts.length === before) {
        throw new AiError(
          `opencode exited with code ${proc.code}: ${proc.stderr.slice(0, 1500)}`,
          transcript,
        );
      }
      return state.texts.at(-1);
    };

    try {
      const prompt = `${task.system ? `${task.system}\n\n` : ''}${task.prompt}${structuredOutputInstruction(task.schema)}`;
      let parsed = parseStructured(task.schema, await attempt(prompt));
      if (!parsed.ok) {
        log.warn(`AI task "${task.name}": ${parsed.error}; asking for a corrected answer`);
        parsed = parseStructured(task.schema, await attempt(correctionPrompt(parsed.error), state.sessionId));
      }
      if (!parsed.ok)
        throw new AiError(`AI task "${task.name}" returned unusable output: ${parsed.error}`, transcript);
      const durationMs = Date.now() - started;
      this.totalCostUsd += state.costUsd;
      log.info(
        `AI task "${task.name}" done in ${(durationMs / 1000).toFixed(0)}s, ${state.steps} steps, ` +
          `${state.inputTokens + state.outputTokens} tokens, $${state.costUsd.toFixed(3)}`,
      );
      return {
        output: parsed.data,
        costUsd: state.costUsd,
        usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
        durationMs,
        numTurns: state.steps,
        transcript,
        toolCalls: state.toolCalls,
      };
    } finally {
      out.end();
    }
  }
}

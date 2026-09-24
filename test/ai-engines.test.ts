import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyCodexEvent, codexMcpArgs, CodexRunner, newCodexState } from '../src/ai/codex.js';
import { extractJson, parseStructured } from '../src/ai/engine.js';
import {
  applyOpenCodeEvent,
  buildOpenCodeConfig,
  canonicalOpenCodeTool,
  newOpenCodeState,
  OpenCodeRunner,
  OPENCODE_AGENT,
} from '../src/ai/opencode.js';
import { resolveCommand, type RunResult } from '../src/core/process.js';
import { makeProject } from './helpers.js';

const Answer = z.object({ coupons: z.array(z.string()) });

describe('extractJson / parseStructured', () => {
  it('accepts plain JSON, fenced JSON and JSON embedded in prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Result: {"a":"x } y","b":{"c":[1,2]}} done')).toEqual({
      a: 'x } y',
      b: { c: [1, 2] },
    });
    expect(() => extractJson('no json here')).toThrow(/no JSON/);
  });

  it('reports schema problems with paths', () => {
    expect(parseStructured(Answer, '{"coupons":["SAVE10"]}')).toEqual({
      ok: true,
      data: { coupons: ['SAVE10'] },
    });
    const bad = parseStructured(Answer, '{"coupons":[1]}');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/coupons\.0/);
    expect(parseStructured(Answer, '   ')).toEqual({ ok: false, error: 'the final message was empty' });
  });
});

describe('resolveCommand (Windows npm shims)', () => {
  const dir = 'C:\\npm';
  it('follows a .cmd shim to a native .exe', () => {
    const shim = '@ECHO off\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n';
    const r = resolveCommand('opencode', {
      platform: 'win32',
      pathEnv: dir,
      readFile: (p) => (p === path.join(dir, 'opencode.cmd') ? shim : undefined),
    });
    expect(r).toEqual({
      command: path.join(dir, 'node_modules\\opencode-ai\\bin\\opencode.exe'),
      prefixArgs: [],
    });
  });

  it('runs a .js shim target with the current Node', () => {
    const target = path.join(dir, 'node_modules\\@openai\\codex\\bin\\codex.js');
    const shim = '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*';
    const r = resolveCommand('codex', {
      platform: 'win32',
      pathEnv: dir,
      readFile: (p) => (p === path.join(dir, 'codex.cmd') ? shim : p === target ? '// js' : undefined),
    });
    expect(r).toEqual({ command: process.execPath, prefixArgs: [target] });
  });

  it('leaves commands alone on other platforms or when given a path', () => {
    expect(resolveCommand('codex', { platform: 'linux' })).toEqual({ command: 'codex', prefixArgs: [] });
    expect(resolveCommand('C:\\tools\\claude.exe', { platform: 'win32' }).command).toBe(
      'C:\\tools\\claude.exe',
    );
  });
});

describe('OpenCode', () => {
  it('builds a read-only agent that only allows the task tools and MCP tools', () => {
    const cfg = buildOpenCodeConfig({
      tools: ['Read', 'Grep'],
      mcpServers: {
        figma: { type: 'http', url: 'https://mcp.figma.com/mcp' },
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] },
      },
      mcpTools: ['mcp__figma__get_screenshot', 'mcp__playwright__*'],
    }) as {
      agent: Record<
        string,
        { mode: string; permission: Record<string, string>; tools: Record<string, boolean> }
      >;
      mcp: Record<string, unknown>;
    };
    const agent = cfg.agent[OPENCODE_AGENT]!;
    expect(agent.mode).toBe('primary');
    expect(agent.permission).toEqual({
      '*': 'deny',
      read: 'allow',
      list: 'allow',
      grep: 'allow',
      figma_get_screenshot: 'allow',
      'playwright_*': 'allow',
    });
    expect(agent.tools).toEqual({ 'figma_*': false, 'playwright_*': true, figma_get_screenshot: true });
    expect(cfg.mcp).toEqual({
      figma: { type: 'remote', url: 'https://mcp.figma.com/mcp', headers: undefined, enabled: true },
      playwright: {
        type: 'local',
        command: ['npx', '-y', '@playwright/mcp'],
        environment: undefined,
        enabled: true,
      },
    });
  });

  it('maps tool names back to canonical MCP names', () => {
    expect(canonicalOpenCodeTool('figma_get_screenshot', ['figma'])).toBe('mcp__figma__get_screenshot');
    expect(canonicalOpenCodeTool('read', ['figma'])).toBe('read');
  });

  it('parses run events: text, MCP tool results, step costs and errors', () => {
    const s = newOpenCodeState();
    const ev = (o: unknown): void => applyOpenCodeEvent(s, JSON.stringify(o), ['figma']);
    ev({ type: 'step_start', sessionID: 'ses_1', part: {} });
    ev({
      type: 'tool_use',
      sessionID: 'ses_1',
      part: {
        tool: 'figma_get_screenshot',
        state: { status: 'completed', input: { nodeId: '2:2' }, output: '{"image_url":"u"}' },
      },
    });
    ev({ type: 'tool_use', part: { tool: 'read', state: { status: 'error', input: {}, error: 'denied' } } });
    ev({ type: 'text', part: { text: '{"coupons":["SAVE10"]}' } });
    ev({ type: 'step_finish', part: { cost: 0.012, tokens: { input: 900, output: 40 }, reason: 'stop' } });
    applyOpenCodeEvent(s, 'not json', ['figma']);
    expect(s.sessionId).toBe('ses_1');
    expect(s.texts).toEqual(['{"coupons":["SAVE10"]}']);
    expect(s.toolCalls[0]).toMatchObject({
      name: 'mcp__figma__get_screenshot',
      input: { nodeId: '2:2' },
      isError: false,
    });
    expect(s.toolCalls[1]).toMatchObject({ name: 'read', text: 'denied', isError: true });
    expect(s).toMatchObject({ costUsd: 0.012, inputTokens: 900, outputTokens: 40, steps: 1 });
    // Recorded from a real run that hit the provider's usage limit.
    ev({
      type: 'error',
      error: { name: 'APIError', data: { message: 'The usage limit has been reached', statusCode: 429 } },
    });
    expect(s.errors).toEqual(['APIError: The usage limit has been reached']);
  });

  it('runs, asks for a correction on the same session when the answer is not valid, and validates', async () => {
    const calls: Array<{ args: string[]; input?: string; env?: NodeJS.ProcessEnv }> = [];
    const lines = [
      [
        { type: 'step_start', sessionID: 'ses_9', part: {} },
        { type: 'text', sessionID: 'ses_9', part: { text: 'The coupons are SAVE10 and WELCOME20.' } },
      ],
      [{ type: 'text', sessionID: 'ses_9', part: { text: '{"coupons":["SAVE10","WELCOME20"]}' } }],
    ];
    const exec = async (
      _cmd: string,
      args: readonly string[],
      opts: { input?: string; env?: NodeJS.ProcessEnv; onStdoutLine?: (l: string) => void },
    ): Promise<RunResult> => {
      calls.push({ args: [...args], input: opts.input, env: opts.env });
      for (const e of lines[calls.length - 1]!) opts.onStdoutLine?.(JSON.stringify(e));
      return { code: 0, stdout: '', stderr: '' };
    };
    const runner = new OpenCodeRunner(
      {
        provider: 'opencode',
        command: 'C:/bin/opencode.exe',
        model: 'openai/gpt-5.5',
        maxBudgetUsdPerTask: 1,
        transcriptDir: makeProject({}),
      },
      exec as never,
    );
    const res = await runner.run({
      name: 't',
      cwd: '.',
      prompt: 'List coupons',
      schema: Answer,
      images: ['shot.png'],
    });
    expect(res.output).toEqual({ coupons: ['SAVE10', 'WELCOME20'] });
    expect(calls[0]!.args).toEqual([
      'run',
      '--format',
      'json',
      '--agent',
      OPENCODE_AGENT,
      '-m',
      'openai/gpt-5.5',
      '-f',
      'shot.png',
    ]);
    expect(calls[0]!.input).toMatch(/List coupons[\s\S]*Output format \(mandatory\)/);
    expect(JSON.parse(calls[0]!.env!.OPENCODE_CONFIG_CONTENT!).agent[OPENCODE_AGENT].permission['*']).toBe(
      'deny',
    );
    expect(calls[1]!.args).toContain('--session');
    expect(calls[1]!.args).toContain('ses_9');
    expect(calls[1]!.input).toMatch(/could not be used/);
  });
});

describe('Codex', () => {
  it('registers MCP servers with -c overrides and allow-lists tools', () => {
    expect(
      codexMcpArgs(
        {
          figma: { type: 'http', url: 'https://mcp.figma.com/mcp' },
          pw: { command: 'npx', args: ['-y', '@playwright/mcp'], env: { DEBUG: '1' } },
        },
        ['mcp__figma__get_screenshot', 'mcp__figma__get_metadata', 'mcp__pw__*'],
      ),
    ).toEqual([
      '-c',
      'mcp_servers.figma.url="https://mcp.figma.com/mcp"',
      '-c',
      'mcp_servers.figma.enabled_tools=["get_screenshot","get_metadata"]',
      '-c',
      'mcp_servers.pw.command="npx"',
      '-c',
      'mcp_servers.pw.args=["-y","@playwright/mcp"]',
      '-c',
      'mcp_servers.pw.env={DEBUG = "1"}',
    ]);
  });

  it('parses exec events: final message, MCP calls, usage and failures', () => {
    const s = newCodexState();
    const ev = (o: unknown): void => applyCodexEvent(s, JSON.stringify(o));
    ev({ type: 'thread.started', thread_id: 't1' });
    ev({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'figma',
        tool: 'get_screenshot',
        arguments: { nodeId: '2:2' },
        result: {
          content: [
            { type: 'text', text: '{"image_url":"u"}' },
            { type: 'image', data: 'QUJD', mimeType: 'image/png' },
          ],
        },
        status: 'completed',
      },
    });
    ev({ type: 'item.completed', item: { type: 'agent_message', text: 'draft' } });
    ev({ type: 'item.completed', item: { type: 'agent_message', text: '{"coupons":[]}' } });
    ev({ type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 80 } });
    expect(s.lastMessage).toBe('{"coupons":[]}');
    expect(s.toolCalls[0]).toMatchObject({
      name: 'mcp__figma__get_screenshot',
      input: { nodeId: '2:2' },
      text: '{"image_url":"u"}\n',
      images: [{ mediaType: 'image/png', base64: 'QUJD' }],
      isError: false,
    });
    expect(s).toMatchObject({ inputTokens: 1200, outputTokens: 80, turns: 1 });
    ev({ type: 'turn.failed', error: { message: 'You exceeded your current quota' } });
    expect(s.errors).toEqual(['You exceeded your current quota']);
  });

  it('runs read-only with approvals off and re-runs with the rejected answer when invalid', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const answers = ['Sure! SAVE10.', '{"coupons":["SAVE10"]}'];
    const exec = async (
      _cmd: string,
      args: readonly string[],
      opts: { input?: string; onStdoutLine?: (l: string) => void },
    ): Promise<RunResult> => {
      calls.push({ args: [...args], input: opts.input });
      opts.onStdoutLine?.(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: answers[calls.length - 1] },
        }),
      );
      opts.onStdoutLine?.(
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
      );
      return { code: 0, stdout: '', stderr: '' };
    };
    const runner = new CodexRunner(
      {
        provider: 'codex',
        command: 'C:/bin/codex.exe',
        maxBudgetUsdPerTask: 1,
        transcriptDir: makeProject({}),
      },
      exec as never,
    );
    const res = await runner.run({ name: 't', cwd: 'D:/app', prompt: 'List coupons', schema: Answer });
    expect(res.output).toEqual({ coupons: ['SAVE10'] });
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(calls[0]!.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color',
      'never',
      '-C',
      'D:/app',
      '-c',
      'approval_policy="never"',
      '-',
    ]);
    expect(calls[1]!.input).toMatch(/Your previous final message\nSure! SAVE10\./);
  });
});

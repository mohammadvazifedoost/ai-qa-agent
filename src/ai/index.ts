import path from 'node:path';
import type { QaConfig } from '../config/schema.js';
import { resolveCommand, run } from '../core/process.js';
import { ClaudeRunner } from './claude.js';
import { CodexRunner } from './codex.js';
import type { AiEngine, Provider } from './engine.js';
import { OpenCodeRunner } from './opencode.js';

export type { AiEngine, Provider } from './engine.js';

const DEFAULT_COMMAND: Record<Provider, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
};
const DEFAULT_MODEL: Partial<Record<Provider, string>> = { 'claude-code': 'sonnet' };

/** The executable and model a provider will use, after defaults. */
export function engineSettings(config: QaConfig): { provider: Provider; command: string; model?: string } {
  const provider = config.ai.provider;
  const command =
    config.ai.command ??
    (provider === 'claude-code' ? config.ai.claudePath : undefined) ??
    DEFAULT_COMMAND[provider];
  return { provider, command, model: config.ai.model ?? DEFAULT_MODEL[provider] };
}

export function createEngine(config: QaConfig, logsDir: string): AiEngine {
  const s = engineSettings(config);
  const transcriptDir = path.join(logsDir, 'ai');
  const common = { ...s, maxBudgetUsdPerTask: config.ai.maxBudgetUsdPerTask, transcriptDir };
  switch (s.provider) {
    case 'claude-code':
      return new ClaudeRunner({
        claudePath: s.command,
        model: s.model ?? 'sonnet',
        maxBudgetUsdPerTask: config.ai.maxBudgetUsdPerTask,
        transcriptDir,
      });
    case 'codex':
      return new CodexRunner(common);
    case 'opencode':
      return new OpenCodeRunner(common);
  }
}

const LOGIN_HINT: Record<Provider, string> = {
  'claude-code': 'run `claude` once and log in',
  codex: 'run `codex login` (ChatGPT account) or set an API key with `codex login --with-api-key`',
  opencode: 'run `opencode auth login` and pick a provider',
};

/** Check that the provider's CLI is installed and, where the CLI can tell us cheaply, logged in. */
export async function checkProvider(config: QaConfig): Promise<{ ok: boolean; detail: string }> {
  const s = engineSettings(config);
  const { command, prefixArgs } = resolveCommand(s.command);
  const exec = (args: string[]): ReturnType<typeof run> => run(command, [...prefixArgs, ...args]);
  try {
    const v = await exec(['--version']);
    if (v.code !== 0)
      return { ok: false, detail: `${s.command} --version failed: ${v.stderr.trim() || v.stdout.trim()}` };
    const version = v.stdout.trim().split(/\r?\n/)[0] ?? '';
    const model = s.model ? `, model ${s.model}` : ', provider default model';
    if (s.provider === 'codex') {
      const status = await exec(['login', 'status']);
      if (status.code !== 0)
        return { ok: false, detail: `codex ${version} is not logged in — ${LOGIN_HINT.codex}` };
    }
    if (s.provider === 'opencode') {
      const auth = await exec(['auth', 'list']);
      if (auth.code === 0 && /0 credentials/i.test(auth.stdout)) {
        return { ok: false, detail: `opencode ${version} has no credentials — ${LOGIN_HINT.opencode}` };
      }
    }
    return { ok: true, detail: `${s.provider} (${s.command} ${version}${model})` };
  } catch (err) {
    return {
      ok: false,
      detail: `Could not execute "${s.command}" for provider ${s.provider}: ${(err as Error).message}. Install it, then ${LOGIN_HINT[s.provider]}.`,
    };
  }
}

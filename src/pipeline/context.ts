import path from 'node:path';
import { createEngine, type AiEngine } from '../ai/index.js';
import { loadConfig } from '../config/load.js';
import { loadLocalEnv } from '../config/local-env.js';
import type { QaConfig } from '../config/schema.js';
import { setLogFile } from '../core/logger.js';
import { qaPaths, type QaPaths } from '../core/paths.js';
import { StateStore } from '../state/state.js';

/** Everything a pipeline stage needs, loaded once per CLI invocation. */
export interface QaContext {
  root: string;
  paths: QaPaths;
  config: QaConfig;
  state: StateStore;
  ai: AiEngine;
}

/**
 * The same context, whose AI tasks stop when `signal` aborts. For work that a person can cancel
 * (dashboard jobs) around pipeline stages that do not take a signal themselves.
 */
export function withSignal(ctx: QaContext, signal: AbortSignal): QaContext {
  const ai: AiEngine = {
    provider: ctx.ai.provider,
    get totalCostUsd() {
      return ctx.ai.totalCostUsd;
    },
    set totalCostUsd(value: number) {
      ctx.ai.totalCostUsd = value;
    },
    run: (task) => ctx.ai.run({ ...task, signal: task.signal ?? signal }),
    toolRef: (server, tool) => ctx.ai.toolRef(server, tool),
  };
  return { ...ctx, ai };
}

export async function createContext(root: string): Promise<QaContext> {
  const paths = qaPaths(path.resolve(root));
  // Tokens saved by the dashboard (.qa/.env.local); a variable set in the shell wins.
  loadLocalEnv(paths.qaDir);
  const config = await loadConfig(paths.root);
  setLogFile(path.join(paths.logsDir, 'ai-qa-agent.log'));
  const ai = createEngine(config, paths.logsDir);
  return { root: paths.root, paths, config, state: new StateStore(paths.state), ai };
}

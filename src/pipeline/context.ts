import path from 'node:path';
import { createEngine, type AiEngine } from '../ai/index.js';
import { loadConfig } from '../config/load.js';
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

export async function createContext(root: string): Promise<QaContext> {
  const paths = qaPaths(path.resolve(root));
  const config = await loadConfig(paths.root);
  setLogFile(path.join(paths.logsDir, 'ai-qa-agent.log'));
  const ai = createEngine(config, paths.logsDir);
  return { root: paths.root, paths, config, state: new StateStore(paths.state), ai };
}

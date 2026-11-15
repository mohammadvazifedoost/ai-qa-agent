import fs from 'node:fs';
import { createJiti } from 'jiti';
import { QaConfigSchema, type QaConfig } from './schema.js';
import { qaPaths } from '../core/paths.js';

export class ConfigError extends Error {}

/** Load and validate `.qa/config.ts` from the given project root. */
export async function loadConfig(root: string): Promise<QaConfig> {
  const file = qaPaths(root).config;
  if (!fs.existsSync(file)) {
    throw new ConfigError(`No QA config found at ${file}. Run \`ai-qa-agent init\` first.`);
  }
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const mod = await jiti.import<{ default?: unknown }>(file);
  const raw = mod.default ?? mod;
  const parsed = QaConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid .qa/config.ts:\n${issues}`);
  }
  return applyEnvOverrides(parsed.data);
}

/**
 * Per-environment values that `config.ts` (committed, shared by every environment) cannot hold:
 * set them in the shell or in that machine's `.qa/.env.local`.
 */
export const ENV_OVERRIDES = {
  /** The project's name in the dashboard, reports and filed bugs. */
  projectName: 'AI_QA_PROJECT_NAME',
  /** Where the app is served in this environment (replaces `app.baseUrl`). */
  appUrl: 'AI_QA_APP_URL',
} as const;

export function applyEnvOverrides(config: QaConfig, env: NodeJS.ProcessEnv = process.env): QaConfig {
  const name = env[ENV_OVERRIDES.projectName]?.trim();
  const url = env[ENV_OVERRIDES.appUrl]?.trim();
  if (url && !/^https?:$/.test(URL.parse(url)?.protocol ?? ''))
    throw new ConfigError(
      `${ENV_OVERRIDES.appUrl} is not a valid URL: "${url}" (e.g. http://localhost:3000)`,
    );
  return {
    ...config,
    project: name ? { ...config.project, name } : config.project,
    app: url ? { ...config.app, baseUrl: url } : config.app,
  };
}

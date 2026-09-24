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
  return parsed.data;
}

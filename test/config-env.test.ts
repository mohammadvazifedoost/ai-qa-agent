import { describe, expect, it } from 'vitest';
import { applyEnvOverrides, ConfigError } from '../src/config/load.js';
import { QaConfigSchema } from '../src/config/schema.js';

const config = QaConfigSchema.parse({
  project: { name: 'vls-blog' },
  app: { baseUrl: 'http://localhost:3000' },
  source: { include: ['src'] },
});

describe('per-environment overrides of config.ts', () => {
  it('uses the project name and app URL of this environment when set', () => {
    const c = applyEnvOverrides(config, {
      AI_QA_PROJECT_NAME: ' VLS Blog (staging) ',
      AI_QA_APP_URL: 'https://staging.example.com',
    });
    expect(c.project.name).toBe('VLS Blog (staging)');
    expect(c.app.baseUrl).toBe('https://staging.example.com');
    // Everything else is still config.ts.
    expect(c.app.mode).toBe('production');
    expect(c.source.include).toEqual(['src']);
  });

  it('keeps config.ts when nothing (or only blanks) is set', () => {
    expect(applyEnvOverrides(config, {})).toEqual(config);
    expect(applyEnvOverrides(config, { AI_QA_PROJECT_NAME: ' ', AI_QA_APP_URL: '' })).toEqual(config);
  });

  it('refuses an app URL that is not a URL', () => {
    expect(() => applyEnvOverrides(config, { AI_QA_APP_URL: 'localhost:3000/x y' })).toThrow(ConfigError);
  });
});

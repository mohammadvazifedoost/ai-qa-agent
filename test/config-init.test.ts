import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QaConfigSchema } from '../src/config/schema.js';
import { initProject, renderConfig } from '../src/init/init.js';
import { detectProject } from '../src/discovery/detect.js';
import { makeProject } from './helpers.js';

const minimal = {
  project: { name: 'x' },
  app: { baseUrl: 'http://localhost:3000' },
  source: { include: ['src'] },
};

describe('QaConfigSchema', () => {
  it('applies sensible defaults', () => {
    const c = QaConfigSchema.parse(minimal);
    expect(c.browsers).toEqual(['chromium']);
    expect(Object.keys(c.viewports)).toEqual(['desktop', 'tablet', 'mobile']);
    expect(c.ai.model).toBe('sonnet');
    expect(c.clickup).toBeUndefined();
    expect(c.visual.acceptableDiffRatio).toBe(0.02);
  });

  it('rejects invalid figma node ids and non-kebab frame names', () => {
    const r = QaConfigSchema.safeParse({
      ...minimal,
      figma: {
        fileUrl: 'https://figma.com/design/abc',
        frames: [{ name: 'Home Page', nodeId: 'x', route: '/', viewport: 'desktop' }],
      },
    });
    expect(r.success).toBe(false);
  });
});

describe('init', () => {
  const pkg = {
    name: 'shop',
    scripts: { dev: 'vite --port 5173' },
    devDependencies: { vite: '6' },
    dependencies: { react: '19' },
  };

  it('renders a config that is valid against the schema', () => {
    const root = makeProject({ 'package.json': pkg, 'src/main.tsx': '' });
    const src = renderConfig(detectProject(root), {
      root,
      figmaUrl: 'https://www.figma.com/design/KEY/Shop',
      clickupListId: '123',
    });
    // Evaluate the object literal without the import line.
    const body = src.replace(/^import .*$/m, '').replace('export default defineConfig(', 'return (');
    const obj: unknown = new Function(body)();
    const parsed = QaConfigSchema.parse(obj);
    expect(parsed.app.baseUrl).toBe('http://localhost:5173');
    expect(parsed.app.startCommand).toBe('npm run dev');
    expect(parsed.clickup?.tokenEnv).toBe('CLICKUP_API_TOKEN');
    expect(Object.keys(parsed.ai.mcpServers)).toEqual(['figma', 'playwright']);
    expect(src).not.toMatch(/token\s*:/i); // no secrets are ever written
  });

  it('omits figma/clickup sections when not requested', () => {
    const root = makeProject({ 'package.json': pkg });
    const src = renderConfig(detectProject(root), { root });
    expect(src).not.toContain('figma');
    expect(src).not.toContain('clickup');
  });

  it('creates .qa files and refuses to overwrite without --force', () => {
    const root = makeProject({ 'package.json': pkg, 'src/main.tsx': '' });
    initProject({ root });
    for (const f of ['config.ts', 'rules.md', '.gitignore', 'project.json', 'scenarios', 'tests']) {
      expect(fs.existsSync(path.join(root, '.qa', f))).toBe(true);
    }
    expect(fs.readFileSync(path.join(root, '.qa', '.gitignore'), 'utf8')).toContain('artifacts/');
    expect(() => initProject({ root })).toThrow(/already exists/);
    expect(() => initProject({ root, force: true })).not.toThrow();
  });
});

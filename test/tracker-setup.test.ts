import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasConfigProperty, setConfigProperty, toSource } from '../src/config/edit.js';
import { loadConfig } from '../src/config/load.js';
import { loadLocalEnv, readLocalEnv, saveLocalEnv } from '../src/config/local-env.js';
import { qaPaths } from '../src/core/paths.js';
import type { QaContext } from '../src/pipeline/context.js';
import { StateStore } from '../src/state/state.js';
import { saveTracker, testTracker, trackerSettings } from '../src/ui/tracker-setup.js';
import { makeProject } from './helpers.js';

const CONFIG = `// The QA config of the shop.
export default {
  project: { name: 'shop' },
  app: { baseUrl: 'http://127.0.0.1:5173' },
  source: {
    include: ['src'], // where the pages are
  },
  /* trackers below */
  ai: { model: 'sonnet', note: 'a } brace in a string', mcpServers: {} },
};
`;

describe('editing .qa/config.ts', () => {
  it('adds a property at the end and keeps comments and everything else', () => {
    const out = setConfigProperty(
      CONFIG,
      'clickup',
      toSource({ listId: '901', tokenEnv: 'CLICKUP_API_TOKEN' }),
    );
    expect(out).toContain(`  ai: { model: 'sonnet', note: 'a } brace in a string', mcpServers: {} },
  clickup: {
    listId: "901",
    tokenEnv: "CLICKUP_API_TOKEN",
  },
};`);
    expect(out).toContain("include: ['src'], // where the pages are");
    expect(out.startsWith('// The QA config of the shop.')).toBe(true);
    expect(hasConfigProperty(out, 'clickup')).toBe(true);
  });

  it('replaces a property where it is, and only that one', () => {
    const once = setConfigProperty(CONFIG, 'clickup', '{ listId: "1" }');
    const twice = setConfigProperty(once, 'clickup', '{ listId: "2" }');
    expect(twice.match(/clickup:/g)).toHaveLength(1);
    expect(twice).toContain('clickup: { listId: "2" },');
    // A key inside a nested object is not a top-level property.
    expect(hasConfigProperty(CONFIG, 'model')).toBe(false);
    expect(setConfigProperty(CONFIG, 'source', '{ include: ["app"] }')).toContain(
      'source: { include: ["app"] },\n',
    );
  });

  it('works on defineConfig({ … }) without a trailing comma', () => {
    const src =
      "import { defineConfig } from 'x';\nexport default defineConfig({\n  project: { name: 'a' }\n});\n";
    expect(setConfigProperty(src, 'tracker', '"jira"')).toBe(
      "import { defineConfig } from 'x';\nexport default defineConfig({\n  project: { name: 'a' },\n  tracker: \"jira\",\n});\n",
    );
  });

  it('refuses a file without a config object', () => {
    expect(() => setConfigProperty('module.exports = 1;', 'x', '1')).toThrow(/config object/);
  });
});

describe('.qa/.env.local', () => {
  it('saves, merges, loads without overriding the shell, and is git-ignored', () => {
    const root = makeProject({ '.qa/.gitignore': 'artifacts/' });
    const qa = path.join(root, '.qa');
    const env: NodeJS.ProcessEnv = {};
    saveLocalEnv(qa, { A_TOKEN: 'one' }, env);
    saveLocalEnv(qa, { B_TOKEN: 'two' }, env);
    expect(readLocalEnv(qa)).toEqual({ A_TOKEN: 'one', B_TOKEN: 'two' });
    expect(env.A_TOKEN).toBe('one');
    expect(fs.readFileSync(path.join(qa, '.gitignore'), 'utf8')).toMatch(
      /^artifacts\/\n# .*\n\.env\.local\n$/,
    );

    const shell: NodeJS.ProcessEnv = { A_TOKEN: 'from-shell' };
    expect(loadLocalEnv(qa, shell)).toEqual(['B_TOKEN']);
    expect(shell).toEqual({ A_TOKEN: 'from-shell', B_TOKEN: 'two' });
    expect(() => saveLocalEnv(qa, { C: 'a\nb' }, env)).toThrow(/one line/);
  });
});

describe('connecting a bug tracker', () => {
  const setup = async () => {
    const root = makeProject({ '.qa/config.ts': CONFIG });
    const paths = qaPaths(root);
    const ctx = {
      root,
      paths,
      config: await loadConfig(root),
      state: new StateStore(paths.state),
      ai: null as never,
    } satisfies QaContext;
    return { root, ctx };
  };
  const calls: string[] = [];
  const clickup = (status = 200) =>
    (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        status === 200 ? JSON.stringify({ id: '901', name: 'Bugs' }) : '{"err":"Token invalid"}',
        {
          status,
        },
      );
    }) as typeof fetch;

  it('tests without saving, and says what to fix when the tracker refuses', async () => {
    const { ctx } = await setup();
    const env: NodeJS.ProcessEnv = {};
    const body = { kind: 'clickup', listId: '901', token: 'pk_1' };
    expect(await testTracker(ctx.config, body, { env, fetchImpl: clickup() })).toBe('list "Bugs" (901)');
    expect(calls.at(-1)).toMatch(/\/list\/901$/);
    expect(fs.readFileSync(ctx.paths.config, 'utf8')).toBe(CONFIG);
    expect(env).toEqual({});
    await expect(testTracker(ctx.config, body, { env, fetchImpl: clickup(401) })).rejects.toThrow(
      /did not accept the token/,
    );
    await expect(
      testTracker(ctx.config, { kind: 'clickup', listId: 'abc', token: 'x' }, { env }),
    ).rejects.toThrow(/list ID is a number/);
    await expect(testTracker(ctx.config, { kind: 'clickup', listId: '901' }, { env })).rejects.toThrow(
      /Enter the API token/,
    );
  });

  it('saves the list in config.ts and the token only in .qa/.env.local', async () => {
    const { ctx } = await setup();
    const env: NodeJS.ProcessEnv = {};
    const target = await saveTracker(
      ctx,
      { kind: 'clickup', listId: '901', status: 'to do', token: 'pk_secret' },
      { env, fetchImpl: clickup() },
    );
    expect(target).toBe('list "Bugs" (901)');
    const source = fs.readFileSync(ctx.paths.config, 'utf8');
    expect(source).toContain(
      'clickup: {\n    listId: "901",\n    tokenEnv: "CLICKUP_API_TOKEN",\n    status: "to do",\n  },',
    );
    expect(source).not.toContain('pk_secret');
    expect(source).not.toContain('tracker:');
    expect(readLocalEnv(ctx.paths.qaDir)).toEqual({ CLICKUP_API_TOKEN: 'pk_secret' });
    expect(ctx.config.clickup?.listId).toBe('901');
    expect(trackerSettings(ctx.config, env)).toMatchObject({
      active: 'clickup',
      clickup: { listId: '901', status: 'to do', tokenSet: true },
    });
  });

  it('switches to Jira: keeps the email out of config.ts and sets which tracker is used', async () => {
    const { ctx } = await setup();
    const env: NodeJS.ProcessEnv = {};
    await saveTracker(ctx, { kind: 'clickup', listId: '901', token: 'pk_1' }, { env, fetchImpl: clickup() });
    const jira = (async () =>
      new Response(JSON.stringify({ id: '1', key: 'SHOP', name: 'Shop' }), { status: 200 })) as typeof fetch;
    const target = await saveTracker(
      ctx,
      {
        kind: 'jira',
        baseUrl: 'https://acme.atlassian.net/',
        projectKey: 'shop',
        email: 'qa@acme.test',
        token: 'tok',
      },
      { env, fetchImpl: jira },
    );
    expect(target).toContain('project "Shop" (SHOP)');
    const source = fs.readFileSync(ctx.paths.config, 'utf8');
    expect(source).toContain('baseUrl: "https://acme.atlassian.net",');
    expect(source).toContain('projectKey: "SHOP",');
    expect(source).toContain('tracker: "jira",');
    expect(source).not.toContain('qa@acme.test');
    expect(readLocalEnv(ctx.paths.qaDir)).toEqual({
      CLICKUP_API_TOKEN: 'pk_1',
      JIRA_API_TOKEN: 'tok',
      JIRA_EMAIL: 'qa@acme.test',
    });
    expect(trackerSettings(ctx.config, env)).toMatchObject({
      active: 'jira',
      jira: { email: 'qa@acme.test', tokenSet: true },
    });
  });
});

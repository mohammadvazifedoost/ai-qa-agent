import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QaConfigSchema, type QaConfig } from '../src/config/schema.js';
import { detectProject } from '../src/discovery/detect.js';
import { renderConfig } from '../src/init/init.js';
import { renderPlaywrightConfig } from '../src/runner/playwright-config.js';
import {
  buildFingerprint,
  detectProductionCommands,
  fillCommand,
  freePort,
  productionPlan,
} from '../src/runner/production.js';
import {
  BuildError,
  describeTarget,
  ensureApp,
  EnvironmentError,
  type RunningApp,
} from '../src/runner/server.js';
import { makeProject } from './helpers.js';

const config = (app: Record<string, unknown> = {}): QaConfig =>
  QaConfigSchema.parse({
    project: { name: 'x' },
    app: { baseUrl: 'http://127.0.0.1:5173', ...app },
    source: { include: ['src'] },
  });

const info = (framework: string, scripts: Record<string, string>, packageManager = 'npm') =>
  ({ framework, scripts, packageManager }) as Parameters<typeof detectProductionCommands>[0];

describe('production commands per framework', () => {
  it('knows how the supported frameworks serve their build, on a port it is given', () => {
    expect(detectProductionCommands(info('next', { build: 'next build' }))).toMatchObject({
      buildCommand: 'npm run build',
      startCommand: 'npx next start -p {port} -H {host}',
    });
    expect(detectProductionCommands(info('vite', { build: 'vite build' }, 'pnpm'))).toMatchObject({
      buildCommand: 'pnpm run build',
      startCommand: 'pnpm exec vite preview --port {port} --host {host} --strictPort',
    });
    expect(detectProductionCommands(info('nuxt', { build: 'nuxt build' }))).toMatchObject({
      startCommand: 'node .output/server/index.mjs',
      portFromEnv: true,
    });
  });

  it('does not guess for frameworks without a production server', () => {
    const cra = detectProductionCommands(
      info('create-react-app', { build: 'x', start: 'react-scripts start' }),
    );
    // "start" is the dev server there: it must never be taken for the production server.
    expect(cra.startCommand).toBeNull();
    expect(cra.reason).toContain('no production server');
    expect(detectProductionCommands(info('unknown', { start: 'node x' })).startCommand).toBeNull();
    expect(detectProductionCommands(info('remix', { build: 'x' })).startCommand).toBeNull();
    expect(detectProductionCommands(info('remix', { build: 'x', start: 'remix-serve' })).startCommand).toBe(
      'npm run start',
    );
  });
});

describe('productionPlan', () => {
  const vite = info('vite', { build: 'vite build', dev: 'vite' });

  it('uses the detected commands on a free port by default', () => {
    expect(productionPlan('.', config(), vite)).toEqual({
      buildCommand: 'npm run build',
      startCommand: 'npx vite preview --port {port} --host {host} --strictPort',
      fixedUrl: null,
      source: 'detected',
    });
  });

  it('lets the config override the commands and pin the URL', () => {
    const fixed = productionPlan('.', config({ production: { startCommand: 'node server.js' } }), vite);
    // A command that cannot be told a port has to answer at the configured URL.
    expect(fixed).toMatchObject({
      startCommand: 'node server.js',
      fixedUrl: 'http://127.0.0.1:5173',
      source: 'config',
    });
    const pinned = productionPlan(
      '.',
      config({
        production: {
          startCommand: 'serve -l {port}',
          baseUrl: 'http://127.0.0.1:4000',
          buildCommand: false,
        },
      }),
      vite,
    );
    expect(pinned).toMatchObject({ buildCommand: null, fixedUrl: 'http://127.0.0.1:4000' });
  });

  it('explains why production testing is not possible instead of falling back to the dev server', () => {
    const cra = info('create-react-app', { build: 'react-scripts build', start: 'react-scripts start' });
    expect(() => productionPlan('.', config({ startCommand: 'npm start' }), cra)).toThrow(EnvironmentError);
    expect(() => productionPlan('.', config(), cra)).toThrow(
      /not possible.*no production server.*app\.production\.startCommand/s,
    );
    expect(() => productionPlan('.', config(), info('vite', { dev: 'vite' }))).toThrow(/no "build" script/);
  });
});

describe('helpers', () => {
  it('fills in the port and host', () => {
    expect(fillCommand('serve -l {port} -H {host} # {port}', '127.0.0.1', 4010)).toBe(
      'serve -l 4010 -H 127.0.0.1 # 4010',
    );
  });

  it('finds a free port', async () => {
    const port = await freePort('127.0.0.1');
    expect(port).toBeGreaterThan(1024);
  });

  it('fingerprints the build inputs, not dependencies or build output', () => {
    const root = makeProject({
      'package.json': '{}',
      'src/a.ts': 'a',
      '.env.production': 'X=1',
      'node_modules/x/index.js': 'x',
      'dist/out.js': 'out',
    });
    const plan = productionPlan(root, config(), info('vite', { build: 'vite build' }));
    const before = buildFingerprint(root, config(), plan);
    fs.writeFileSync(path.join(root, 'node_modules/x/index.js'), 'changed');
    fs.writeFileSync(path.join(root, 'dist/out.js'), 'changed too');
    // Written by the Playwright MCP while tests are generated; must not force a rebuild.
    fs.mkdirSync(path.join(root, '.playwright-mcp'));
    fs.writeFileSync(path.join(root, '.playwright-mcp/page.yml'), 'snapshot');
    expect(buildFingerprint(root, config(), plan)).toBe(before);
    fs.writeFileSync(path.join(root, '.env.production'), 'X=22');
    const afterEnv = buildFingerprint(root, config(), plan);
    expect(afterEnv).not.toBe(before);
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'a changed');
    expect(buildFingerprint(root, config(), plan)).not.toBe(afterEnv);
  });

  it('describes what a run tested without overstating it', () => {
    expect(describeTarget({ url: 'http://x', mode: 'production', build: 'built' })).toBe(
      'http://x (production build)',
    );
    expect(describeTarget({ url: 'http://x', mode: 'development', build: 'none' })).toContain(
      'not production-validated',
    );
    expect(describeTarget({ url: 'http://x', mode: 'production', build: 'existing-server' })).toContain(
      'already running',
    );
  });
});

describe('generated configs', () => {
  it('lets the runner point Playwright at the server it started', () => {
    expect(renderPlaywrightConfig(config())).toContain(
      'baseURL: process.env.AI_QA_BASE_URL ?? "http://127.0.0.1:5173"',
    );
  });

  it('tests the production build by default and keeps the dev command for development mode', () => {
    expect(config().app.mode).toBe('production');
    const root = makeProject({
      'package.json': {
        name: 'shop',
        scripts: { dev: 'vite', build: 'vite build' },
        devDependencies: { vite: '6' },
      },
    });
    const src = renderConfig(detectProject(root), { root });
    expect(src).toContain('Tests run against a production build: "npm run build", then "npx vite preview');
    expect(src).toContain('startCommand: "npm run dev"');
    const noBuild = makeProject({
      'package.json': {
        name: 'shop',
        scripts: { start: 'react-scripts start' },
        dependencies: { 'react-scripts': '5' },
      },
    });
    expect(renderConfig(detectProject(noBuild), { root: noBuild })).toContain('could not be worked out');
  });
});

/** A tiny app with a real build step and a real server, to exercise the whole production path. */
function app(build = 'ok'): string {
  return makeProject({
    'package.json': { name: 'tiny', scripts: { build: 'node build.js' } },
    'src/page.txt': 'v1',
    'build.js':
      build === 'ok'
        ? `const fs = require('fs');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', 'built from ' + fs.readFileSync('src/page.txt', 'utf8'));
fs.appendFileSync('builds.log', 'build\\n');`
        : `console.error('src/page.txt(3,1): error TS1005: this is the real build error'); process.exit(2);`,
    'server.js': `const http = require('http'); const fs = require('fs');
const html = fs.readFileSync('dist/index.html'); // like a real server: no build output, no start
http.createServer((req, res) => res.end(html)).listen(Number(process.argv[2]), '127.0.0.1');`,
    'dev.js': `const http = require('http');
http.createServer((req, res) => res.end('dev server')).listen(Number(process.argv[2]), '127.0.0.1');`,
  });
}

describe('ensureApp', () => {
  const running: RunningApp[] = [];
  afterEach(() => {
    for (const a of running.splice(0)) a.stop();
  });
  const start = async (root: string, c: QaConfig): Promise<RunningApp> => {
    const a = await ensureApp(root, c, path.join(root, '.qa', 'artifacts', 'logs', 'app-server.log'));
    running.push(a);
    return a;
  };
  const builds = (root: string): number =>
    fs.existsSync(path.join(root, 'builds.log'))
      ? fs.readFileSync(path.join(root, 'builds.log'), 'utf8').trim().split('\n').length
      : 0;
  const prod = { production: { startCommand: 'node server.js {port}' } };

  it('builds the app, serves the build on its own port, and rebuilds only when the project changed', async () => {
    const root = app();
    const first = await start(root, config(prod));
    expect(first).toMatchObject({ mode: 'production', build: 'built', owned: true });
    expect(first.url).not.toBe('http://127.0.0.1:5173'); // not the dev URL: a free port
    expect(await (await fetch(first.url)).text()).toBe('built from v1');
    first.stop();

    const second = await start(root, config(prod));
    expect(second.build).toBe('cached');
    expect(builds(root)).toBe(1);
    second.stop();

    fs.writeFileSync(path.join(root, 'src/page.txt'), 'version two');
    const third = await start(root, config(prod));
    expect(third.build).toBe('built');
    expect(await (await fetch(third.url)).text()).toBe('built from version two');
    expect(builds(root)).toBe(2);
  }, 60_000);

  it('rebuilds when the cached build can no longer be served', async () => {
    const root = app();
    (await start(root, config(prod))).stop();
    fs.rmSync(path.join(root, 'dist'), { recursive: true });
    const again = await start(root, config(prod));
    expect(again.build).toBe('built');
    expect(builds(root)).toBe(2);
    expect(await (await fetch(again.url)).text()).toBe('built from v1');
  }, 60_000);

  it('reports the real build failure and does not start anything', async () => {
    const root = app('broken');
    const err = await start(root, config(prod)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildError);
    expect((err as Error).message).toContain('exited with code 2');
    expect((err as Error).message).toContain('this is the real build error');
    expect((err as Error).message).toContain('Tests were not run');
  }, 60_000);

  it('never falls back to the dev server when production mode is not possible', async () => {
    const root = app();
    // A dev command is configured and would work, but the mode is production and the framework is unknown.
    const err = await start(root, config({ startCommand: 'node dev.js 5999' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as Error).message).toContain('Production-mode testing is not possible');
    expect(builds(root)).toBe(0);
  });

  it('refuses a fixed production URL that something else already answers at', async () => {
    const root = app();
    const port = await freePort('127.0.0.1');
    const url = `http://127.0.0.1:${port}`;
    const dev = await start(
      root,
      config({ mode: 'development', baseUrl: url, startCommand: `node dev.js ${port}` }),
    );
    expect(dev).toMatchObject({ mode: 'development', build: 'none', url });
    const fixed = { production: { startCommand: `node server.js ${port}`, baseUrl: url } };
    await expect(start(root, config(fixed))).rejects.toThrow(/cannot be verified to be a production build/);
    const reused = await start(
      root,
      config({ production: { ...fixed.production, reuseExistingServer: true } }),
    );
    expect(reused).toMatchObject({ mode: 'production', build: 'existing-server', owned: false });
  }, 60_000);
});

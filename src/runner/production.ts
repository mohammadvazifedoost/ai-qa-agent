/**
 * Production-mode testing: how the app is built and served the way it is deployed, instead of
 * through its development server (which compiles pages on demand and makes tests slow and flaky).
 * Everything here is deterministic: the commands come from the config or from the project's
 * framework and scripts, never from a guess, and a project that cannot be served in production
 * mode gets an error that says why.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { QaConfig } from '../config/schema.js';
import { detectProject, type ProjectInfo } from '../discovery/detect.js';

/** The app or its environment is not usable for testing (not a product bug, not a test bug). */
export class EnvironmentError extends Error {}

/** The production build command failed; the message carries the end of its output. */
export class BuildError extends EnvironmentError {}

export interface ProductionPlan {
  /** Null when there is nothing to build (`production.buildCommand: false`). */
  buildCommand: string | null;
  /** May contain `{port}` and `{host}`. */
  startCommand: string;
  /** Set when the server must answer at one URL; otherwise a free port is chosen for each start. */
  fixedUrl: string | null;
  /** Where the commands come from, for logs and `doctor`. */
  source: 'config' | 'detected';
}

type Detection = Pick<ProjectInfo, 'framework' | 'scripts' | 'packageManager'>;

/** Runs a `package.json` script / a dependency's binary with the project's package manager. */
function runners(pm: ProjectInfo['packageManager']): { script: string; bin: string } {
  switch (pm) {
    case 'pnpm':
      return { script: 'pnpm run', bin: 'pnpm exec' };
    case 'yarn':
      return { script: 'yarn run', bin: 'yarn run' };
    case 'bun':
      return { script: 'bun run', bin: 'bunx' };
    default:
      return { script: 'npm run', bin: 'npx' };
  }
}

/**
 * The standard way to build and serve a production build of each supported framework. `start` is
 * null (with the reason) for frameworks that have no production server of their own.
 */
export function detectProductionCommands(info: Detection): {
  buildCommand: string | null;
  startCommand: string | null;
  /** True when the start command takes its port from the PORT environment variable. */
  portFromEnv: boolean;
  reason?: string;
} {
  const { script, bin } = runners(info.packageManager);
  const buildCommand = info.scripts.build ? `${script} build` : null;
  const none = (reason: string) => ({ buildCommand, startCommand: null, portFromEnv: false, reason });
  const cmd = (startCommand: string, portFromEnv = false) => ({ buildCommand, startCommand, portFromEnv });
  switch (info.framework) {
    case 'next':
      return cmd(`${bin} next start -p {port} -H {host}`);
    case 'vite':
    case 'sveltekit':
      return cmd(`${bin} vite preview --port {port} --host {host} --strictPort`);
    case 'astro':
      return cmd(`${bin} astro preview --port {port} --host {host}`);
    case 'gatsby':
      return cmd(`${bin} gatsby serve -p {port} -H {host}`);
    case 'nuxt':
      return cmd('node .output/server/index.mjs', true);
    case 'remix':
    case 'react-router':
      return info.scripts.start
        ? cmd(`${script} start`, true)
        : none(`${info.framework} serves its build with a "start" script, and package.json has none`);
    case 'angular':
    case 'create-react-app':
      return none(
        `${info.framework} builds static files but has no production server of its own (e.g. use "npx serve -s <output dir> -l {port}")`,
      );
    default:
      return none('the framework could not be detected, so the command that serves the build is unknown');
  }
}

const HOW_TO_FIX =
  "Set app.production.startCommand (and buildCommand) in .qa/config.ts, using {port} and {host} where the command takes them. To test the dev server instead, set app.mode: 'development' explicitly; results are then reported as not production-validated.";

/**
 * Work out how to build and serve the app in production mode: the config wins, the project's
 * framework and scripts fill the gaps. Throws {@link EnvironmentError} when that is not possible.
 */
export function productionPlan(
  root: string,
  config: QaConfig,
  info: Detection = detectProject(root),
): ProductionPlan {
  const p = config.app.production;
  const detected = detectProductionCommands(info);
  const startCommand = p.startCommand ?? detected.startCommand;
  if (!startCommand) {
    throw new EnvironmentError(`Production-mode testing is not possible: ${detected.reason}. ${HOW_TO_FIX}`);
  }
  const buildCommand = p.buildCommand === false ? null : (p.buildCommand ?? detected.buildCommand);
  if (buildCommand === null && p.buildCommand !== false) {
    throw new EnvironmentError(
      `Production-mode testing is not possible: package.json has no "build" script, so the production build command is unknown. Set app.production.buildCommand in .qa/config.ts (or false when there is nothing to build). To test the dev server instead, set app.mode: 'development' explicitly; results are then reported as not production-validated.`,
    );
  }
  // A free port needs a command that can be told the port: a placeholder, or (detected only) PORT.
  const takesPort = startCommand.includes('{port}') || (!p.startCommand && detected.portFromEnv);
  const fixedUrl = p.baseUrl ?? (takesPort ? null : config.app.baseUrl);
  return { buildCommand, startCommand, fixedUrl, source: p.startCommand ? 'config' : 'detected' };
}

/** One line for logs and `doctor`. */
export function describePlan(plan: ProductionPlan): string {
  const build = plan.buildCommand ? `build with "${plan.buildCommand}"` : 'no build step';
  return `${build}, serve with "${plan.startCommand}" ${plan.fixedUrl ? `at ${plan.fixedUrl}` : 'on a free port'} (${plan.source})`;
}

export function fillCommand(command: string, host: string, port: number): string {
  return command.replaceAll('{port}', String(port)).replaceAll('{host}', host);
}

/** A port nothing listens on, on the given host. */
export function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host === 'localhost' ? undefined : host, () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('Could not find a free port'))));
    });
  });
}

/**
 * Directories that never are build inputs: dependencies, VCS, QA data, what test tools write
 * while they run (the Playwright MCP saves page snapshots to `.playwright-mcp`) and common build
 * outputs.
 */
const NOT_INPUT = [
  'node_modules',
  '.git',
  '.qa',
  '.playwright-mcp',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.angular',
  '.cache',
  '.turbo',
  '.vercel',
  '.netlify',
  'test-results',
  'playwright-report',
];

/**
 * Fingerprint of everything a build can depend on: every file of the project outside dependency
 * and output directories (path, size, modification time), plus the build command and environment.
 * The same fingerprint means the last successful build is still current.
 */
export function buildFingerprint(root: string, config: QaConfig, plan: ProductionPlan): string {
  const skip = new Set([...NOT_INPUT, ...config.source.exclude]);
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ build: plan.buildCommand, env: config.app.env ?? {} }));
  const walk = (dir: string): void => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const st = fs.statSync(full);
        h.update(`${path.relative(root, full)}\0${st.size}\0${Math.round(st.mtimeMs)}\0`);
      }
    }
  };
  walk(root);
  return h.digest('hex');
}

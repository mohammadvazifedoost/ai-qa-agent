import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { QaConfig } from '../config/schema.js';
import { ensureDir, readJson, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { qaPaths, rel } from '../core/paths.js';
import { Cancelled, killTree, run } from '../core/process.js';
import { z } from 'zod';
import {
  BuildError,
  buildFingerprint,
  describePlan,
  EnvironmentError,
  fillCommand,
  freePort,
  productionPlan,
  type ProductionPlan,
} from './production.js';

export { BuildError, EnvironmentError } from './production.js';

const log = logger('server');

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** What the tests ran against; stored with the results so a report never overstates it. */
export interface AppTarget {
  url: string;
  mode: 'production' | 'development';
  /**
   * `built`: built for this run. `cached`: the last build, nothing changed since. `none`: no build
   * step. `existing-server`: a server that was already running (its build cannot be verified).
   */
  build: 'built' | 'cached' | 'none' | 'existing-server';
}

export interface RunningApp extends AppTarget {
  /** True if we started it (and must stop it). */
  owned: boolean;
  stop(): void;
}

/** One line describing the target, for logs and reports. */
export function describeTarget(t: AppTarget): string {
  if (t.mode === 'development') return `${t.url} (development server — not production-validated)`;
  if (t.build === 'existing-server') return `${t.url} (production server that was already running)`;
  return `${t.url} (production build${t.build === 'cached' ? ', unchanged since the last build' : ''})`;
}

interface Started {
  child: ChildProcess;
  stop(): void;
}

/** Start a server command and wait until it answers at `url`. */
async function startServer(
  command: string,
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    url: string;
    logFile: string;
    timeoutMs: number;
    label: string;
  },
): Promise<Started> {
  ensureDir(path.dirname(opts.logFile));
  const out = fs.openSync(opts.logFile, 'a');
  log.info(`Starting ${opts.label}: ${command}`);
  const child: ChildProcess = spawn(command, {
    cwd: opts.cwd,
    shell: true,
    env: opts.env,
    stdio: ['ignore', out, out],
    detached: process.platform !== 'win32',
  });
  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? -1));
  const stop = (): void => {
    killTree(child);
    try {
      fs.closeSync(out);
    } catch {
      // already closed
    }
  };

  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) {
      stop();
      throw new EnvironmentError(
        `The ${opts.label} command "${command}" exited with code ${exited} before the app answered at ${opts.url}.${logTail(opts.logFile)}`,
      );
    }
    if (await isUp(opts.url)) {
      log.info(`App is ready at ${opts.url}`);
      return { child, stop };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new EnvironmentError(
    `App did not become ready at ${opts.url} within ${opts.timeoutMs}ms. See ${opts.logFile}.${await loopbackHint(opts.url)}`,
  );
}

function tail(text: string, lines: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join('\n');
}

function logTail(file: string): string {
  try {
    const text = tail(fs.readFileSync(file, 'utf8'), 20);
    return text ? `\nLast output (${file}):\n${text}` : ` See ${file}.`;
  } catch {
    return ` See ${file}.`;
  }
}

const BuildRecordSchema = z.object({ fingerprint: z.string(), builtAt: z.string(), command: z.string() });

/**
 * Build the app for production unless the last successful build is still current. Throws
 * {@link BuildError} with the real output of the build when it fails.
 */
async function buildApp(
  root: string,
  config: QaConfig,
  plan: ProductionPlan,
  logFile: string,
  force: boolean,
): Promise<'built' | 'cached' | 'none'> {
  if (!plan.buildCommand) return 'none';
  const record = path.join(qaPaths(root).artifactsDir, 'production-build.json');
  if (!force) {
    const last = readJson(record, BuildRecordSchema);
    if (last && last.fingerprint === buildFingerprint(root, config, plan)) {
      log.info(`Production build is up to date (built ${last.builtAt}); not rebuilding`);
      return 'cached';
    }
  }
  const buildLog = path.join(path.dirname(logFile), 'app-build.log');
  log.info(`Building the app for production: ${plan.buildCommand}`);
  const started = Date.now();
  let res;
  try {
    res = await run(plan.buildCommand, [], {
      cwd: root,
      shell: true,
      env: { ...process.env, NODE_ENV: 'production', ...config.app.env },
      signal: AbortSignal.timeout(config.app.production.buildTimeoutMs),
    });
  } catch (err) {
    if (err instanceof Cancelled) {
      throw new BuildError(
        `The production build "${plan.buildCommand}" did not finish within ${config.app.production.buildTimeoutMs}ms (app.production.buildTimeoutMs).`,
      );
    }
    throw new BuildError(
      `The production build "${plan.buildCommand}" could not be started: ${(err as Error).message}`,
    );
  }
  const output = `${res.stdout}\n${res.stderr}`;
  ensureDir(path.dirname(buildLog));
  fs.writeFileSync(buildLog, output);
  if (res.code !== 0) {
    throw new BuildError(
      `The production build failed: "${plan.buildCommand}" exited with code ${res.code}. Tests were not run.\nLast output (${buildLog}):\n${tail(output, 40)}`,
    );
  }
  // Fingerprinted after the build, so files the build itself rewrites do not force the next rebuild.
  writeJson(record, {
    fingerprint: buildFingerprint(root, config, plan),
    builtAt: new Date().toISOString(),
    command: plan.buildCommand,
  });
  log.info(`Production build finished in ${Math.round((Date.now() - started) / 1000)}s`);
  return 'built';
}

async function ensureProductionApp(root: string, config: QaConfig, logFile: string): Promise<RunningApp> {
  const plan = productionPlan(root, config);
  log.info(`Production mode: ${describePlan(plan)}`);
  const { production, startTimeoutMs, env } = config.app;

  let url: string;
  if (plan.fixedUrl) {
    url = plan.fixedUrl;
    if (await isUp(url)) {
      if (production.reuseExistingServer) {
        log.warn(
          `Using the server already running at ${url} as the production server (app.production.reuseExistingServer). It was not built by this run.`,
        );
        return { url, mode: 'production', build: 'existing-server', owned: false, stop: () => undefined };
      }
      throw new EnvironmentError(
        `Something already answers at ${url}, and it cannot be verified to be a production build (it may be a dev server). Stop it, give the production server its own port with {port} in app.production.startCommand, or set app.production.reuseExistingServer: true if it is a production server.`,
      );
    }
  } else {
    const base = new URL(config.app.baseUrl);
    url = `${base.protocol}//${base.host.replace(/:\d+$/, '')}:${await freePort(base.hostname)}`;
  }
  const target = new URL(url);
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const command = fillCommand(plan.startCommand, target.hostname, port);
  const start = (): Promise<Started> =>
    startServer(command, {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        HOST: target.hostname,
        ...env,
        BROWSER: 'none',
      },
      url,
      logFile,
      timeoutMs: startTimeoutMs,
      label: 'production server',
    });

  let build = await buildApp(root, config, plan, logFile, false);
  let server: Started;
  try {
    server = await start();
  } catch (err) {
    // A cached build whose output was deleted cannot be served: build again, once.
    if (build !== 'cached') throw err;
    log.warn(
      `The production server did not start from the existing build; rebuilding. (${(err as Error).message.split('\n')[0]})`,
    );
    build = await buildApp(root, config, plan, logFile, true);
    server = await start();
  }
  return { url, mode: 'production', build, owned: true, stop: server.stop };
}

async function ensureDevelopmentApp(root: string, config: QaConfig, logFile: string): Promise<RunningApp> {
  const { baseUrl, startCommand, startTimeoutMs, reuseExistingServer, env } = config.app;
  log.warn(
    "Testing the development server (app.mode: 'development'). Results are not production-validated; pages compile on demand, which can slow tests down and cause false failures.",
  );
  if (reuseExistingServer && (await isUp(baseUrl))) {
    log.info(`Using already running app at ${baseUrl}`);
    return { url: baseUrl, mode: 'development', build: 'none', owned: false, stop: () => undefined };
  }
  if (!startCommand) {
    throw new EnvironmentError(`App is not reachable at ${baseUrl} and no app.startCommand is configured.`);
  }
  const server = await startServer(startCommand, {
    cwd: root,
    env: { ...process.env, ...env, BROWSER: 'none' },
    url: baseUrl,
    logFile,
    timeoutMs: startTimeoutMs,
    label: 'dev server',
  });
  return { url: baseUrl, mode: 'development', build: 'none', owned: true, stop: server.stop };
}

/**
 * Make the app available for tests and for the agents that inspect it. By default this is a
 * production build: built (unless unchanged since the last build), served on its own port and
 * stopped afterwards. The dev server is used only when the config says `app.mode: 'development'`;
 * a failing production build or an undetectable production setup is an error, never a fallback.
 */
export async function ensureApp(root: string, config: QaConfig, logFile: string): Promise<RunningApp> {
  const app =
    config.app.mode === 'development'
      ? await ensureDevelopmentApp(root, config, logFile)
      : await ensureProductionApp(root, config, logFile);
  log.info(`Testing against ${describeTarget(app)}; server log: ${rel(root, logFile)}`);
  return app;
}

/**
 * A common cause of "server started but not reachable": `localhost` resolves to IPv6 (::1) for the
 * dev server but IPv6 loopback is blocked (or vice versa). Probe both and explain what works.
 */
export async function loopbackHint(baseUrl: string): Promise<string> {
  const url = new URL(baseUrl);
  if (url.hostname !== 'localhost') return '';
  const probe = async (host: string): Promise<string> => {
    const u = new URL(baseUrl);
    u.hostname = host;
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(2000) });
      return `HTTP ${res.status}`;
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      return cause ?? (err as Error).message;
    }
  };
  const [v4, v6] = await Promise.all([probe('127.0.0.1'), probe('[::1]')]);
  return (
    ` Loopback probe: 127.0.0.1 → ${v4}, [::1] → ${v6}.` +
    ` If only one address family works, bind the dev server explicitly (e.g. \`--host 127.0.0.1\`)` +
    ` and set app.baseUrl to http://127.0.0.1:${url.port || '80'}.`
  );
}

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { QaConfig } from '../config/schema.js';
import { ensureDir } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { killTree } from '../core/process.js';

const log = logger('server');

export class EnvironmentError extends Error {}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

export interface RunningApp {
  url: string;
  /** True if we started it (and must stop it). */
  owned: boolean;
  stop(): void;
}

/** Make sure the app answers at `baseUrl`, starting it with `startCommand` if needed. */
export async function ensureApp(root: string, config: QaConfig, logFile: string): Promise<RunningApp> {
  const { baseUrl, startCommand, startTimeoutMs, reuseExistingServer, env } = config.app;
  if (reuseExistingServer && (await isUp(baseUrl))) {
    log.info(`Using already running app at ${baseUrl}`);
    return { url: baseUrl, owned: false, stop: () => undefined };
  }
  if (!startCommand) {
    throw new EnvironmentError(`App is not reachable at ${baseUrl} and no app.startCommand is configured.`);
  }
  ensureDir(path.dirname(logFile));
  const out = fs.openSync(logFile, 'a');
  log.info(`Starting app: ${startCommand}`);
  const child: ChildProcess = spawn(startCommand, {
    cwd: root,
    shell: true,
    env: { ...process.env, ...env, BROWSER: 'none' },
    stdio: ['ignore', out, out],
    detached: process.platform !== 'win32',
  });
  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? -1));

  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new EnvironmentError(`App start command exited with code ${exited}. See ${logFile}`);
    }
    if (await isUp(baseUrl)) {
      log.info(`App is ready at ${baseUrl}`);
      return {
        url: baseUrl,
        owned: true,
        stop: () => {
          killTree(child);
          fs.closeSync(out);
        },
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  killTree(child);
  throw new EnvironmentError(
    `App did not become ready at ${baseUrl} within ${startTimeoutMs}ms. See ${logFile}.${await loopbackHint(baseUrl)}`,
  );
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

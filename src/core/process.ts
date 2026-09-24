import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A run stopped through its AbortSignal (e.g. the dashboard's Cancel button). */
export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'Cancelled';
  }
}

/**
 * Run a command to completion, capturing output. Never rejects on non-zero exit. With `signal`,
 * aborting kills the whole process tree (browsers, dev servers) and rejects with {@link Cancelled}.
 */
export function run(
  command: string,
  args: readonly string[],
  opts: Omit<SpawnOptions, 'signal'> & {
    input?: string;
    onStdoutLine?: (line: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<RunResult> {
  const { signal, ...spawnOpts } = opts;
  if (signal?.aborted) return Promise.reject(new Cancelled());
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...spawnOpts,
      // Its own process group elsewhere than Windows, so the whole tree can be killed on abort.
      detached: spawnOpts.detached ?? (!!signal && process.platform !== 'win32'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (opts.onStdoutLine) {
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const l of lines) opts.onStdoutLine(l);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(aborted ? new Cancelled() : err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (aborted) return reject(new Cancelled());
      if (pending && opts.onStdoutLine) opts.onStdoutLine(pending);
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/**
 * Resolve a command so it can be spawned without a shell. On Windows, globally installed npm CLIs
 * are `.cmd` shims that `spawn` cannot execute directly; we read the shim to find the real target
 * (`.exe` → run it, `.js` → run it with this Node). Returns the command unchanged elsewhere or
 * when nothing better is found.
 */
export function resolveCommand(
  command: string,
  opts: { platform?: NodeJS.Platform; pathEnv?: string; readFile?: (p: string) => string | undefined } = {},
): { command: string; prefixArgs: string[] } {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' || /[\\/]/.test(command) || /\.(exe|com)$/i.test(command)) {
    return { command, prefixArgs: [] };
  }
  const readFile =
    opts.readFile ??
    ((p: string): string | undefined => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    });
  const exists = (p: string): boolean => readFile(p) !== undefined || fs.existsSync(p);
  const dirs = (opts.pathEnv ?? process.env.PATH ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, `${command}.exe`);
    if (fs.existsSync(exe)) return { command: exe, prefixArgs: [] };
    const shim = readFile(path.join(dir, `${command}.cmd`));
    if (shim === undefined) continue;
    const target = shim.match(/"%dp0%\\([^"]+\.(exe|js|cjs|mjs))"/i);
    if (target) {
      const abs = path.join(dir, target[1]!);
      if (target[2]!.toLowerCase() === 'exe') return { command: abs, prefixArgs: [] };
      if (exists(abs)) return { command: process.execPath, prefixArgs: [abs] };
    }
  }
  return { command, prefixArgs: [] };
}

/** Kill a process and all of its children (dev servers spawn grandchildren). */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = process.env.AI_QA_DEBUG ? 'debug' : 'info';
let logFile: string | undefined;

/** Mirror all log lines (including debug) into a file, e.g. `.qa/artifacts/logs/ai-qa.log`. */
export function setLogFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  logFile = file;
}

export function setLogLevel(level: Level): void {
  minLevel = level;
}

function write(level: Level, scope: string, msg: string, data?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${msg}${
    data === undefined ? '' : ' ' + JSON.stringify(data)
  }`;
  if (logFile) fs.appendFileSync(logFile, line + '\n');
  if (ORDER[level] < ORDER[minLevel]) return;
  const color = { debug: pc.gray, info: pc.cyan, warn: pc.yellow, error: pc.red }[level];
  const out = `${color(level === 'info' ? '›' : level.toUpperCase())} ${pc.dim(scope)} ${msg}`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(out + '\n');
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, d) => write('debug', scope, m, d),
    info: (m, d) => write('info', scope, m, d),
    warn: (m, d) => write('warn', scope, m, d),
    error: (m, d) => write('error', scope, m, d),
  };
}

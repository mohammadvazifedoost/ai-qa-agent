/**
 * Secrets saved on this computer only: `.qa/.env.local`, one `NAME=value` per line. The dashboard
 * writes bug-tracker tokens here so they never go into `config.ts`, which is committed. A variable
 * already set in the shell always wins over the file.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LOCAL_ENV_FILE = '.env.local';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function readLocalEnv(qaDir: string): Record<string, string> {
  const file = path.join(qaDir, LOCAL_ENV_FILE);
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const name = line.slice(0, eq).trim();
    if (NAME.test(name)) out[name] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Put the saved values into `env` where the shell did not set them. Returns the names it set. */
export function loadLocalEnv(qaDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const set: string[] = [];
  for (const [name, value] of Object.entries(readLocalEnv(qaDir))) {
    if (env[name] === undefined || env[name] === '') {
      env[name] = value;
      set.push(name);
    }
  }
  return set;
}

/**
 * Save values (merged with what the file holds) and apply them to `env` at once. The file is
 * listed in `.qa/.gitignore` so it cannot be committed by accident.
 */
export function saveLocalEnv(
  qaDir: string,
  values: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [name, value] of Object.entries(values)) {
    if (!NAME.test(name)) throw new Error(`Not a valid variable name: ${name}`);
    if (/[\r\n]/.test(value)) throw new Error(`The value of ${name} must be on one line`);
  }
  const merged = { ...readLocalEnv(qaDir), ...values };
  fs.mkdirSync(qaDir, { recursive: true });
  const text =
    '# Saved by the AI QA Agent dashboard. Secrets for this computer only; never commit this file.\n' +
    Object.entries(merged)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n') +
    '\n';
  fs.writeFileSync(path.join(qaDir, LOCAL_ENV_FILE), text, { mode: 0o600 });
  ignoreLocalEnv(qaDir);
  Object.assign(env, values);
}

/** Make sure `.qa/.gitignore` lists the secrets file. */
export function ignoreLocalEnv(qaDir: string): void {
  const file = path.join(qaDir, '.gitignore');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.split(/\r?\n/).some((l) => l.trim() === LOCAL_ENV_FILE || l.trim() === '/' + LOCAL_ENV_FILE))
    return;
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, text + sep + '# secrets saved by the dashboard\n' + LOCAL_ENV_FILE + '\n');
}

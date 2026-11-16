import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Read and validate a JSON file. Returns undefined when the file does not exist. */
export function readJson<T extends z.ZodType>(file: string, schema: T): z.output<T> | undefined {
  if (!fs.existsSync(file)) return undefined;
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${path.basename(file)}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Recursively list files under `dir`, skipping excluded directory names. */
export function listFiles(dir: string, exclude: readonly string[] = []): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (exclude.includes(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, exclude));
    else out.push(full);
  }
  return out;
}

/**
 * Stable hash of a set of files' contents keyed by relative path. A directory in the list stands
 * for every file inside it: file lists written by the AI analyst sometimes name a folder.
 */
export function hashFiles(root: string, files: readonly string[]): string {
  const h = crypto.createHash('sha256');
  const expanded = files.flatMap((f) =>
    fs.statSync(f).isDirectory() ? listFiles(f, ['node_modules']) : [f],
  );
  for (const f of [...new Set(expanded)].sort()) {
    h.update(path.relative(root, f).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Bytes a file or folder takes, counting every file below it. Links are not followed. */
export function sizeOf(target: string): number {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of fs.readdirSync(target)) total += sizeOf(path.join(target, name));
  return total;
}

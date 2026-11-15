/**
 * What the QA data takes on disk, and freeing the parts nobody needs any more. Everything here
 * lives in `.qa/`; scenarios, tests, config, rules, the app model, design references, bug-tracker
 * records and fix plans are never touched.
 *
 * - `raw-output`: Playwright's own output folder in each run (`runs/<id>/playwright`). Every
 *   screenshot, video, trace and error context the dashboard shows is copied out of it when the
 *   run finishes, so it only holds duplicates.
 * - `logs`: the agent's log, the AI transcripts and the app-server log (`artifacts/logs`).
 * - `leftovers`: run and report folders no run record points at (an interrupted run, a deleted
 *   state file) and `artifacts/test-results` (tests started outside the agent).
 * - `old-runs`: every run but the latest, with its evidence and report (see delete-runs.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { sizeOf } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { isInside, runDir, type QaPaths } from '../core/paths.js';
import type { StateStore } from '../state/state.js';
import { deleteRuns } from './delete-runs.js';

const log = logger('storage');

export const CLEANUP_KINDS = ['raw-output', 'logs', 'leftovers', 'old-runs'] as const;
export type CleanupKind = (typeof CLEANUP_KINDS)[number];

export interface StorageItem {
  kind: CleanupKind;
  bytes: number;
  /** For `old-runs`: the runs it would delete. */
  runs?: string[];
  /** For `old-runs`: bytes of it that `raw-output` also counts (do not add them twice). */
  overlap?: number;
}

export interface StorageReport {
  /** Everything in `.qa/`. */
  totalBytes: number;
  items: StorageItem[];
  /** A job is running: nothing can be cleaned until it finishes. */
  busy: boolean;
}

/** A request the caller got wrong (400) or one that must wait for a running job (409). */
export class StorageCleanError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

interface Ctx {
  paths: QaPaths;
  state: StateStore;
}

const subdirs = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];

/** The paths each kind of cleanup would remove, given the runs a job is using. */
function targets(ctx: Ctx, inUse: readonly string[]): Record<CleanupKind, string[]> & { oldRuns: string[] } {
  const { paths, state } = ctx;
  const runs = state.data.runs;
  const known = new Set(runs.map((r) => r.id));
  const busy = new Set([...inUse, ...runs.filter((r) => r.status === 'running').map((r) => r.id)]);
  const runsRoot = path.join(paths.artifactsDir, 'runs');
  const latest = state.latestRun()?.id;
  const oldRuns = runs.map((r) => r.id).filter((id) => id !== latest && !busy.has(id));
  return {
    'raw-output': runs
      .filter((r) => !busy.has(r.id))
      .map((r) => path.join(runDir(paths, r.id), 'playwright'))
      .filter((p) => fs.existsSync(p)),
    logs: fs.existsSync(paths.logsDir)
      ? fs.readdirSync(paths.logsDir).map((n) => path.join(paths.logsDir, n))
      : [],
    leftovers: [
      ...subdirs(runsRoot)
        .filter((id) => !known.has(id))
        .map((id) => path.join(runsRoot, id)),
      ...subdirs(paths.reportsDir)
        .filter((id) => !known.has(id))
        .map((id) => path.join(paths.reportsDir, id)),
      path.join(paths.artifactsDir, 'test-results'),
    ].filter((p) => fs.existsSync(p)),
    'old-runs': oldRuns.flatMap((id) => [runDir(paths, id), path.join(paths.reportsDir, id)]),
    oldRuns,
  };
}

export function storageReport(ctx: Ctx, opts: { busy: boolean; inUse: readonly string[] }): StorageReport {
  const t = targets(ctx, opts.inUse);
  const total = (list: string[]): number => list.reduce((n, p) => n + sizeOf(p), 0);
  const items: StorageItem[] = CLEANUP_KINDS.map((kind) => ({ kind, bytes: total(t[kind]) }));
  const old = items.find((i) => i.kind === 'old-runs')!;
  old.runs = t.oldRuns;
  old.overlap = total(t.oldRuns.map((id) => path.join(runDir(ctx.paths, id), 'playwright')));
  return { totalBytes: sizeOf(ctx.paths.qaDir), items, busy: opts.busy };
}

export function cleanStorage(
  ctx: Ctx,
  req: { kinds: unknown; busy: boolean; inUse: readonly string[] },
): { cleaned: CleanupKind[]; freedBytes: number; deletedRuns: string[] } {
  const { kinds } = req;
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    !kinds.every((k) => (CLEANUP_KINDS as readonly unknown[]).includes(k))
  )
    throw new StorageCleanError('kinds must be a non-empty list of: ' + CLEANUP_KINDS.join(', '), 400);
  if (req.busy) throw new StorageCleanError('A job is running; wait until it finishes, then clean up.', 409);
  const wanted = CLEANUP_KINDS.filter((k) => kinds.includes(k));
  const t = targets(ctx, req.inUse);
  let freedBytes = 0;
  let deletedRuns: string[] = [];
  if (wanted.includes('old-runs') && t.oldRuns.length) {
    const res = deleteRuns(ctx, { ids: t.oldRuns, inUse: req.inUse });
    freedBytes += res.freedBytes;
    deletedRuns = res.deleted;
  }
  const qaDir = path.resolve(ctx.paths.qaDir);
  for (const kind of wanted) {
    if (kind === 'old-runs') continue;
    for (const target of t[kind]) {
      const abs = path.resolve(target);
      // Never outside `.qa`, and never a run just deleted above.
      if (!isInside(qaDir, abs) || abs === qaDir || !fs.existsSync(abs)) continue;
      const bytes = sizeOf(abs);
      try {
        fs.rmSync(abs, { recursive: true, force: true });
        freedBytes += bytes;
      } catch (err) {
        // A file another program holds open (Windows) stays; the rest is still freed.
        log.warn(`Could not delete ${abs}: ${(err as Error).message}`);
      }
    }
  }
  log.info(`Cleaned ${wanted.join(', ')}: freed ${freedBytes} bytes`);
  return { cleaned: wanted, freedBytes, deletedRuns };
}

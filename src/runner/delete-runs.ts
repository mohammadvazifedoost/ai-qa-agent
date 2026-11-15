/**
 * Delete old test runs: each run's evidence folder (`.qa/artifacts/runs/<id>`: results, triage,
 * screenshots, videos, traces, logs), its report folder (`.qa/reports/<id>`) and its record in
 * `.qa/state.json`. Bug-tracker records, fix-plan documents, scenarios and tests are kept: they are
 * not run data, and filed bugs must still be recognised in later runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sizeOf } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { isInside, runDir, type QaPaths } from '../core/paths.js';
import type { StateStore } from '../state/state.js';

const log = logger('runs');

/** A request the caller got wrong: bad input (400), an unknown run (404) or a run in use (409). */
export class RunDeleteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface RunDeleteResult {
  deleted: string[];
  /** Bytes freed on disk. */
  freedBytes: number;
}

export function deleteRuns(
  ctx: { paths: QaPaths; state: StateStore },
  req: { ids: unknown; inUse?: readonly string[] },
): RunDeleteResult {
  const { ids } = req;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    !ids.every((x) => typeof x === 'string' && /^[\w-]+$/.test(x))
  )
    throw new RunDeleteError('ids must be a non-empty list of run ids', 400);
  const wanted = [...new Set(ids as string[])];
  const runs = ctx.state.data.runs;
  for (const id of wanted) {
    const record = runs.find((r) => r.id === id);
    if (!record) throw new RunDeleteError(`Run ${id} not found`, 404);
    if (record.status === 'running' || req.inUse?.includes(id))
      throw new RunDeleteError(`Run ${id} is still in use; wait until it finishes`, 409);
  }

  const runsRoot = path.join(ctx.paths.artifactsDir, 'runs');
  let freedBytes = 0;
  for (const id of wanted) {
    for (const [dir, root] of [
      [runDir(ctx.paths, id), runsRoot],
      [path.join(ctx.paths.reportsDir, id), ctx.paths.reportsDir],
    ] as const) {
      // Never outside its own parent, whatever the id contains.
      if (!isInside(root, path.resolve(dir)) || path.resolve(dir) === root) continue;
      freedBytes += sizeOf(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  ctx.state.data.runs = runs.filter((r) => !wanted.includes(r.id));
  ctx.state.save();
  log.info(`Deleted ${wanted.length} run(s): ${wanted.join(', ')}`);
  return { deleted: wanted, freedBytes };
}

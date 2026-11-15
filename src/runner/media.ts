import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { isInside, runDir, type QaPaths } from '../core/paths.js';
import { TestRunResultSchema, videosOf } from './results.js';

const log = logger('media');

/** A request the caller got wrong: bad input (400) or a run/result that does not exist (404). */
export class MediaDeleteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

export interface MediaDeleteResult {
  runId: string;
  key: string;
  /** Project-relative paths removed from the result (deleted from disk, or already gone). */
  removed: string[];
  /** Of `removed`, the files that were already missing on disk. */
  missing: string[];
  /** The result's media after the deletion. */
  video: string | null;
  videos: string[];
  screenshots: string[];
}

/**
 * Delete the screenshots and videos of one test result in a run: one `file` (a project-relative
 * path, exactly as the result lists it) or, without `file`, all of them. Only files the result
 * references as a screenshot or video, and that lie under `.qa/artifacts`, can be deleted; the
 * run's results.json is updated so nothing points at them any more. Traces, logs and design
 * diffs are not media and are kept.
 */
export function deleteMedia(
  ctx: { root: string; paths: QaPaths },
  req: { runId: unknown; key: unknown; file?: unknown },
): MediaDeleteResult {
  const { runId, key, file } = req;
  if (typeof runId !== 'string' || !/^[\w-]+$/.test(runId))
    throw new MediaDeleteError('a valid runId is required', 400);
  if (typeof key !== 'string' || !key) throw new MediaDeleteError('key is required', 400);
  if (file !== undefined && (typeof file !== 'string' || !file))
    throw new MediaDeleteError('file must be a non-empty string', 400);

  const resultsFile = path.join(runDir(ctx.paths, runId), 'results.json');
  const run = readJson(resultsFile, TestRunResultSchema);
  if (!run) throw new MediaDeleteError(`Run ${runId} not found`, 404);
  const outcome = run.outcomes.find((o) => o.key === key);
  if (!outcome) throw new MediaDeleteError(`${key} not found in run ${runId}`, 404);

  const { artifacts } = outcome;
  const media = [...artifacts.screenshots, ...videosOf(artifacts)];
  if (file !== undefined && !media.includes(file))
    throw new MediaDeleteError(`${file} is not a screenshot or video of ${key}`, 400);
  const targets = file !== undefined ? [file] : media;
  if (targets.length === 0) throw new MediaDeleteError(`${key} has no screenshots or video`, 404);

  // Check every path before touching anything: a hand-edited results.json must not reach outside.
  const resolved = targets.map((p) => {
    const abs = path.resolve(ctx.root, p);
    if (!isInside(ctx.paths.artifactsDir, abs) || abs === ctx.paths.artifactsDir)
      throw new MediaDeleteError(`${p} is outside the run artifacts`, 400);
    if (fs.existsSync(abs) && !fs.statSync(abs).isFile())
      throw new MediaDeleteError(`${p} is not a file`, 400);
    return { p, abs };
  });

  const missing: string[] = [];
  for (const { p, abs } of resolved) {
    if (fs.existsSync(abs)) fs.rmSync(abs);
    else missing.push(p);
  }
  const gone = new Set(targets);
  artifacts.screenshots = artifacts.screenshots.filter((s) => !gone.has(s));
  artifacts.videos = videosOf(artifacts).filter((v) => !gone.has(v));
  artifacts.video = artifacts.videos[0] ?? null;
  writeJson(resultsFile, run);
  log.info(`Deleted ${targets.length} media file(s) of ${key} in run ${runId}`);

  return {
    runId,
    key,
    removed: targets,
    missing,
    video: artifacts.video,
    videos: artifacts.videos,
    screenshots: artifacts.screenshots,
  };
}

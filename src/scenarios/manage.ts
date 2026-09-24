import fs from 'node:fs';
import path from 'node:path';
import { loadAppModel } from '../analyze/app.js';
import { listFiles, readJson, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { rel, runDir } from '../core/paths.js';
import { specHash, specKey, specPath, validateSpec } from '../generate/playwright.js';
import type { QaContext } from '../pipeline/context.js';
import { writePlaywrightConfig } from '../runner/playwright-config.js';
import { TestRunResultSchema } from '../runner/results.js';
import { matchesPage, pageSlug } from './generate.js';
import { ScenarioFileSchema, type ScenarioFile } from './schema.js';
import { listTestIds, removeTestBlock } from './spec-edit.js';

const log = logger('scenarios');

/** Checks that an edited spec still loads and declares `expectedIds`; returns problems (empty = OK). */
export type SpecValidator = (ctx: QaContext, file: string, expectedIds: string[]) => Promise<string[]>;

const playwrightValidator: SpecValidator = (ctx, file, expectedIds) => {
  writePlaywrightConfig(ctx.paths, ctx.config);
  return validateSpec(
    ctx,
    file,
    expectedIds.map((id) => ({ id })),
  );
};

/** Accept "checkout-008" as well as "CHECKOUT-008". */
export function normalizeId(id: string): string {
  return id.trim().toUpperCase();
}

interface LoadedFile {
  path: string;
  data: ScenarioFile;
}

function loadScenarioFiles(ctx: QaContext): LoadedFile[] {
  return listFiles(ctx.paths.scenariosDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ path: f, data: readJson(f, ScenarioFileSchema)! }));
}

export interface RemovedOutcome {
  id: string;
  title: string;
  page: string;
  /** What happened to the spec file: the test was cut out, it had no test, or there is no spec yet. */
  spec: 'test-removed' | 'no-test' | 'no-spec';
  specFile: string;
}

/**
 * Delete scenarios: cut their tests out of the page's spec (validated with Playwright, rolled back
 * on failure), move them to the file's `removed` list so regeneration does not bring them back,
 * and keep the spec's generation cache fresh so `generate` does not rewrite the file for it.
 */
export async function removeScenarios(
  ctx: QaContext,
  rawIds: string[],
  opts: { reason?: string; validate?: SpecValidator } = {},
): Promise<RemovedOutcome[]> {
  const ids = [...new Set(rawIds.map(normalizeId))];
  if (ids.length === 0) throw new Error('No scenario id given.');
  const files = loadScenarioFiles(ctx);
  const byFile = new Map<LoadedFile, string[]>();
  for (const id of ids) {
    const file = files.find((f) => f.data.scenarios.some((s) => s.id === id));
    if (!file) {
      const removed = files.some((f) => f.data.removed.some((r) => r.id === id));
      throw new Error(
        removed
          ? `${id} is already removed (restore it with \`ai-qa-agent scenarios restore ${id}\`).`
          : `Unknown scenario ${id}. List ids with \`ai-qa-agent scenarios list\`.`,
      );
    }
    byFile.set(file, [...(byFile.get(file) ?? []), id]);
  }

  const validate = opts.validate ?? playwrightValidator;
  const app = loadAppModel(ctx);
  const outcomes: RemovedOutcome[] = [];
  for (const [file, fileIds] of byFile) {
    const { data } = file;
    const page = app?.pages.find((p) => p.route === data.page);
    const spec = specPath(ctx, data.page);
    const key = specKey(ctx, spec);
    const approvedBefore = data.scenarios.filter((s) => s.approved);
    const specWasFresh =
      !!page &&
      fs.existsSync(spec) &&
      ctx.state.data.generatedSpecs[key] === specHash(ctx, page, approvedBefore);

    const specResult = new Map<string, RemovedOutcome['spec']>();
    if (fs.existsSync(spec)) {
      const original = fs.readFileSync(spec, 'utf8');
      let code = original;
      for (const id of fileIds) {
        const res = removeTestBlock(code, id);
        code = res.code;
        specResult.set(id, res.removed > 0 ? 'test-removed' : 'no-test');
      }
      if (code !== original) {
        fs.writeFileSync(spec, code);
        const expected = listTestIds(original).filter((id) => !fileIds.includes(id));
        const problems = await validate(ctx, spec, [...new Set(expected)]);
        if (problems.length) {
          fs.writeFileSync(spec, original);
          throw new Error(
            `Removing ${fileIds.join(', ')} would break ${rel(ctx.root, spec)}; nothing was changed.\n${problems.join('\n')}`,
          );
        }
      }
    }

    const removedAt = new Date().toISOString();
    for (const id of fileIds) {
      const scenario = data.scenarios.find((s) => s.id === id)!;
      data.removed.push({ id, title: scenario.title, reason: opts.reason || undefined, removedAt, scenario });
      outcomes.push({
        id,
        title: scenario.title,
        page: data.page,
        spec: specResult.get(id) ?? 'no-spec',
        specFile: rel(ctx.root, spec),
      });
    }
    data.scenarios = data.scenarios.filter((s) => !fileIds.includes(s.id));
    writeJson(file.path, data);

    if (specWasFresh && page) {
      ctx.state.data.generatedSpecs[key] = specHash(
        ctx,
        page,
        data.scenarios.filter((s) => s.approved),
      );
      ctx.state.save();
    }
    log.info(`Removed ${fileIds.join(', ')} from ${data.page}${opts.reason ? ` (${opts.reason})` : ''}`);
  }
  return outcomes;
}

export interface RestoredOutcome {
  id: string;
  title: string;
  page: string;
}

/**
 * Bring removed scenarios back (approved). Their tests return on the next `ai-qa-agent generate`,
 * which regenerates the page's spec because its approved scenarios changed.
 */
export function restoreScenarios(ctx: QaContext, rawIds: string[]): RestoredOutcome[] {
  const ids = [...new Set(rawIds.map(normalizeId))];
  const files = loadScenarioFiles(ctx);
  for (const id of ids) {
    if (!files.some((f) => f.data.removed.some((r) => r.id === id))) {
      const active = files.some((f) => f.data.scenarios.some((s) => s.id === id));
      throw new Error(active ? `${id} is not removed.` : `No removed scenario ${id}.`);
    }
  }
  const outcomes: RestoredOutcome[] = [];
  for (const file of files) {
    const { data } = file;
    const here = data.removed.filter((r) => ids.includes(r.id));
    if (here.length === 0) continue;
    for (const r of here) {
      if (data.scenarios.some((s) => s.id === r.id)) {
        throw new Error(`${r.id} exists again in ${data.page}; remove the duplicate before restoring.`);
      }
      // Keep the id order without reordering the other scenarios.
      const at = data.scenarios.findIndex((s) => s.id.localeCompare(r.id) > 0);
      data.scenarios.splice(at === -1 ? data.scenarios.length : at, 0, { ...r.scenario, approved: true });
      outcomes.push({ id: r.id, title: r.title, page: data.page });
    }
    data.removed = data.removed.filter((r) => !ids.includes(r.id));
    writeJson(file.path, data);
    log.info(`Restored ${here.map((r) => r.id).join(', ')} on ${data.page}`);
  }
  return outcomes;
}

export interface ScenarioRow {
  id: string;
  category: string;
  page: string;
  title: string;
  /** Result in the latest run, `unapproved`, or `removed`. */
  status: string;
}

/** Scenario status in the most recent run that has results (worst result across projects). */
function latestStatuses(ctx: QaContext): Map<string, string> {
  const rank = ['passed', 'skipped', 'flaky', 'failed'];
  for (const run of [...ctx.state.data.runs].reverse()) {
    const file = path.join(runDir(ctx.paths, run.id), 'results.json');
    if (!fs.existsSync(file)) continue;
    let res;
    try {
      res = readJson(file, TestRunResultSchema);
    } catch (err) {
      log.warn(`Ignoring run ${run.id}: ${(err as Error).message}`);
      continue;
    }
    const out = new Map<string, string>();
    for (const o of res?.outcomes ?? []) {
      if (!o.scenarioId) continue;
      const prev = out.get(o.scenarioId);
      if (!prev || rank.indexOf(o.status) > rank.indexOf(prev)) out.set(o.scenarioId, o.status);
    }
    return out;
  }
  return new Map();
}

export function listScenarioRows(
  ctx: QaContext,
  opts: { page?: string; removed?: boolean } = {},
): ScenarioRow[] {
  const statuses = latestStatuses(ctx);
  const files = loadScenarioFiles(ctx).filter(
    (f) => !opts.page || matchesPage({ route: f.data.page, name: pageSlug(f.data.page) }, opts.page),
  );
  if (opts.page && files.length === 0) {
    throw new Error(`No scenarios for page "${opts.page}".`);
  }
  const rows: ScenarioRow[] = [];
  for (const { data } of files) {
    for (const s of data.scenarios) {
      rows.push({
        id: s.id,
        category: s.category,
        page: s.page,
        title: s.title,
        status: s.approved ? (statuses.get(s.id) ?? 'not run') : 'unapproved',
      });
    }
    if (opts.removed) {
      for (const r of data.removed) {
        rows.push({
          id: r.id,
          category: r.scenario.category,
          page: r.scenario.page,
          title: r.title,
          status: 'removed',
        });
      }
    }
  }
  return rows.sort((a, b) => a.page.localeCompare(b.page) || a.id.localeCompare(b.id));
}

/** Plain aligned columns; the title is last so long titles do not break the alignment. */
export function formatScenarioTable(rows: ScenarioRow[]): string[] {
  const head: ScenarioRow = { id: 'ID', category: 'TYPE', page: 'PAGE', status: 'STATUS', title: 'TITLE' };
  const cols = ['id', 'category', 'page', 'status'] as const;
  const width = Object.fromEntries(
    cols.map((c) => [c, Math.max(...[head, ...rows].map((r) => r[c].length))]),
  ) as Record<(typeof cols)[number], number>;
  return [head, ...rows].map((r) =>
    [...cols.map((c) => r[c].padEnd(width[c])), r.title].join('  ').trimEnd(),
  );
}

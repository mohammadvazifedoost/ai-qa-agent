/**
 * The dashboard's Project page: what the agent knows about the application (analysis, scenarios,
 * critical flows), whether it still matches the code, and the three AI steps that bring it up to
 * date. The steps are the same work as `ai-qa-agent analyze`, `scenarios` and `scenarios --critical`.
 */
import fs from 'node:fs';
import {
  analyzeApp,
  criticalFlows,
  isOutdatedModel,
  loadAppModel,
  requireAppModel,
  type PageModel,
} from '../analyze/app.js';
import { detectCodeChanges, routesToAnalyze } from '../changes/detect.js';
import { Cancelled } from '../core/process.js';
import { extractDesign } from '../design/figma.js';
import { scenarioTestStates } from '../generate/scenario-test.js';
import type { QaContext } from '../pipeline/context.js';
import { generateCriticalScenarios, selectCriticalJourneys } from '../scenarios/critical.js';
import {
  generateScenarios,
  loadAllScenarios,
  loadDesign,
  scenarioPageStatus,
  type ScenarioPageStatus,
} from '../scenarios/generate.js';
import { isCriticalScenario } from '../scenarios/schema.js';

export interface ProjectStatus {
  /** Null before the first analysis. */
  analysis: {
    analyzedAt: string;
    pages: number;
    journeys: number;
    criticalJourneys: number;
    /**
     * False for an analysis made by an older version of the agent: scenarios cannot be written
     * from it until the application is analyzed again.
     */
    usable: boolean;
  } | null;
  design: { configured: boolean; extractedAt: string | null };
  /** How the source differs from what was analyzed. */
  code: {
    /** Routes an update would read again (new and changed pages). */
    toAnalyze: string[];
    removed: string[];
    /** Changed files that every page shares (router, layout, global styles). */
    shared: string[];
  };
  pages: Array<{
    route: string;
    /** Empty for a page the analysis does not know yet. */
    name: string;
    importance: PageModel['importance'] | null;
    code: 'unchanged' | 'changed' | 'new' | 'removed';
    scenarios: number;
    /** Null for a page that is not in the analysis. */
    scenarioState: ScenarioPageStatus['state'] | null;
  }>;
  scenarios: { total: number; person: number; removed: number };
  critical: {
    /** Journeys the analysis ranks as critical. */
    journeys: number;
    /** `scenarios.maxCritical` from the config, when set. */
    max: number | null;
    chosen: Array<{ id: string; title: string; page: string; hasTest: boolean }>;
  };
}

/** Deterministic and free: compares files on disk, never calls the AI. */
export function projectStatus(ctx: QaContext): ProjectStatus {
  const model = loadAppModel(ctx);
  const changes = detectCodeChanges(ctx, model);
  const sets = model ? scenarioPageStatus(ctx, model) : [];
  const setOf = new Map(sets.map((s) => [s.route, s]));
  const pending = scenarioTestStates(ctx);
  const pages: ProjectStatus['pages'] = (model?.pages ?? []).map((p) => ({
    route: p.route,
    name: p.name,
    importance: p.importance,
    code: changes.removedPages.includes(p.route)
      ? 'removed'
      : changes.changedPages.includes(p.route)
        ? 'changed'
        : 'unchanged',
    scenarios: setOf.get(p.route)?.scenarios ?? 0,
    scenarioState: setOf.get(p.route)?.state ?? null,
  }));
  for (const p of changes.newPages) {
    pages.push({
      route: p.route,
      name: '',
      importance: null,
      code: 'new',
      scenarios: 0,
      scenarioState: null,
    });
  }
  const sum = (pick: (s: ScenarioPageStatus) => number): number => sets.reduce((n, s) => n + pick(s), 0);
  return {
    analysis: model
      ? {
          analyzedAt: model.analyzedAt,
          pages: model.pages.length,
          journeys: model.flows.length,
          criticalJourneys: criticalFlows(model).length,
          usable: !isOutdatedModel(model),
        }
      : null,
    design: { configured: !!ctx.config.figma, extractedAt: loadDesign(ctx)?.extractedAt ?? null },
    code: {
      toAnalyze: model ? routesToAnalyze(changes) : [],
      removed: changes.removedPages,
      shared: changes.changedGlobalFiles,
    },
    pages,
    scenarios: {
      total: sum((s) => s.scenarios),
      person: sum((s) => s.person),
      removed: sum((s) => s.removed),
    },
    critical: {
      journeys: model ? criticalFlows(model).length : 0,
      max: ctx.config.scenarios.maxCritical ?? null,
      chosen: loadAllScenarios(ctx)
        .filter(isCriticalScenario)
        .map((s) => ({ id: s.id, title: s.title, page: s.page, hasTest: pending[s.id] !== 'missing' })),
    },
  };
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What a running step is doing right now, for the progress banner. */
export type Progress = (detail: string) => void;

/** Analyze the application: only what changed, or (`all`) everything again. */
export async function runAnalysis(
  ctx: QaContext,
  opts: { all: boolean; design: boolean },
  progress: Progress,
): Promise<string> {
  const before = loadAppModel(ctx);
  progress(opts.all || !before ? 'reading the whole application' : 'reading the pages that changed');
  const model = await analyzeApp(ctx, { force: opts.all });
  // The design is read when asked for, and the first time a Figma file is configured.
  if (ctx.config.figma && (opts.design || !fs.existsSync(ctx.paths.designSystem))) {
    progress('reading the Figma design');
    await extractDesign(ctx, { force: opts.design });
  }
  const facts = `${count(model.pages.length, 'page')}, ${count(model.flows.length, 'journey')} (${criticalFlows(model).length} critical)`;
  if (before && before.analyzedAt === model.analyzedAt)
    return `The analysis was already up to date: ${facts}.`;
  const stale = scenarioPageStatus(ctx, model).filter((s) => s.state !== 'current').length;
  return (
    `The analysis is up to date: ${facts}.` +
    (stale ? ` The scenarios of ${count(stale, 'page')} need an update (step 2).` : '')
  );
}

/**
 * Write scenarios: one page, every page (`all`), or the pages that are out of date or have none.
 * Each page is saved when it is done, so cancelling or failing keeps the pages before it.
 */
export async function runScenarios(
  ctx: QaContext,
  opts: { page?: string; all: boolean },
  progress: Progress,
): Promise<string> {
  const app = requireAppModel(ctx);
  const status = scenarioPageStatus(ctx, app);
  const routes = opts.page
    ? [opts.page]
    : status.filter((s) => opts.all || s.state !== 'current').map((s) => s.route);
  if (routes.length === 0) return 'The scenarios were already up to date.';
  const saved: string[] = [];
  for (const [i, route] of routes.entries()) {
    // One page asked for by name is already in the job's label.
    if (!opts.page) progress(`page ${i + 1} of ${routes.length}: ${route}`);
    try {
      await generateScenarios(ctx, { pages: [route], force: true });
    } catch (err) {
      const kept = saved.length
        ? `The scenarios of ${saved.join(', ')} were already saved; the other pages are as they were.`
        : 'Nothing was changed.';
      if (err instanceof Cancelled) throw new Cancelled(`Cancelled while writing ${route}. ${kept}`);
      throw new Error(`${(err as Error).message} (${route}) ${kept}`, { cause: err });
    }
    saved.push(route);
  }
  const written = new Set(routes);
  const mine = loadAllScenarios(ctx).filter((s) => written.has(s.page));
  const pending = scenarioTestStates(ctx);
  const needTest = mine.filter((s) => pending[s.id]).length;
  return (
    `Scenarios written for ${routes.length === 1 ? routes[0] : count(routes.length, 'page')}: ${count(mine.length, 'scenario')}.` +
    (needTest ? ` ${needTest} ${needTest === 1 ? 'needs' : 'need'} a new test.` : '')
  );
}

/** Choose the critical flows again: one scenario per critical journey of the analysis. */
export async function runCritical(
  ctx: QaContext,
  opts: { max?: number },
  progress: Progress,
): Promise<string> {
  const journeys = selectCriticalJourneys(requireAppModel(ctx), opts.max ?? ctx.config.scenarios.maxCritical);
  progress(`${count(journeys.length, 'journey')} from the analysis`);
  const flows = await generateCriticalScenarios(ctx, { force: true, max: opts.max });
  const pending = scenarioTestStates(ctx);
  const needTest = flows.filter((s) => pending[s.id]).length;
  return (
    `${count(flows.length, 'critical flow')} chosen: ${flows.map((s) => s.id).join(', ')}.` +
    (needTest ? ` ${needTest} ${needTest === 1 ? 'needs' : 'need'} a new test.` : '')
  );
}

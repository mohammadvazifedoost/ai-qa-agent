import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  fileIssues,
  FilingUnavailable,
  loadFiling,
  previouslyFiled,
  recordFiling,
  type FilingResult,
} from '../bugs/file.js';
import { createTracker, trackerInfo, type IssueTracker } from '../integrations/tracker.js';
import { readJson, sha256, slugify } from '../core/fs.js';
import type { TestOutcome } from '../runner/results.js';
import type { BugDraft, Issue } from '../triage/schema.js';
import { logger } from '../core/logger.js';
import { runDir } from '../core/paths.js';
import type { QaContext } from '../pipeline/context.js';
import { TestRunResultSchema, type TestRunResult } from '../runner/results.js';
import { loadAllScenarios } from '../scenarios/generate.js';
import { TriageResultSchema, type TriageResult } from '../triage/schema.js';
import { PAGE_HTML } from './page.js';

const log = logger('ui');

export interface Overview {
  project: { name: string; baseUrl: string };
  /** The configured bug tracker (ClickUp or Jira), without secrets. */
  tracker: {
    kind: 'clickup' | 'jira' | null;
    name: string;
    noun: 'task' | 'issue';
    configured: boolean;
    tokenPresent: boolean;
    target: string | null;
  };
  runs: Array<{ id: string; startedAt: string; status: string; stats: TestRunResult['stats'] | null }>;
  run: {
    id: string;
    stats: TestRunResult['stats'];
    outcomes: TestRunResult['outcomes'];
    failures: TriageResult['failures'];
    issues: TriageResult['issues'];
    filing: FilingResult[];
    /** Per failed outcome key: the tracker item known for its defect, verified against the tracker. */
    tasks: Record<string, TaskLink>;
    /** True when /api/tasks should be called to verify items (tracker configured and credentials present). */
    tasksPending: boolean;
  } | null;
  scenarios: ReturnType<typeof loadAllScenarios>;
}

export interface TaskLink {
  taskId: string;
  url?: string;
  /** True when the tracker confirmed the item exists; false when it was deleted or never verified. */
  exists: boolean;
  verified: boolean;
  status?: string;
}

/** Existence checks are cached briefly so the dashboard does not hit the tracker on every reload. */
const taskCache = new Map<string, { at: number; value: Omit<TaskLink, 'taskId'> }>();
const TASK_CACHE_MS = 60_000;

async function verifyTask(
  tracker: IssueTracker | undefined,
  taskId: string,
): Promise<Omit<TaskLink, 'taskId'>> {
  if (!tracker) return { exists: false, verified: false };
  const hit = taskCache.get(`${tracker.kind}:${taskId}`);
  if (hit && Date.now() - hit.at < TASK_CACHE_MS) return hit.value;
  try {
    const r = await tracker.exists(taskId);
    const value = { exists: r.exists, verified: true, url: r.url, status: r.status };
    taskCache.set(`${tracker.kind}:${taskId}`, { at: Date.now(), value });
    return value;
  } catch (err) {
    log.warn(`Could not verify ${taskId} in ${tracker.name}: ${(err as Error).message}`);
    return { exists: false, verified: false };
  }
}

/**
 * Tasks recorded for a failed outcome, most specific first: the one filed in this run, then the
 * task filed for the same defect in an earlier run.
 */
function knownTasks(
  ctx: QaContext,
  test: TestRunResult,
  triage: TriageResult | undefined,
  filing: FilingResult[],
  key: string,
): Array<{ taskId: string; url?: string }> {
  const outcome = test.outcomes.find((o) => o.key === key);
  if (!outcome) return [];
  const issue = triage?.issues.find((i) => i.failureKeys.includes(key)) ?? adhocIssue(ctx, test, triage, key);
  const candidates: Array<{ taskId: string; url?: string }> = [];
  const filed = filing.find(
    (f) => f.taskId && (f.issueId === issue?.id || f.issueId === adhocIssueId(outcome)),
  );
  if (filed?.taskId) candidates.push({ taskId: filed.taskId, url: filed.url });
  const prior = issue ? previouslyFiled(ctx, issue) : undefined;
  if (prior?.taskId && !candidates.some((c) => c.taskId === prior.taskId)) {
    candidates.push({ taskId: prior.taskId, url: prior.url });
  }
  return candidates;
}

/** Resolve and verify the tracker item for every failed/flaky outcome of a run. */
async function taskLinks(
  ctx: QaContext,
  test: TestRunResult,
  triage: TriageResult | undefined,
  filing: FilingResult[],
): Promise<Record<string, TaskLink>> {
  let tracker: IssueTracker | undefined;
  try {
    tracker = createTracker(ctx.config);
  } catch {
    tracker = undefined; // not configured or no credentials: nothing can be verified
  }
  const failed = test.outcomes.filter((o) => o.status === 'failed' || o.status === 'flaky');
  const entries = await Promise.all(
    failed.map(async (o) => {
      let last: TaskLink | null = null;
      for (const known of knownTasks(ctx, test, triage, filing, o.key)) {
        const v = await verifyTask(tracker, known.taskId);
        last = {
          taskId: known.taskId,
          url: v.url ?? known.url,
          exists: v.exists,
          verified: v.verified,
          status: v.status,
        };
        if (v.exists) break; // the first item that still exists in the tracker wins
      }
      return last ? ([o.key, last] as const) : null;
    }),
  );
  return Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null));
}

function loadRun(ctx: QaContext, id: string): TestRunResult | undefined {
  return readJson(path.join(runDir(ctx.paths, id), 'results.json'), TestRunResultSchema);
}

/** Everything the dashboard shows, assembled from the files the pipeline already writes. */
export async function buildOverview(ctx: QaContext, runId?: string): Promise<Overview> {
  const runs = [...ctx.state.data.runs]
    .sort((a, b) => b.id.localeCompare(a.id))
    .map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      status: r.status,
      stats: loadRun(ctx, r.id)?.stats ?? null,
    }))
    .filter((r) => r.stats !== null);
  const selected = runId ?? runs[0]?.id;
  const test = selected ? loadRun(ctx, selected) : undefined;
  let run: Overview['run'] = null;
  if (test) {
    const triage = readJson(path.join(test.runDir, 'triage.json'), TriageResultSchema);
    const filing = loadFiling(test)?.results ?? [];
    run = {
      id: test.runId,
      stats: test.stats,
      outcomes: test.outcomes,
      failures: triage?.failures ?? [],
      issues: triage?.issues ?? [],
      filing,
      // Filled in by a second request (/api/tasks) so the page never waits for the tracker.
      tasks: {},
      tasksPending: trackerInfo(ctx.config).credentialsPresent,
    };
  }
  const info = trackerInfo(ctx.config);
  return {
    project: { name: ctx.config.project.name, baseUrl: ctx.config.app.baseUrl },
    tracker: {
      kind: info.kind,
      name: info.name,
      noun: info.noun,
      configured: info.kind !== null,
      tokenPresent: info.credentialsPresent,
      target: info.target,
    },
    runs,
    run,
    scenarios: loadAllScenarios(ctx),
  };
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Only files under `.qa/artifacts` and `.qa/design` are served; anything else is refused. */
function serveFile(ctx: QaContext, urlPath: string, res: http.ServerResponse): void {
  const relative = decodeURIComponent(urlPath.replace(/^\/files\//, ''));
  const abs = path.resolve(ctx.root, relative);
  const allowed = [ctx.paths.artifactsDir, path.join(ctx.paths.qaDir, 'design')].some(
    (dir) => abs === dir || abs.startsWith(dir + path.sep),
  );
  if (!allowed || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

/** Id used in filing.json for a failure that was filed without a consolidated issue. */
export function adhocIssueId(outcome: Pick<TestOutcome, 'scenarioId' | 'title'>): string {
  return `FAIL-${outcome.scenarioId ?? slugify(outcome.title)}`;
}

/**
 * A bug report for one failed test that the analyzer did not turn into a confirmed issue
 * (test bug, unknown, not triaged). A human chose to file it, so it is built from the scenario,
 * the error and whatever analysis exists, and tagged for verification.
 */
export function adhocIssue(
  ctx: QaContext,
  test: TestRunResult,
  triage: TriageResult | undefined,
  key: string,
): Issue | undefined {
  const outcome = test.outcomes.find((o) => o.key === key);
  if (!outcome) return undefined;
  const failure = triage?.failures.find((f) => f.key === key);
  const scenario = loadAllScenarios(ctx).find((s) => s.id === outcome.scenarioId);
  const category =
    scenario?.category === 'visual' || scenario?.category === 'responsive' ? scenario.category : 'functional';
  const bug: BugDraft = failure?.bug ?? {
    title: scenario?.title ?? outcome.title,
    severity: 'medium',
    category,
    affectedPage: scenario?.page ?? '/',
    stepsToReproduce: scenario?.steps.length
      ? scenario.steps
      : [`Run test "${outcome.title}" (${outcome.project})`],
    expectedResult: scenario?.expectedResults.join(' ') ?? 'The test passes.',
    actualResult: outcome.error?.message.split('\n\n')[0] ?? 'The test failed.',
    suspectedRootCause: failure?.reasoning ?? 'unknown (not analyzed)',
  };
  const scenarioIds = [outcome.scenarioId ?? outcome.title];
  return {
    id: adhocIssueId(outcome),
    fingerprint: sha256(scenarioIds.join('|')).slice(0, 16),
    classification: failure?.classification === 'DESIGN_MISMATCH' ? 'DESIGN_MISMATCH' : 'PRODUCT_BUG',
    bug,
    failureKeys: [key],
    scenarioIds,
    confidence: failure?.confidence ?? 0,
    fileable: false,
    notFiledReason: failure ? `analyzer classified it as ${failure.classification}` : 'not analyzed',
  };
}

async function handleFile(ctx: QaContext, body: string): Promise<{ status: number; payload: unknown }> {
  const { runId, issueId, failureKey } = JSON.parse(body || '{}') as {
    runId?: string;
    issueId?: string;
    failureKey?: string;
  };
  if (!runId || (!issueId && !failureKey)) {
    return { status: 400, payload: { error: 'runId and issueId or failureKey are required' } };
  }
  const test = loadRun(ctx, runId);
  if (!test) return { status: 404, payload: { error: `Run ${runId} not found` } };
  const triage = readJson(path.join(test.runDir, 'triage.json'), TriageResultSchema);
  const issue = issueId
    ? triage?.issues.find((i) => i.id === issueId)
    : adhocIssue(ctx, test, triage, failureKey!);
  if (!issue)
    return { status: 404, payload: { error: `${issueId ?? failureKey} not found in run ${runId}` } };
  const confirmed = issueId !== undefined && triage?.issues.some((i) => i.id === issueId && i.fileable);
  try {
    const [result] = await fileIssues(ctx, test, [issue], {
      extraTags: confirmed ? [] : ['needs-verification'],
      force: true,
    });
    recordFiling(test, [result!], 'filed', 'Filed from the dashboard');
    if (result!.taskId) taskCache.delete(`${trackerInfo(ctx.config).kind}:${result!.taskId}`);
    return { status: result!.action === 'failed' ? 502 : 200, payload: result };
  } catch (err) {
    if (err instanceof FilingUnavailable)
      return { status: 409, payload: { error: err.message, status: err.status } };
    return { status: 500, payload: { error: (err as Error).message } };
  }
}

export function startUi(ctx: QaContext, opts: { port: number; host?: string }): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML);
      } else if (req.method === 'GET' && url.pathname === '/api/overview') {
        json(res, 200, await buildOverview(ctx, url.searchParams.get('run') ?? undefined));
      } else if (req.method === 'GET' && url.pathname === '/api/tasks') {
        const test = loadRun(ctx, url.searchParams.get('run') ?? '');
        if (!test) json(res, 404, { error: 'run not found' });
        else {
          const triage = readJson(path.join(test.runDir, 'triage.json'), TriageResultSchema);
          json(res, 200, { tasks: await taskLinks(ctx, test, triage, loadFiling(test)?.results ?? []) });
        }
      } else if (req.method === 'POST' && url.pathname === '/api/file') {
        const { status, payload } = await handleFile(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        serveFile(ctx, url.pathname, res);
      } else if (req.method === 'GET' && url.pathname === '/styles.css') {
        // Compiled by Tailwind at package build time (see package.json "build").
        const css = new URL('./styles.css', import.meta.url);
        if (!fs.existsSync(css)) {
          res.writeHead(404);
          res.end('/* styles.css missing: run `npm run build` in @company/ai-qa-agent */');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
          fs.createReadStream(css).pipe(res);
        }
      } else if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (err) {
      log.error(`${req.method} ${url.pathname}: ${(err as Error).message}`);
      json(res, 500, { error: (err as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve(server));
  });
}

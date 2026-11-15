import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fileIssues,
  FilingSummarySchema,
  FilingUnavailable,
  loadFiling,
  previouslyFiled,
  recordFiling,
  type FilingResult,
} from '../bugs/file.js';
import {
  createTracker,
  trackerInfo,
  trackerStatuses,
  type IssueTracker,
  type TrackerStatus,
} from '../integrations/tracker.js';
import { readJson, sha256, slugify } from '../core/fs.js';
import type { TestOutcome } from '../runner/results.js';
import type { BugDraft, Issue } from '../triage/schema.js';
import { logger } from '../core/logger.js';
import { isInside, runDir } from '../core/paths.js';
import { withSignal, type QaContext } from '../pipeline/context.js';
import { TestRunResultSchema, type TestRunResult } from '../runner/results.js';
import { scenarioTestStates, writeScenarioTest, type ScenarioTestState } from '../generate/scenario-test.js';
import { criticalFlows, isOutdatedModel, loadAppModel, type PageModel } from '../analyze/app.js';
import { deleteMedia, MediaDeleteError } from '../runner/media.js';
import { deleteRuns, RunDeleteError } from '../runner/delete-runs.js';
import { cleanStorage, StorageCleanError, storageReport } from '../runner/storage.js';
import { runScenarioTest, runScenarioTests } from '../runner/rerun.js';
import { Cancelled } from '../core/process.js';
import { runTests } from '../runner/run.js';
import { listTestIds } from '../scenarios/spec-edit.js';
import { specPath } from '../generate/playwright.js';
import { draftScenario, saveScenario, ScenarioInputError } from '../scenarios/author.js';
import { loadAllScenarios } from '../scenarios/generate.js';
import { removeScenarios } from '../scenarios/manage.js';
import { CATEGORIES, isCriticalScenario } from '../scenarios/schema.js';
import { TriageResultSchema, type TriageResult } from '../triage/schema.js';
import { planFile, planStatus, writeBugFixPlan } from '../plan/plan.js';
import { buildReport } from '../report/report.js';
import { projectStatus, runAnalysis, runCritical, runScenarios, type Progress } from './project.js';
import { saveTracker, testTracker, trackerSettings, TrackerSetupError } from './tracker-setup.js';

const log = logger('ui');

export interface Overview {
  project: { name: string; baseUrl: string };
  /** How the tests reach the app, as configured (`app.mode`). */
  app: { mode: 'production' | 'development' };
  /** Pages of the application model, for page names and importance. Null before `analyze`. */
  model: { pages: Array<{ route: string; name: string; importance: PageModel['importance'] }> } | null;
  /** The configured bug tracker (ClickUp or Jira), without secrets. */
  tracker: {
    kind: 'clickup' | 'jira' | null;
    name: string;
    noun: 'task' | 'issue';
    configured: boolean;
    tokenPresent: boolean;
    /** Names of the credential environment variables that are not set. */
    missingEnv: string[];
    target: string | null;
  };
  runs: Array<{ id: string; startedAt: string; status: string; stats: TestRunResult['stats'] | null }>;
  run: {
    id: string;
    /** What this run's tests ran against. Null for runs recorded before it was stored. */
    app: NonNullable<TestRunResult['app']> | null;
    stats: TestRunResult['stats'];
    outcomes: TestRunResult['outcomes'];
    failures: TriageResult['failures'];
    issues: TriageResult['issues'];
    filing: FilingResult[];
    /** Per failed outcome key: the tracker item known for its defect, verified against the tracker. */
    tasks: Record<string, TaskLink>;
    /** True when /api/tasks should be called to verify items (tracker configured and credentials present). */
    tasksPending: boolean;
    /** Project-relative path of the run's HTML report, served under /files/, or null before `report`. */
    report: string | null;
  } | null;
  scenarios: ReturnType<typeof loadAllScenarios>;
  /** Choices for the add/edit scenario form. */
  authoring: { pages: string[]; viewports: string[]; categories: readonly string[] };
  /** Approved scenarios whose test is missing or older than the scenario (up-to-date ones are absent). */
  testStates: Record<string, ScenarioTestState>;
  /** The test run started from the dashboard that is running now, or the last one. */
  job: Job | null;
  /** Bug-fix plan of the selected run: whether it can be made and whether it exists. */
  plan: ReturnType<typeof planStatus> | null;
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
      app: test.app ?? null,
      stats: test.stats,
      outcomes: test.outcomes,
      failures: triage?.failures ?? [],
      issues: triage?.issues ?? [],
      filing,
      // Filled in by a second request (/api/tasks) so the page never waits for the tracker.
      tasks: {},
      tasksPending: trackerInfo(ctx.config).credentialsPresent,
      report: fs.existsSync(path.join(ctx.paths.reportsDir, test.runId, 'report.html'))
        ? path
            .relative(ctx.root, path.join(ctx.paths.reportsDir, test.runId, 'report.html'))
            .split(path.sep)
            .join('/')
        : null,
    };
  }
  const info = trackerInfo(ctx.config);
  const model = loadAppModel(ctx);
  return {
    project: { name: ctx.config.project.name, baseUrl: ctx.config.app.baseUrl },
    app: { mode: ctx.config.app.mode },
    model: model
      ? { pages: model.pages.map((p) => ({ route: p.route, name: p.name, importance: p.importance })) }
      : null,
    tracker: {
      kind: info.kind,
      name: info.name,
      noun: info.noun,
      configured: info.kind !== null,
      tokenPresent: info.credentialsPresent,
      missingEnv: info.missingEnv,
      target: info.target,
    },
    runs,
    run,
    scenarios: loadAllScenarios(ctx),
    authoring: {
      pages: model?.pages.map((p) => p.route) ?? [],
      viewports: Object.keys(ctx.config.viewports),
      categories: CATEGORIES,
    },
    testStates: scenarioTestStates(ctx),
    job,
    plan: run ? planStatus(ctx, run.id) : null,
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
  const allowed = [ctx.paths.artifactsDir, ctx.paths.reportsDir, path.join(ctx.paths.qaDir, 'design')].some(
    (dir) => isInside(dir, abs),
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
  // The analysis of a test that was run again since describes an earlier failure.
  const failure = outcome.rerunAt ? undefined : triage?.failures.find((f) => f.key === key);
  const scenario = loadAllScenarios(ctx).find((s) => s.id === outcome.scenarioId);
  // Scenario categories map onto bug categories one to one, except that there is no "content" scenario.
  const category = scenario?.category ?? 'functional';
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

/** Saves, deletions and test generation edit scenario and spec files; run them one at a time. */
let writing: Promise<unknown> = Promise.resolve();

/** Long work started from the dashboard; the page polls GET /api/job until it is done. */
export interface Job {
  kind:
    'run-all' | 'run-critical' | 'run-not-run' | 'run-failed' | 'plan' | 'analyze' | 'scenarios' | 'critical';
  label: string;
  /** What a running job is doing right now, e.g. "page 2 of 4: /contact". */
  detail?: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  /** The run the results are in (known once it started). */
  runId?: string;
  message?: string;
  /** For a plan: the project-relative path of the written file. */
  file?: string;
}

let job: Job | null = null;
/** Aborts the running job's processes (Playwright, the AI CLI); see POST /api/job/cancel. */
let jobAbort: AbortController | null = null;

/** Start a job unless one is running; it runs in the write queue so it never overlaps other edits. */
function startJob(
  kind: Job['kind'],
  label: string,
  work: (setRun: (runId: string) => void, signal: AbortSignal, progress: Progress) => Promise<string>,
): { status: number; payload: unknown } {
  if (job?.status === 'running')
    return { status: 409, payload: { error: `${job.label} is still running.`, job } };
  const current: Job = { kind, label, status: 'running', startedAt: new Date().toISOString() };
  const abort = new AbortController();
  job = current;
  jobAbort = abort;
  serially(() => {
    // Cancelled while waiting in the queue: do not start at all.
    if (abort.signal.aborted) throw new Cancelled();
    return work(
      (runId) => (current.runId = runId),
      abort.signal,
      (detail) => (current.detail = detail),
    );
  })
    .then((message) => Object.assign(current, { status: 'done', message }))
    .catch((err: unknown) => {
      if (err instanceof Cancelled) {
        log.info(`${label}: cancelled`);
        // Work that saves as it goes says what it kept; everything else changed nothing.
        const message = err.message === 'Cancelled' ? 'Cancelled. Nothing was changed.' : err.message;
        Object.assign(current, { status: 'cancelled', message });
        return;
      }
      log.error(`${label}: ${(err as Error).message}`);
      Object.assign(current, { status: 'failed', message: (err as Error).message });
    })
    .finally(() => {
      current.finishedAt = new Date().toISOString();
      current.detail = undefined;
      if (jobAbort === abort) jobAbort = null;
    });
  return { status: 202, payload: current };
}

/**
 * One of the Project page's AI steps as a job. The AI stops at once on Cancel, and the message
 * ends with what the step cost when the provider reports it.
 */
function aiStep(
  ctx: QaContext,
  kind: Job['kind'],
  label: string,
  work: (ctx: QaContext, progress: Progress) => Promise<string>,
): { status: number; payload: unknown } {
  return startJob(kind, label, async (_setRun, signal, progress) => {
    const before = ctx.ai.totalCostUsd;
    const message = await work(withSignal(ctx, signal), progress);
    const cost = ctx.ai.totalCostUsd - before;
    return cost >= 0.005 ? `${message} AI cost: $${cost.toFixed(2)}.` : message;
  });
}

const NEEDS_ANALYSIS = 'Analyze the application first (step 1).';

function handleAnalyze(ctx: QaContext, body: string): { status: number; payload: unknown } {
  const { all, design } = JSON.parse(body || '{}') as { all?: unknown; design?: unknown };
  const first = !loadAppModel(ctx);
  return aiStep(
    ctx,
    'analyze',
    first
      ? 'Analyzing the application'
      : all === true
        ? 'Analyzing everything again'
        : 'Updating the analysis',
    (c, progress) => runAnalysis(c, { all: all === true, design: design === true }, progress),
  );
}

function handleScenarios(ctx: QaContext, body: string): { status: number; payload: unknown } {
  const { page, all } = JSON.parse(body || '{}') as { page?: unknown; all?: unknown };
  const model = loadAppModel(ctx);
  if (!model || isOutdatedModel(model)) return { status: 409, payload: { error: NEEDS_ANALYSIS } };
  if (page !== undefined && (typeof page !== 'string' || !model.pages.some((p) => p.route === page)))
    return { status: 400, payload: { error: 'That page is not in the analysis.' } };
  return aiStep(
    ctx,
    'scenarios',
    page ? `Writing the scenarios of ${page}` : 'Writing scenarios',
    (c, progress) => runScenarios(c, { page, all: all === true }, progress),
  );
}

function handleCritical(ctx: QaContext, body: string): { status: number; payload: unknown } {
  const { max } = JSON.parse(body || '{}') as { max?: unknown };
  if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1))
    return { status: 400, payload: { error: 'The number of flows must be a whole number, 1 or more.' } };
  const model = loadAppModel(ctx);
  if (!model || isOutdatedModel(model)) return { status: 409, payload: { error: NEEDS_ANALYSIS } };
  if (criticalFlows(model).length === 0) {
    return {
      status: 409,
      payload: {
        error:
          'The analysis ranks no journey as critical, so there is nothing to choose from. Analyze everything again (step 1).',
      },
    };
  }
  return aiStep(ctx, 'critical', 'Choosing the critical flows', (c, progress) =>
    runCritical(c, { max }, progress),
  );
}

function handleCancelJob(): { status: number; payload: unknown } {
  if (job?.status !== 'running' || !jobAbort)
    return { status: 409, payload: { error: 'No job is running.' } };
  jobAbort.abort();
  return { status: 202, payload: job };
}

const summary = (stats: TestRunResult['stats']): string =>
  `${stats.passed} passed, ${stats.failed} failed${stats.flaky ? `, ${stats.flaky} flaky` : ''}`;

/** A new run with every test, like `ai-qa-agent test`. */
function handleRunAll(ctx: QaContext): { status: number; payload: unknown } {
  return startJob('run-all', 'Running all tests', async (setRun, signal) => {
    const record = ctx.state.startRun({ command: 'test' });
    setRun(record.id);
    try {
      const res = await runTests(ctx, record.id, {}, undefined, signal);
      ctx.state.finishRun(record, 'completed');
      return `All tests ran: ${summary(res.stats)}.`;
    } catch (err) {
      ctx.state.finishRun(record, 'failed', (err as Error).message);
      throw err;
    }
  });
}

/** A new run with only the critical flows' tests, like `ai-qa-agent test --critical`. */
function handleRunCritical(ctx: QaContext): { status: number; payload: unknown } {
  const critical = new Set(
    loadAllScenarios(ctx)
      .filter(isCriticalScenario)
      .map((s) => s.id),
  );
  const ids = withTests(ctx, (s) => critical.has(s.id));
  if (ids.length === 0) {
    return {
      status: 400,
      payload: { error: 'No critical flow has a test yet. Run ai-qa-agent generate --critical.' },
    };
  }
  return startJob('run-critical', 'Running critical flows', async (setRun, signal) => {
    const record = ctx.state.startRun({ command: 'test', critical: 'true' });
    setRun(record.id);
    try {
      const res = await runTests(ctx, record.id, { scenarioIds: ids }, undefined, signal);
      ctx.state.finishRun(record, 'completed');
      return `Critical flows ran: ${summary(res.stats)}.`;
    } catch (err) {
      ctx.state.finishRun(record, 'failed', (err as Error).message);
      throw err;
    }
  });
}

/** Approved scenarios that have a test but no result in the run. */
function notRunIds(ctx: QaContext, runId: string | undefined): string[] {
  const ran = new Set(
    (runId ? (loadRun(ctx, runId)?.outcomes ?? []) : []).map((o) => o.scenarioId).filter(Boolean),
  );
  return withTests(ctx, (s) => !ran.has(s.id));
}

/** Approved scenarios whose test failed or was flaky in the run, and that still have a test. */
function failedIds(ctx: QaContext, runId: string): string[] {
  const failed = new Set(
    (loadRun(ctx, runId)?.outcomes ?? [])
      .filter((o) => o.status === 'failed' || o.status === 'flaky')
      .map((o) => o.scenarioId)
      .filter(Boolean),
  );
  return withTests(ctx, (s) => failed.has(s.id));
}

/** Ids of approved scenarios matching `pick` whose page spec has a test for them. */
function withTests(ctx: QaContext, pick: (s: { id: string; page: string }) => boolean): string[] {
  const tests = new Map<string, string[]>();
  return loadAllScenarios(ctx)
    .filter((s) => {
      if (!s.approved || !pick(s)) return false;
      const spec = specPath(ctx, s.page);
      if (!tests.has(spec))
        tests.set(spec, fs.existsSync(spec) ? listTestIds(fs.readFileSync(spec, 'utf8')) : []);
      return tests.get(spec)!.includes(s.id);
    })
    .map((s) => s.id);
}

/** Run these tests again as a job and merge their results into the run (or a new one). */
function rerunJob(
  ctx: QaContext,
  kind: 'run-not-run' | 'run-failed',
  label: string,
  ids: string[],
  runId: string | undefined,
): { status: number; payload: unknown } {
  return startJob(kind, label, async (setRun, signal) => {
    if (runId) setRun(runId);
    const res = await runScenarioTests(ctx, ids, { runId, signal });
    setRun(res.runId);
    const stats = {
      passed: res.outcomes.filter((o) => o.status === 'passed').length,
      failed: res.outcomes.filter((o) => o.status === 'failed').length,
      flaky: res.outcomes.filter((o) => o.status === 'flaky').length,
      skipped: 0,
    };
    return (
      `Ran ${ids.length - res.missing.length} of ${ids.length} tests: ${summary(stats)}.` +
      (res.missing.length ? ` No result for ${res.missing.join(', ')}.` : '')
    );
  });
}

function handleRunFailed(ctx: QaContext, body: string): { status: number; payload: unknown } {
  const { runId, ids: only } = JSON.parse(body || '{}') as { runId?: unknown; ids?: unknown };
  if (typeof runId !== 'string' || !runId) return { status: 400, payload: { error: 'runId is required' } };
  if (only !== undefined && !(Array.isArray(only) && only.every((x) => typeof x === 'string')))
    return { status: 400, payload: { error: 'ids must be a list of scenario ids' } };
  // Optionally only some of them (the tests of one defect).
  const ids = failedIds(ctx, runId).filter((id) => !only || (only as string[]).includes(id));
  if (ids.length === 0) return { status: 400, payload: { error: 'No failed tests to run in this run.' } };
  return rerunJob(
    ctx,
    'run-failed',
    `Running ${ids.length} failed test${ids.length === 1 ? '' : 's'}`,
    ids,
    runId,
  );
}

/** Write the bug-fix plan of a run into the project (same rules as `ai-qa-agent plan`). */
function handlePlan(ctx: QaContext, body: string): { status: number; payload: unknown } {
  const { runId, force } = JSON.parse(body || '{}') as { runId?: unknown; force?: unknown };
  if (typeof runId !== 'string' || !runId) return { status: 400, payload: { error: 'runId is required' } };
  const status = planStatus(ctx, runId);
  if (status.failures === 0)
    return { status: 409, payload: { error: 'No failed tests to plan in this run.' } };
  if (status.exists && force !== true) {
    return { status: 409, payload: { error: `${status.file} already exists.`, exists: true } };
  }
  return startJob(
    'plan',
    `Writing the fix plan for ${status.failures} failed test${status.failures === 1 ? '' : 's'}`,
    async (setRun, signal) => {
      setRun(runId);
      const res = await writeBugFixPlan(ctx, { runId, force: true, signal });
      if (job) job.file = res.file ?? undefined;
      return `Wrote ${res.file} with ${res.bugs} bug${res.bugs === 1 ? '' : 's'}.`;
    },
  );
}

/** The plan file's text for the dashboard viewer (only this file, never other paths). */
/**
 * The structured QA report of a run (GET /api/report?run=<id>): built from the run's stored files
 * on every request, so it reflects re-runs and filing without an AI call.
 */
function readReport(ctx: QaContext, runId: string): { status: number; payload: unknown } {
  if (!/^[\w-]+$/.test(runId)) return { status: 400, payload: { error: 'invalid run id' } };
  const dir = runDir(ctx.paths, runId);
  const test = readJson(path.join(dir, 'results.json'), TestRunResultSchema);
  if (!test) return { status: 404, payload: { error: `Run ${runId} has no results.` } };
  const triage = readJson(path.join(dir, 'triage.json'), TriageResultSchema) ?? null;
  const filing = readJson(path.join(dir, 'filing.json'), FilingSummarySchema) ?? null;
  return { status: 200, payload: buildReport(ctx, test, triage, filing, triage?.costUsd ?? 0) };
}

function readPlan(ctx: QaContext, runId: string): { status: number; payload: unknown } {
  if (!/^[\w-]+$/.test(runId)) return { status: 400, payload: { error: 'invalid run id' } };
  const file = planFile(ctx, runId);
  if (!fs.existsSync(file)) return { status: 404, payload: { error: 'No plan for this run yet.' } };
  return {
    status: 200,
    payload: {
      file: path.relative(ctx.root, file).split(path.sep).join('/'),
      text: fs.readFileSync(file, 'utf8'),
    },
  };
}

function handleRunNotRun(ctx: QaContext, body: string): { status: number; payload: unknown } {
  const { runId } = JSON.parse(body || '{}') as { runId?: unknown };
  if (runId !== undefined && typeof runId !== 'string')
    return { status: 400, payload: { error: 'runId must be a string' } };
  const ids = notRunIds(ctx, runId);
  if (ids.length === 0)
    return { status: 400, payload: { error: 'Every test already has a result in this run.' } };
  return rerunJob(
    ctx,
    'run-not-run',
    `Running ${ids.length} not-run test${ids.length === 1 ? '' : 's'}`,
    ids,
    runId,
  );
}

/** Tracker checks contact the tracker; reuse the answer for a minute unless a refresh asks. */
let trackerCache: { at: number; value: TrackerStatus[] } | undefined;

/** Test a tracker connection, or test and save it (Bug tracker page). */
async function handleTracker(
  ctx: QaContext,
  raw: string,
  save: boolean,
): Promise<{ status: number; payload: unknown }> {
  let body: unknown;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return { status: 400, payload: { error: 'invalid JSON body' } };
  }
  try {
    const target = save ? await saveTracker(ctx, body) : await testTracker(ctx.config, body);
    if (save) trackerCache = undefined;
    return {
      status: 200,
      payload: {
        target,
        settings: trackerSettings(ctx.config),
        trackers: save ? await trackerStatus(ctx, true) : undefined,
      },
    };
  } catch (err) {
    return {
      status: err instanceof TrackerSetupError ? 400 : 500,
      payload: { error: (err as Error).message },
    };
  }
}
async function trackerStatus(ctx: QaContext, fresh: boolean): Promise<TrackerStatus[]> {
  if (!fresh && trackerCache && Date.now() - trackerCache.at < 60_000) return trackerCache.value;
  trackerCache = { at: Date.now(), value: await trackerStatuses(ctx.config) };
  return trackerCache.value;
}

function serially<T>(fn: () => T | Promise<T>): Promise<T> {
  const task = writing.then(fn);
  writing = task.catch(() => undefined);
  return task;
}

async function handleDeleteScenario(
  ctx: QaContext,
  body: string,
): Promise<{ status: number; payload: unknown }> {
  const { id, reason } = JSON.parse(body || '{}') as { id?: unknown; reason?: unknown };
  if (typeof id !== 'string' || !id.trim()) return { status: 400, payload: { error: 'id is required' } };
  try {
    const [removed] = await serially(() =>
      removeScenarios(ctx, [id], { reason: typeof reason === 'string' ? reason.trim() : undefined }),
    );
    return { status: 200, payload: removed };
  } catch (err) {
    const message = (err as Error).message;
    return {
      status: /^Unknown scenario|already removed/.test(message) ? 404 : 409,
      payload: { error: message },
    };
  }
}

/** Delete one screenshot/video of a result, or all of them, and drop them from results.json. */
function handleDeleteMedia(ctx: QaContext, body: string): { status: number; payload: unknown } {
  const { runId, key, file } = JSON.parse(body || '{}') as { runId?: unknown; key?: unknown; file?: unknown };
  try {
    return { status: 200, payload: deleteMedia(ctx, { runId, key, file }) };
  } catch (err) {
    if (err instanceof MediaDeleteError) return { status: err.status, payload: { error: err.message } };
    throw err;
  }
}

/** Delete old runs with their evidence and reports; a run a job is using is refused. */
function handleDeleteRuns(ctx: QaContext, body: string): { status: number; payload: unknown } {
  const { ids } = JSON.parse(body || '{}') as { ids?: unknown };
  try {
    return { status: 200, payload: deleteRuns(ctx, { ids, inUse: jobUse().inUse }) };
  } catch (err) {
    if (err instanceof RunDeleteError) return { status: err.status, payload: { error: err.message } };
    throw err;
  }
}

/** The run a running job writes to, and whether any job is running. */
function jobUse(): { busy: boolean; inUse: string[] } {
  const busy = job?.status === 'running';
  return { busy, inUse: busy && job?.runId ? [job.runId] : [] };
}

/** Free disk space: raw Playwright output, logs, leftover folders and/or old runs. */
function handleCleanStorage(ctx: QaContext, body: string): { status: number; payload: unknown } {
  const { kinds } = JSON.parse(body || '{}') as { kinds?: unknown };
  try {
    const res = cleanStorage(ctx, { kinds, ...jobUse() });
    return { status: 200, payload: { ...res, storage: storageReport(ctx, jobUse()) } };
  } catch (err) {
    if (err instanceof StorageCleanError) return { status: err.status, payload: { error: err.message } };
    throw err;
  }
}

async function handleSaveScenario(
  ctx: QaContext,
  body: string,
): Promise<{ status: number; payload: unknown }> {
  const { id, scenario } = JSON.parse(body || '{}') as { id?: unknown; scenario?: unknown };
  if (id !== undefined && typeof id !== 'string')
    return { status: 400, payload: { error: 'id must be a string' } };
  try {
    return { status: 200, payload: await serially(() => saveScenario(ctx, scenario, id)) };
  } catch (err) {
    if (err instanceof ScenarioInputError) return { status: 400, payload: { error: err.message } };
    throw err;
  }
}

async function handleDraftScenario(
  ctx: QaContext,
  body: string,
): Promise<{ status: number; payload: unknown }> {
  const { page, description } = JSON.parse(body || '{}') as { page?: unknown; description?: unknown };
  if (typeof page !== 'string' || typeof description !== 'string') {
    return { status: 400, payload: { error: 'page and description are required' } };
  }
  try {
    return { status: 200, payload: await draftScenario(ctx, { page, description }) };
  } catch (err) {
    if (err instanceof ScenarioInputError) return { status: 400, payload: { error: err.message } };
    return { status: 502, payload: { error: `The AI could not draft it: ${(err as Error).message}` } };
  }
}

async function handleWriteTest(ctx: QaContext, body: string): Promise<{ status: number; payload: unknown }> {
  const { id } = JSON.parse(body || '{}') as { id?: unknown };
  if (typeof id !== 'string' || !id.trim()) return { status: 400, payload: { error: 'id is required' } };
  try {
    return { status: 200, payload: await serially(() => writeScenarioTest(ctx, id)) };
  } catch (err) {
    const message = (err as Error).message;
    return {
      status: /^Unknown scenario|not approved/.test(message) ? 404 : 500,
      payload: { error: message },
    };
  }
}

async function handleRunTest(ctx: QaContext, body: string): Promise<{ status: number; payload: unknown }> {
  const { id, runId } = JSON.parse(body || '{}') as { id?: unknown; runId?: unknown };
  if (typeof id !== 'string' || !id.trim()) return { status: 400, payload: { error: 'id is required' } };
  if (runId !== undefined && typeof runId !== 'string') {
    return { status: 400, payload: { error: 'runId must be a string' } };
  }
  try {
    return { status: 200, payload: await serially(() => runScenarioTest(ctx, id, { runId })) };
  } catch (err) {
    const message = (err as Error).message;
    return {
      status: /^Unknown scenario|has no test yet/.test(message) ? 404 : 500,
      payload: { error: message },
    };
  }
}

/**
 * The dashboard's own files, compiled into dist/ui at package build time: the page (`/`) and its
 * ES modules (`/client/*.js`). Nothing else under dist is reachable.
 */
function serveAsset(urlPath: string, res: http.ServerResponse, basePath = ''): void {
  const uiDir = fileURLToPath(new URL('.', import.meta.url));
  const clientDir = path.join(uiDir, 'client');
  const file =
    urlPath === '/'
      ? path.join(uiDir, 'index.html')
      : path.resolve(clientDir, decodeURIComponent(urlPath.slice('/client/'.length)));
  const allowed = urlPath === '/' || (file.startsWith(clientDir + path.sep) && file.endsWith('.js'));
  if (!allowed || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      urlPath === '/'
        ? 'Dashboard not built: run `npm run build` in @mohammadvazifedoost/ai-qa-agent'
        : 'Not found',
    );
    return;
  }
  res.writeHead(200, {
    'Content-Type': urlPath === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  if (urlPath === '/' && basePath) {
    res.end(withBaseHref(fs.readFileSync(file, 'utf8'), basePath));
    return;
  }
  fs.createReadStream(file).pipe(res);
}

/**
 * The path a reverse proxy serves the dashboard under (`--base-path /qa`), without a trailing slash,
 * or '' for none. Only plain path segments are accepted, since the value is written into the page.
 */
export function normalizeBasePath(value: string | undefined): string {
  // Git Bash turns "/blog/admin/qa" into "C:/Program Files/Git/blog/admin/qa"; undo that.
  const unmangled = (value ?? '').trim().replace(/^[A-Za-z]:[\\/](?:Program Files[\\/])?Git[\\/]/i, '/');
  const trimmed = unmangled.replace(/\/+$/, '');
  if (!trimmed) return '';
  const withSlash = trimmed.startsWith('/') ? trimmed : '/' + trimmed;
  if (
    !/^(\/[A-Za-z0-9._~-]+)+$/.test(withSlash) ||
    withSlash.split('/').some((s) => s === '.' || s === '..')
  ) {
    throw new Error(`--base-path must be a URL path such as /qa or /blog/admin/qa (got "${value}")`);
  }
  return withSlash;
}

/** The page with a `<base href>` for `basePath`: its relative URLs (API, files, assets) then resolve under it. */
export function withBaseHref(html: string, basePath: string): string {
  return basePath ? html.replace(/<head>/i, `<head>\n    <base href="${basePath}/" />`) : html;
}

/** The request path inside the dashboard: `basePath` is removed when the proxy passed it through. */
export function appPath(pathname: string, basePath: string): string {
  if (!basePath) return pathname;
  if (pathname === basePath) return '/';
  return pathname.startsWith(basePath + '/') ? pathname.slice(basePath.length) : pathname;
}

export function startUi(
  ctx: QaContext,
  opts: { port: number; host?: string; basePath?: string },
): Promise<http.Server> {
  const basePath = normalizeBasePath(opts.basePath);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    url.pathname = appPath(url.pathname, basePath);
    // Every change is a JSON request from the page itself. A plain form on another site cannot
    // send one without the browser asking this server first, which it never allows.
    if (req.method === 'POST' && !/^application\/json/i.test(req.headers['content-type'] ?? '')) {
      json(res, 415, { error: 'Send JSON (Content-Type: application/json).' });
      return;
    }
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/client/'))) {
        serveAsset(url.pathname, res, basePath);
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
      } else if (req.method === 'POST' && url.pathname === '/api/scenarios/delete') {
        const { status, payload } = await handleDeleteScenario(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'GET' && url.pathname === '/api/storage') {
        json(res, 200, storageReport(ctx, jobUse()));
      } else if (req.method === 'POST' && url.pathname === '/api/storage/clean') {
        const { status, payload } = handleCleanStorage(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/runs/delete') {
        const { status, payload } = handleDeleteRuns(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/media/delete') {
        const { status, payload } = handleDeleteMedia(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/scenarios/save') {
        const { status, payload } = await handleSaveScenario(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/scenarios/draft') {
        const { status, payload } = await handleDraftScenario(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'GET' && url.pathname === '/api/trackers') {
        json(res, 200, { trackers: await trackerStatus(ctx, url.searchParams.has('fresh')) });
      } else if (req.method === 'GET' && url.pathname === '/api/tracker') {
        json(res, 200, trackerSettings(ctx.config));
      } else if (req.method === 'POST' && url.pathname === '/api/tracker/test') {
        const { status, payload } = await handleTracker(ctx, await readBody(req), false);
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/tracker/save') {
        const { status, payload } = await handleTracker(ctx, await readBody(req), true);
        json(res, status, payload);
      } else if (req.method === 'GET' && url.pathname === '/api/job') {
        json(res, 200, { job });
      } else if (req.method === 'POST' && url.pathname === '/api/plan') {
        const { status, payload } = handlePlan(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'GET' && url.pathname === '/api/report') {
        const { status, payload } = readReport(ctx, url.searchParams.get('run') ?? '');
        json(res, status, payload);
      } else if (req.method === 'GET' && url.pathname === '/api/plan') {
        const { status, payload } = readPlan(ctx, url.searchParams.get('run') ?? '');
        json(res, status, payload);
      } else if (req.method === 'GET' && url.pathname === '/api/project') {
        json(res, 200, projectStatus(ctx));
      } else if (req.method === 'POST' && url.pathname === '/api/project/analyze') {
        const { status, payload } = handleAnalyze(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/project/scenarios') {
        const { status, payload } = handleScenarios(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/project/critical') {
        const { status, payload } = handleCritical(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/job/cancel') {
        const { status, payload } = handleCancelJob();
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/runs/failed') {
        const { status, payload } = handleRunFailed(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/runs/all') {
        const { status, payload } = handleRunAll(ctx);
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/runs/critical') {
        const { status, payload } = handleRunCritical(ctx);
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/runs/not-run') {
        const { status, payload } = handleRunNotRun(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/scenarios/run') {
        const { status, payload } = await handleRunTest(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'POST' && url.pathname === '/api/scenarios/test') {
        const { status, payload } = await handleWriteTest(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        serveFile(ctx, url.pathname, res);
      } else if (req.method === 'GET' && url.pathname === '/styles.css') {
        // Compiled by Tailwind at package build time (see package.json "build").
        const css = new URL('./styles.css', import.meta.url);
        if (!fs.existsSync(css)) {
          res.writeHead(404);
          res.end('/* styles.css missing: run `npm run build` in @mohammadvazifedoost/ai-qa-agent */');
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

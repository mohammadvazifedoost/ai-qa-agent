import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileIssues, FilingUnavailable, loadFiling, recordFiling, type FilingResult } from '../bugs/file.js';
import { readJson } from '../core/fs.js';
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
  clickup: { configured: boolean; tokenPresent: boolean; listId: string | null };
  runs: Array<{ id: string; startedAt: string; status: string; stats: TestRunResult['stats'] | null }>;
  run: {
    id: string;
    stats: TestRunResult['stats'];
    outcomes: TestRunResult['outcomes'];
    failures: TriageResult['failures'];
    issues: TriageResult['issues'];
    filing: FilingResult[];
  } | null;
  scenarios: ReturnType<typeof loadAllScenarios>;
}

function loadRun(ctx: QaContext, id: string): TestRunResult | undefined {
  return readJson(path.join(runDir(ctx.paths, id), 'results.json'), TestRunResultSchema);
}

/** Everything the dashboard shows, assembled from the files the pipeline already writes. */
export function buildOverview(ctx: QaContext, runId?: string): Overview {
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
    run = {
      id: test.runId,
      stats: test.stats,
      outcomes: test.outcomes,
      failures: triage?.failures ?? [],
      issues: triage?.issues ?? [],
      filing: loadFiling(test)?.results ?? [],
    };
  }
  const cfg = ctx.config.clickup;
  return {
    project: { name: ctx.config.project.name, baseUrl: ctx.config.app.baseUrl },
    clickup: {
      configured: !!cfg,
      tokenPresent: !!cfg && !!process.env[cfg.tokenEnv],
      listId: cfg?.listId ?? null,
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

async function handleFile(ctx: QaContext, body: string): Promise<{ status: number; payload: unknown }> {
  const { runId, issueId } = JSON.parse(body || '{}') as { runId?: string; issueId?: string };
  if (!runId || !issueId) return { status: 400, payload: { error: 'runId and issueId are required' } };
  const test = loadRun(ctx, runId);
  const triage = test && readJson(path.join(test.runDir, 'triage.json'), TriageResultSchema);
  const issue = triage?.issues.find((i) => i.id === issueId);
  if (!test || !issue)
    return { status: 404, payload: { error: `Issue ${issueId} not found in run ${runId}` } };
  try {
    const [result] = await fileIssues(ctx, test, [issue]);
    recordFiling(test, [result!], 'filed', 'Filed from the dashboard');
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
        json(res, 200, buildOverview(ctx, url.searchParams.get('run') ?? undefined));
      } else if (req.method === 'POST' && url.pathname === '/api/file') {
        const { status, payload } = await handleFile(ctx, await readBody(req));
        json(res, status, payload);
      } else if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        serveFile(ctx, url.pathname, res);
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

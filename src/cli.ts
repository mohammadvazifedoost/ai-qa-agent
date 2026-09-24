#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { checkClaude } from './ai/claude.js';
import { logger, setLogLevel } from './core/logger.js';
import { rel } from './core/paths.js';
import { initProject } from './init/init.js';
import { createContext } from './pipeline/context.js';
import { extractDesign } from './design/figma.js';
import { analyzeApp } from './analyze/app.js';
import { generateScenarios, normalizePageArg, pageSlug } from './scenarios/generate.js';
import { generateTests } from './generate/playwright.js';
import { runTests, type TestFilter } from './runner/run.js';
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './core/fs.js';
import { runDir } from './core/paths.js';
import type { QaContext } from './pipeline/context.js';
import { runPipeline } from './pipeline/run.js';
import { TestRunResultSchema, type TestRunResult } from './runner/results.js';
import { triageRun } from './triage/triage.js';
import { TriageResultSchema } from './triage/schema.js';
import { writeReport } from './report/report.js';
import { FilingSummarySchema } from './bugs/file.js';
import { ClickUpClient } from './integrations/clickup.js';
import { chromium } from '@playwright/test';

interface Scope {
  page?: string;
  category?: string;
  feature?: string;
  grep?: string[];
}

function scopeToFilter(o: Scope): TestFilter {
  const tags = [o.category, o.feature].filter((t): t is string => !!t).map((t) => `@${t}`);
  return {
    files: o.page ? [`${pageSlug(normalizePageArg(o.page))}.spec.ts`] : undefined,
    tags: tags.length ? tags : undefined,
    scenarioIds: o.grep,
  };
}

const log = logger('cli');
const program = new Command();

program
  .name('ai-qa')
  .description(
    'AI QA agent: design + code analysis, Playwright test generation, failure triage, ClickUp bugs',
  )
  .version('0.1.0')
  .option('-C, --cwd <dir>', 'target project root', process.cwd())
  .option('--debug', 'verbose logging')
  .hook('preAction', (cmd) => {
    if (cmd.opts<{ debug?: boolean }>().debug) setLogLevel('debug');
  });

const root = (): string => program.opts<{ cwd: string }>().cwd;

program
  .command('init')
  .description('detect the project and create .qa/config.ts')
  .option('--figma <url>', 'Figma file URL holding the designs')
  .option('--clickup-list <id>', 'ClickUp list id where bugs are created')
  .option('--base-url <url>', 'URL the app is served at (default: detected dev port)')
  .option('--force', 'overwrite an existing .qa/config.ts')
  .action((o: { figma?: string; clickupList?: string; baseUrl?: string; force?: boolean }) => {
    const { created } = initProject({
      root: root(),
      force: o.force,
      figmaUrl: o.figma,
      clickupListId: o.clickupList,
      baseUrl: o.baseUrl,
    });
    for (const f of created) console.log(`  ${pc.green('created')} ${rel(root(), f)}`);
    console.log(
      `\nNext: review .qa/config.ts, then run ${pc.bold('npx ai-qa doctor')} and ${pc.bold('npx ai-qa run')}.`,
    );
  });

program
  .command('doctor')
  .description('check that Claude Code, Playwright and integrations are usable')
  .action(async () => {
    const ctx = await createContext(root());
    let failed = false;
    const line = (ok: boolean | null, text: string): void => {
      const mark = ok === null ? pc.cyan('•') : ok ? pc.green('✔') : pc.red('✘');
      if (ok === false) failed = true;
      console.log(`${mark} ${text}`);
    };
    const claude = await checkClaude(ctx.config.ai.claudePath);
    line(claude.ok, `Claude Code CLI: ${claude.detail}`);

    const browserPath = chromium.executablePath();
    line(fs.existsSync(browserPath), `Playwright chromium: ${fs.existsSync(browserPath) ? browserPath : 'not installed — run: npx playwright install chromium'}`);

    const reachable = await fetch(ctx.config.app.baseUrl, { signal: AbortSignal.timeout(3000) }).then((r) => r.status < 500).catch(() => false);
    line(null, `App at ${ctx.config.app.baseUrl}: ${reachable ? 'reachable' : `not running${ctx.config.app.startCommand ? ` (will be started with "${ctx.config.app.startCommand}")` : ' and no startCommand configured'}`}`);

    for (const name of Object.keys(ctx.config.ai.mcpServers)) line(null, `MCP server for AI tasks: ${name}`);
    if (ctx.config.figma) {
      line(!!ctx.config.ai.mcpServers.figma, `Figma: ${ctx.config.figma.fileUrl}${ctx.config.ai.mcpServers.figma ? '' : ' — ai.mcpServers.figma is missing'}`);
    } else line(null, 'Figma: not configured (visual tests will rely on code only)');

    if (ctx.config.clickup) {
      const token = process.env[ctx.config.clickup.tokenEnv];
      if (!token) line(false, `ClickUp: environment variable ${ctx.config.clickup.tokenEnv} is not set`);
      else {
        try {
          const list = await new ClickUpClient(token).getList(ctx.config.clickup.listId);
          line(true, `ClickUp: token valid, bugs go to list "${list.name}" (${list.id})`);
        } catch (err) {
          line(false, `ClickUp: ${(err as Error).message}`);
        }
      }
    } else line(null, 'ClickUp: not configured (bugs will only be written to the local report)');
    if (failed) process.exitCode = 1;
  });

program
  .command('analyze')
  .description('analyze the application source and the Figma design')
  .option('--refresh', 'ignore cached results and re-analyze')
  .option('--skip-design', 'only analyze the application source')
  .action(async (o: { refresh?: boolean; skipDesign?: boolean }) => {
    const ctx = await createContext(root());
    await analyzeApp(ctx, { force: o.refresh });
    if (!o.skipDesign) await extractDesign(ctx, { force: o.refresh });
  });

program
  .command('scenarios')
  .description('generate or update test scenarios in .qa/scenarios/')
  .option('--page <route>', 'only this page (route or name)')
  .option('--force', 'regenerate even if inputs did not change')
  .option('--max <n>', 'maximum scenarios per page', (v) => Number(v), 10)
  .action(async (o: { page?: string; force?: boolean; max: number }) => {
    const ctx = await createContext(root());
    const all = await generateScenarios(ctx, { page: o.page, force: o.force, maxPerPage: o.max });
    const by = (k: 'category' | 'priority') =>
      Object.entries(Object.groupBy(all, (s) => s[k]))
        .map(([n, l]) => `${n}=${l?.length}`)
        .join(' ');
    console.log(`${all.length} scenarios (${by('category')}; ${by('priority')})`);
  });

program
  .command('generate')
  .description('generate Playwright tests in .qa/tests/ from approved scenarios')
  .option('--page <route>', 'only this page (route or name)')
  .option('--force', 'regenerate even if scenarios did not change')
  .action(async (o: { page?: string; force?: boolean }) => {
    const ctx = await createContext(root());
    const files = await generateTests(ctx, o);
    for (const f of files) console.log(`  ${pc.green('generated')} ${rel(ctx.root, f)}`);
  });

program
  .command('test')
  .description('run the generated Playwright tests and collect evidence (no AI)')
  .option('--page <route>', 'only this page (route or name)')
  .option('--category <category>', 'functional | visual | responsive')
  .option('--feature <feature>', 'feature tag, e.g. auth')
  .option('--grep <ids...>', 'scenario ids')
  .action(async (o: { page?: string; category?: string; feature?: string; grep?: string[] }) => {
    const ctx = await createContext(root());
    const run = ctx.state.startRun({ command: 'test' });
    const res = await runTests(ctx, run.id, scopeToFilter(o));
    ctx.state.finishRun(run, 'completed');
    if (res.stats.failed > 0 || res.globalErrors.length) process.exitCode = 1;
  });

function loadRun(ctx: QaContext, runId?: string): TestRunResult {
  const id =
    runId ??
    [...ctx.state.data.runs]
      .reverse()
      .find((r) => fs.existsSync(path.join(runDir(ctx.paths, r.id), 'results.json')))?.id;
  if (!id) throw new Error('No test run with results found. Run `ai-qa test` first.');
  const res = readJson(path.join(runDir(ctx.paths, id), 'results.json'), TestRunResultSchema);
  if (!res) throw new Error(`Run ${id} has no results.json`);
  return res;
}

program
  .command('triage')
  .description('analyze failures of a test run and classify them (no filing)')
  .option('--run <id>', 'run id (default: latest run with results)')
  .action(async (o: { run?: string }) => {
    const ctx = await createContext(root());
    const test = loadRun(ctx, o.run);
    const triage = await triageRun(ctx, test);
    const report = writeReport(ctx, test, triage, null, ctx.ai.totalCostUsd);
    console.log(`Report: ${rel(ctx.root, report.markdown)}`);
  });

program
  .command('report')
  .description('(re)build the report for a run from its stored results')
  .option('--run <id>', 'run id (default: latest run with results)')
  .action(async (o: { run?: string }) => {
    const ctx = await createContext(root());
    const test = loadRun(ctx, o.run);
    const dir = runDir(ctx.paths, test.runId);
    const triage = readJson(path.join(dir, 'triage.json'), TriageResultSchema) ?? null;
    const filing = readJson(path.join(dir, 'filing.json'), FilingSummarySchema) ?? null;
    const report = writeReport(ctx, test, triage, filing, triage?.costUsd ?? 0);
    console.log(`Report: ${rel(ctx.root, report.markdown)}`);
  });

program
  .command('run')
  .description('full pipeline: analyze → scenarios → generate → test → triage → file bugs → report')
  .option('--page <route>', 'only this page (route or name)')
  .option('--category <category>', 'only run tests of this category: functional | visual | responsive')
  .option('--feature <feature>', 'only run tests of this feature tag, e.g. auth')
  .option('--resume', 'continue the last unfinished run')
  .option('--refresh', 'ignore caches and re-analyze code and design')
  .option('--no-file', 'do not create ClickUp tasks')
  .action(async (o: Scope & { resume?: boolean; refresh?: boolean; file: boolean }) => {
    const ctx = await createContext(root());
    const res = await runPipeline(ctx, {
      page: o.page,
      filter: scopeToFilter(o),
      resume: o.resume,
      refresh: o.refresh,
      file: o.file,
    });
    const s = res.test.stats;
    console.log(
      `\n${pc.bold('Result')}: ${s.passed} passed, ${s.failed} failed · ${res.triage.issues.length} defect(s) · ${res.filing.message}\n` +
        `Report: ${rel(ctx.root, res.report.markdown)}`,
    );
    if (res.triage.issues.length) process.exitCode = 1;
  });

program.parseAsync().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  if (process.env.AI_QA_DEBUG && err instanceof Error) console.error(err.stack);
  process.exit(1);
});

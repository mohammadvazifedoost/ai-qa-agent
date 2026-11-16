#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { checkProvider } from './ai/index.js';
import { ENV_OVERRIDES } from './config/load.js';
import type { QaConfig } from './config/schema.js';
import { logger, setLogLevel } from './core/logger.js';
import { rel } from './core/paths.js';
import { initProject, type InitOptions } from './init/init.js';
import { createContext } from './pipeline/context.js';
import { extractDesign } from './design/figma.js';
import { analyzeApp } from './analyze/app.js';
import { generateScenarios, normalizePageArg, pageSlug } from './scenarios/generate.js';
import { generateTests } from './generate/playwright.js';
import { generateCriticalTests } from './generate/scenario-test.js';
import { criticalTestFilter, generateCriticalScenarios } from './scenarios/critical.js';
import {
  formatScenarioTable,
  listScenarioRows,
  removeScenarios,
  restoreScenarios,
} from './scenarios/manage.js';
import { runTests, type TestFilter } from './runner/run.js';
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './core/fs.js';
import { runDir } from './core/paths.js';
import type { QaContext } from './pipeline/context.js';
import { runPipeline } from './pipeline/run.js';
import {
  describeChanges,
  detectCodeChanges,
  detectDesignChanges,
  routesToAnalyze,
} from './changes/detect.js';
import { loadDesign } from './scenarios/generate.js';
import { normalizeBasePath, startUi } from './ui/server.js';
import { TestRunResultSchema, type TestRunResult } from './runner/results.js';
import { triageRun } from './triage/triage.js';
import { TriageResultSchema } from './triage/schema.js';
import { writeReport } from './report/report.js';
import { writeBugFixPlan } from './plan/plan.js';
import { FilingSummarySchema } from './bugs/file.js';
import { createTracker, trackerInfo } from './integrations/tracker.js';
import { chromium } from '@playwright/test';
import { describePlan, productionPlan } from './runner/production.js';

interface Scope {
  page?: string;
  category?: string;
  feature?: string;
  grep?: string[];
  critical?: boolean;
}

/** The project and app URL in effect, and whether this environment overrides config.ts. */
function projectLine(config: QaConfig): string {
  const from = (name: string): string => (process.env[name]?.trim() ? ` (from ${name})` : '');
  return `Project: ${config.project.name}${from(ENV_OVERRIDES.projectName)}, app at ${config.app.baseUrl}${from(ENV_OVERRIDES.appUrl)}`;
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
  .name('ai-qa-agent')
  .description(
    'AI QA Agent: design + code analysis, Playwright test generation, failure triage, ClickUp / Jira bugs',
  )
  .version('0.4.3')
  .option('-C, --cwd <dir>', 'target project root', process.cwd())
  .option('--debug', 'verbose logging')
  .hook('preAction', (cmd) => {
    if (cmd.opts<{ debug?: boolean }>().debug) setLogLevel('debug');
  });

const root = (): string => program.opts<{ cwd: string }>().cwd;

interface InitFlags {
  figma?: string;
  clickupList?: string;
  jiraUrl?: string;
  jiraProject?: string;
  jiraEmail?: string;
  ai?: string;
  model?: string;
  baseUrl?: string;
  force?: boolean;
}

program
  .command('init')
  .description('detect the project and create .qa/config.ts')
  .option('--figma <url>', 'Figma file URL holding the designs')
  .option('--clickup-list <id>', 'ClickUp list id where bugs are created')
  .option('--jira-url <url>', 'Jira Cloud site, e.g. https://yourco.atlassian.net')
  .option('--jira-project <key>', 'Jira project key where bugs are created')
  .option('--jira-email <email>', 'Atlassian account email (or set JIRA_EMAIL)')
  .option('--ai <provider>', 'AI engine: claude-code (default), codex or opencode')
  .option('--model <model>', 'model for the AI engine (provider-specific)')
  .option('--base-url <url>', 'URL the app is served at (default: detected dev port)')
  .option('--force', 'overwrite an existing .qa/config.ts')
  .action((o: InitFlags) => {
    if (o.ai && !['claude-code', 'codex', 'opencode'].includes(o.ai)) {
      throw new Error(`--ai must be claude-code, codex or opencode (got "${o.ai}")`);
    }
    if (!!o.jiraUrl !== !!o.jiraProject) throw new Error('--jira-url and --jira-project go together');
    const { created } = initProject({
      root: root(),
      force: o.force,
      figmaUrl: o.figma,
      clickupListId: o.clickupList,
      jiraUrl: o.jiraUrl,
      jiraProject: o.jiraProject,
      jiraEmail: o.jiraEmail,
      ai: o.ai as InitOptions['ai'],
      model: o.model,
      baseUrl: o.baseUrl,
    });
    for (const f of created) console.log(`  ${pc.green('created')} ${rel(root(), f)}`);
    console.log(
      `\nNext: review .qa/config.ts, then run ${pc.bold('npx ai-qa-agent doctor')} and ${pc.bold('npx ai-qa-agent run')}.`,
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
    line(null, projectLine(ctx.config));
    const claude = await checkProvider(ctx.config);
    line(claude.ok, `AI engine: ${claude.detail}`);

    const browserPath = chromium.executablePath();
    line(
      fs.existsSync(browserPath),
      `Playwright chromium: ${fs.existsSync(browserPath) ? browserPath : 'not installed — run: npx playwright install chromium'}`,
    );

    if (ctx.config.app.mode === 'production') {
      try {
        line(
          true,
          `App under test: production build — ${describePlan(productionPlan(ctx.root, ctx.config))}`,
        );
      } catch (err) {
        line(false, (err as Error).message);
      }
    } else {
      const reachable = await fetch(ctx.config.app.baseUrl, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.status < 500)
        .catch(() => false);
      line(
        null,
        `App under test: DEVELOPMENT server at ${ctx.config.app.baseUrl} (results are not production-validated): ${reachable ? 'reachable' : `not running${ctx.config.app.startCommand ? ` (will be started with "${ctx.config.app.startCommand}")` : ' and no startCommand configured'}`}`,
      );
    }

    for (const name of Object.keys(ctx.config.ai.mcpServers)) line(null, `MCP server for AI tasks: ${name}`);
    if (ctx.config.figma) {
      line(
        !!ctx.config.ai.mcpServers.figma,
        `Figma: ${ctx.config.figma.fileUrl}${ctx.config.ai.mcpServers.figma ? '' : ' — ai.mcpServers.figma is missing'}`,
      );
    } else line(null, 'Figma: not configured (visual tests will rely on code only)');

    const info = trackerInfo(ctx.config);
    if (!info.kind) line(null, 'Bug tracker: not configured (bugs will only be written to the local report)');
    else {
      try {
        const tracker = createTracker(ctx.config);
        line(true, `${tracker.name}: credentials valid, bugs go to ${await tracker.describeTarget()}`);
      } catch (err) {
        line(false, `${info.name}: ${(err as Error).message}`);
      }
    }
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

const scenarios = program
  .command('scenarios')
  .description('generate or update test scenarios in .qa/scenarios/ (subcommands: list, remove, restore)')
  .option('--page <route>', 'only this page (route or name)')
  .option('--force', 'regenerate even if inputs did not change')
  .option(
    '--max <n>',
    'maximum scenarios per page; with --critical, maximum critical flows (default: scenarios.maxPerPage / scenarios.maxCritical in the config, or no limit)',
    (v) => Number(v),
  )
  .option('--critical', 'only the critical flows: a few end-to-end core journeys used as smoke tests')
  .action(async (o: { page?: string; force?: boolean; max?: number; critical?: boolean }) => {
    const ctx = await createContext(root());
    if (o.critical) {
      if (o.page) throw new Error('--critical covers the whole app; it cannot be combined with --page');
      const flows = await generateCriticalScenarios(ctx, { force: o.force, max: o.max });
      console.log(`${flows.length} critical flow${flows.length === 1 ? '' : 's'}`);
      for (const s of flows) console.log(`  ${s.id}  ${pc.dim(s.page)}  ${s.title}`);
      return;
    }
    const all = await generateScenarios(ctx, { page: o.page, force: o.force, maxPerPage: o.max });
    const by = (k: 'category' | 'priority') =>
      Object.entries(Object.groupBy(all, (s) => s[k]))
        .map(([n, l]) => `${n}=${l?.length}`)
        .join(' ');
    const critical = all.filter((s) => s.critical).length;
    console.log(
      `${all.length} scenarios (${by('category')}; ${by('priority')}${critical ? `; critical=${critical}` : ''})`,
    );
  });

scenarios
  .command('list')
  .description('list scenarios with id, type, page, status and title')
  .option('--page <route>', 'only this page (route or name)')
  .option('--removed', 'also show removed scenarios')
  .action(async (o: { page?: string; removed?: boolean }) => {
    const ctx = await createContext(root());
    // Commander hands `--page` to the parent `scenarios` command, which declares the same option.
    const page = o.page ?? scenarios.opts<{ page?: string }>().page;
    const rows = listScenarioRows(ctx, { page, removed: o.removed });
    if (rows.length === 0) {
      console.log('No scenarios yet. Run `ai-qa-agent scenarios` first.');
      return;
    }
    for (const [i, line] of formatScenarioTable(rows).entries()) console.log(i === 0 ? pc.dim(line) : line);
  });

scenarios
  .command('remove')
  .description('delete scenarios and their tests; they are not regenerated (undo with `restore`)')
  .argument('<ids...>', 'scenario ids, e.g. CHECKOUT-008')
  .option('--reason <text>', 'why the scenario is not needed (kept with the tombstone, shown to the AI)')
  .action(async (ids: string[], o: { reason?: string }) => {
    const ctx = await createContext(root());
    for (const r of await removeScenarios(ctx, ids, { reason: o.reason })) {
      const spec =
        r.spec === 'test-removed'
          ? `test removed from ${r.specFile}`
          : r.spec === 'no-test'
            ? `no test in ${r.specFile}`
            : 'no spec file yet';
      console.log(`  ${pc.red('removed')} ${r.id} ${r.title} ${pc.dim(`(${spec})`)}`);
    }
    console.log(pc.dim('Undo with `ai-qa-agent scenarios restore <id>`.'));
  });

scenarios
  .command('restore')
  .description('bring removed scenarios back (approved); their tests return on the next `generate`')
  .argument('<ids...>', 'scenario ids')
  .action(async (ids: string[]) => {
    const ctx = await createContext(root());
    const restored = restoreScenarios(ctx, ids);
    for (const r of restored) console.log(`  ${pc.green('restored')} ${r.id} ${r.title}`);
    const pages = [...new Set(restored.map((r) => pageSlug(r.page)))];
    console.log(
      `Run ${pages.map((p) => pc.bold(`ai-qa-agent generate --page ${p}`)).join(' and ')} to regenerate the test(s).`,
    );
  });

program
  .command('generate')
  .description('generate Playwright tests in .qa/tests/ from approved scenarios')
  .option('--page <route>', 'only this page (route or name)')
  .option('--force', 'regenerate even if scenarios did not change')
  .option('--critical', 'only the tests of the critical flows (other tests are left as they are)')
  .action(async (o: { page?: string; force?: boolean; critical?: boolean }) => {
    const ctx = await createContext(root());
    const files = o.critical ? await generateCriticalTests(ctx, o) : await generateTests(ctx, o);
    for (const f of files) console.log(`  ${pc.green('generated')} ${rel(ctx.root, f)}`);
  });

program
  .command('test')
  .description('run the generated Playwright tests and collect evidence (no AI)')
  .option('--page <route>', 'only this page (route or name)')
  .option('--category <category>', 'functional | visual | responsive')
  .option('--feature <feature>', 'feature tag, e.g. auth')
  .option('--grep <ids...>', 'scenario ids')
  .option('--critical', 'only the critical flows (smoke tests)')
  .action(async (o: Scope) => {
    const ctx = await createContext(root());
    const filter = o.critical ? criticalTestFilter(ctx, scopeToFilter(o)) : scopeToFilter(o);
    const run = ctx.state.startRun(o.critical ? { command: 'test', critical: 'true' } : { command: 'test' });
    const res = await runTests(ctx, run.id, filter);
    ctx.state.finishRun(run, 'completed');
    if (res.stats.failed > 0 || res.globalErrors.length) process.exitCode = 1;
  });

function loadRun(ctx: QaContext, runId?: string): TestRunResult {
  const id =
    runId ??
    [...ctx.state.data.runs]
      .reverse()
      .find((r) => fs.existsSync(path.join(runDir(ctx.paths, r.id), 'results.json')))?.id;
  if (!id) throw new Error('No test run with results found. Run `ai-qa-agent test` first.');
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
  .command('plan')
  .description(
    'write a plan for fixing the confirmed bugs of a triaged run into the project (AI reads, never edits, code)',
  )
  .option('--run <id>', 'run id (default: latest run with results)')
  .option('--dir <folder>', 'folder in the project root (default: plans.dir, docs/bug-fix-plan)')
  .option('--force', 'overwrite an existing plan for the run')
  .action(async (o: { run?: string; dir?: string; force?: boolean }) => {
    const ctx = await createContext(root());
    const res = await writeBugFixPlan(ctx, { runId: o.run, dir: o.dir, force: o.force });
    if (!res.file) {
      console.log(`No confirmed bugs in run ${res.runId}; nothing to plan.`);
      return;
    }
    console.log(
      `Bug-fix plan: ${pc.bold(res.file)}  (${res.bugs} bug${res.bugs === 1 ? '' : 's'}` +
        `${res.notIncluded ? `, ${res.notIncluded} other failures listed as not included` : ''}, $${res.costUsd.toFixed(3)})`,
    );
  });

program
  .command('run')
  .description(
    'full pipeline: analyze → scenarios → generate → test → triage → report (bugs are logged from the dashboard)',
  )
  .option('--page <route>', 'only this page (route or name)')
  .option('--category <category>', 'only run tests of this category: functional | visual | responsive')
  .option('--feature <feature>', 'only run tests of this feature tag, e.g. auth')
  .option(
    '--critical',
    'smoke mode: only the critical flows (generated when missing), their tests and results',
  )
  .option('--changed', 'only new or changed pages (see `ai-qa-agent changes`)')
  .option('--design', 'with --changed: also inspect Figma for new/changed frames (uses Figma MCP calls)')
  .option('--resume', 'continue the last unfinished run')
  .option('--refresh', 'ignore caches and re-analyze code and design')
  .action(async (o: Scope & { changed?: boolean; design?: boolean; resume?: boolean; refresh?: boolean }) => {
    if (o.critical && o.changed) throw new Error('--critical cannot be combined with --changed');
    const ctx = await createContext(root());
    // Bugs are never filed here: the dashboard's Create task / Create issue button is the only way.
    const res = await runPipeline(ctx, {
      page: o.page,
      filter: scopeToFilter(o),
      critical: o.critical,
      changed: o.changed,
      design: o.design,
      resume: o.resume,
      refresh: o.refresh,
    });
    if (res.nothingChanged || !res.test || !res.triage || !res.filing || !res.report) {
      console.log('Nothing changed since the last analysis; no tests were run.');
      return;
    }
    const s = res.test.stats;
    console.log(
      `\n${pc.bold('Result')}: ${s.passed} passed, ${s.failed} failed · ${res.triage.issues.length} defect(s) · ${res.filing.message}\n` +
        `Report: ${rel(ctx.root, res.report.markdown)} — browse with ${pc.bold('npx ai-qa-agent ui')}`,
    );
    if (res.triage.issues.length) process.exitCode = 1;
  });

program
  .command('changes')
  .description('show which pages (and, with --design, Figma frames) changed since the last analysis')
  .option('--design', 'also inspect the Figma file (costs 1 + number-of-pages Figma MCP calls)')
  .action(async (o: { design?: boolean }) => {
    const ctx = await createContext(root());
    const code = detectCodeChanges(ctx);
    const design = o.design && loadDesign(ctx) ? await detectDesignChanges(ctx, loadDesign(ctx)!) : undefined;
    for (const line of describeChanges(code, design)) console.log(line);
    const routes = routesToAnalyze(code);
    if (routes.length || design?.newScreens.length || design?.changedPages.length) {
      console.log(
        `\nRun ${pc.bold('npx ai-qa-agent run --changed' + (o.design ? ' --design' : ''))} to test only these.`,
      );
    }
  });

program
  .command('ui')
  .description(
    'open a local dashboard with all scenarios, results, evidence and a button to log bugs in ClickUp or Jira',
  )
  .option('--port <port>', 'port to listen on', (v) => Number(v), 4310)
  .option('--host <host>', 'interface to bind', '127.0.0.1')
  .option(
    '--base-path <path>',
    'URL path a reverse proxy serves the dashboard under, e.g. /blog/admin/qa (default: none)',
  )
  .action(async (o: { port: number; host: string; basePath?: string }) => {
    const ctx = await createContext(root());
    const basePath = normalizeBasePath(o.basePath);
    const server = await startUi(ctx, { port: o.port, host: o.host, basePath });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : o.port;
    const url = `http://${o.host}:${port}${basePath}/`;
    console.log(`AI QA Agent dashboard: ${pc.bold(url)}  (Ctrl+C to stop)`);
    console.log(pc.dim(projectLine(ctx.config)));
    const info = trackerInfo(ctx.config);
    if (info.kind && !info.credentialsPresent) {
      console.log(
        pc.yellow(
          `${info.name} filing is disabled: set ${info.missingEnv.join(' and ')} in this shell (see ai-qa-agent doctor).`,
        ),
      );
    }
    await new Promise(() => undefined);
  });

program.parseAsync().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  if (process.env.AI_QA_DEBUG && err instanceof Error) console.error(err.stack);
  process.exit(1);
});

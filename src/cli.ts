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
    const claude = await checkClaude(ctx.config.ai.claudePath);
    console.log(`${claude.ok ? pc.green('✔') : pc.red('✘')} Claude Code CLI: ${claude.detail}`);
    for (const name of Object.keys(ctx.config.ai.mcpServers)) {
      console.log(`${pc.cyan('•')} MCP server configured for AI tasks: ${name}`);
    }
    if (!claude.ok) process.exitCode = 1;
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

program.parseAsync().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  if (process.env.AI_QA_DEBUG && err instanceof Error) console.error(err.stack);
  process.exit(1);
});

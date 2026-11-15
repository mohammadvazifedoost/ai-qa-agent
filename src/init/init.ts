import fs from 'node:fs';
import path from 'node:path';
import { detectProject, type ProjectInfo } from '../discovery/detect.js';
import { ensureDir, writeJson } from '../core/fs.js';
import { logger } from '../core/logger.js';
import { qaPaths } from '../core/paths.js';
import { detectProductionCommands } from '../runner/production.js';

const log = logger('init');

export interface InitOptions {
  root: string;
  force?: boolean;
  figmaUrl?: string;
  clickupListId?: string;
  jiraUrl?: string;
  jiraProject?: string;
  jiraEmail?: string;
  baseUrl?: string;
  /** AI provider: claude-code (default), codex or opencode. */
  ai?: 'claude-code' | 'codex' | 'opencode';
  model?: string;
}

/** The official remote Figma MCP server (authenticated through Claude Code's OAuth flow). */
const FIGMA_MCP = { type: 'http', url: 'https://mcp.figma.com/mcp' } as const;
/** Microsoft's Playwright MCP server, used by the AI to explore the running app. */
const PLAYWRIGHT_MCP = { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'] };

export function renderConfig(info: ProjectInfo, opts: InitOptions): string {
  const baseUrl = opts.baseUrl ?? `http://${info.devHost ?? 'localhost'}:${info.devPort ?? 3000}`;
  const include = info.sourceDirs.length ? info.sourceDirs : ['.'];
  const lines: string[] = [];
  lines.push(`import { defineConfig } from '@mohammadvazifedoost/ai-qa-agent';`, '');
  lines.push(`export default defineConfig({`);
  lines.push(`  project: {`);
  lines.push(`    name: ${JSON.stringify(info.name)},`);
  lines.push(`    framework: ${JSON.stringify(info.framework)},`);
  lines.push(`    packageManager: ${JSON.stringify(info.packageManager)},`);
  lines.push(`  },`);
  lines.push(`  app: {`);
  lines.push(`    baseUrl: ${JSON.stringify(baseUrl)},`);
  const prod = detectProductionCommands(info);
  if (prod.startCommand && prod.buildCommand) {
    lines.push(
      `    // Tests run against a production build: "${prod.buildCommand}", then "${prod.startCommand}" on a free port.`,
      `    // Override with production: { buildCommand, startCommand, baseUrl } when your project needs something else.`,
    );
  } else {
    lines.push(
      `    // Tests run against a production build, but it could not be worked out for this project:`,
      `    // ${prod.startCommand ? 'package.json has no "build" script' : prod.reason}.`,
      `    // Fill this in ({port} and {host} are replaced; PORT and HOST are also set):`,
      `    // production: { buildCommand: ${JSON.stringify(prod.buildCommand ?? 'npm run build')}, startCommand: 'npx serve -s dist -l {port}' },`,
    );
  }
  if (info.devCommand) {
    lines.push(
      `    // The dev server. It is only used when you set mode: 'development' (results are then not production-validated).`,
      `    startCommand: ${JSON.stringify(info.devCommand)},`,
    );
  }
  lines.push(`  },`);
  lines.push(`  source: {`);
  lines.push(`    include: ${JSON.stringify(include)},`);
  lines.push(`  },`);
  if (opts.figmaUrl) {
    lines.push(`  figma: {`);
    lines.push(`    fileUrl: ${JSON.stringify(opts.figmaUrl)},`);
    lines.push(
      `    // Optional: pin frames { name, nodeId, route, viewport }. Otherwise screens are discovered by \`ai-qa-agent analyze\`.`,
    );
    lines.push(`    frames: [],`);
    lines.push(`  },`);
  }
  if (opts.clickupListId) {
    lines.push(`  clickup: {`);
    lines.push(`    listId: ${JSON.stringify(opts.clickupListId)},`);
    lines.push(`    // Personal API token is read from this env var (never commit it).`);
    lines.push(`    tokenEnv: 'CLICKUP_API_TOKEN',`);
    lines.push(`  },`);
  }
  if (opts.jiraUrl && opts.jiraProject) {
    lines.push(`  jira: {`);
    lines.push(`    baseUrl: ${JSON.stringify(opts.jiraUrl)},`);
    lines.push(`    projectKey: ${JSON.stringify(opts.jiraProject)},`);
    if (opts.jiraEmail) lines.push(`    email: ${JSON.stringify(opts.jiraEmail)},`);
    else lines.push(`    // Account email is read from JIRA_EMAIL unless you set email here.`);
    lines.push(`    // API token is read from this env var (never commit it).`);
    lines.push(`    tokenEnv: 'JIRA_API_TOKEN',`);
    lines.push(`  },`);
  }
  if (opts.clickupListId && opts.jiraUrl && opts.jiraProject) lines.push(`  tracker: 'jira',`);
  const provider = opts.ai ?? 'claude-code';
  lines.push(`  ai: {`);
  if (provider !== 'claude-code') lines.push(`    provider: ${JSON.stringify(provider)},`);
  if (opts.model) lines.push(`    model: ${JSON.stringify(opts.model)},`);
  else if (provider === 'claude-code') lines.push(`    model: 'sonnet',`);
  else
    lines.push(
      `    // model: omitted = the ${provider} default. Codex e.g. 'gpt-5-codex'; OpenCode 'provider/model'.`,
    );
  lines.push(`    mcpServers: {`);
  if (opts.figmaUrl) lines.push(`      figma: ${JSON.stringify(FIGMA_MCP)},`);
  lines.push(`      playwright: ${JSON.stringify(PLAYWRIGHT_MCP)},`);
  lines.push(`    },`);
  lines.push(`  },`);
  lines.push(`});`, '');
  return lines.join('\n');
}

const RULES_TEMPLATE = `# Project QA rules

Free-form guidance for the AI QA agent. Everything here is included in every AI prompt.
Keep it short and concrete.

## Test data
<!-- e.g. "Use test user qa@example.com / password from env QA_PASSWORD" -->

## Out of scope
<!-- e.g. "Do not test /admin", "Payments are stubbed in dev" -->

## Known issues
<!-- Issues that are already tracked and should not be filed again -->
`;

const GITIGNORE = `# Generated by AI QA Agent. Scenarios, tests, config and rules are meant to be committed.
artifacts/
reports/
state.json
test-results/
# secrets saved by the dashboard (bug-tracker tokens)
.env.local
# regenerated from config.ts on every run
playwright.config.ts
`;

export function initProject(opts: InitOptions): { info: ProjectInfo; created: string[] } {
  const paths = qaPaths(opts.root);
  if (fs.existsSync(paths.config) && !opts.force) {
    throw new Error(`${paths.config} already exists. Use --force to overwrite the config.`);
  }
  const info = detectProject(opts.root);
  const created: string[] = [];
  for (const dir of [paths.qaDir, paths.scenariosDir, paths.testsDir, paths.artifactsDir, paths.reportsDir]) {
    ensureDir(dir);
  }
  fs.writeFileSync(paths.config, renderConfig(info, opts));
  created.push(paths.config);
  if (!fs.existsSync(paths.rules)) {
    fs.writeFileSync(paths.rules, RULES_TEMPLATE);
    created.push(paths.rules);
  }
  fs.writeFileSync(path.join(paths.qaDir, '.gitignore'), GITIGNORE);
  created.push(path.join(paths.qaDir, '.gitignore'));
  writeJson(path.join(paths.qaDir, 'project.json'), info);
  created.push(path.join(paths.qaDir, 'project.json'));

  log.info(
    `Detected ${info.framework} (${info.uiLibrary ?? 'no UI lib'}), ${info.packageManager}, TS=${info.typescript}`,
  );
  log.info(
    `Found ${info.routes.length} route(s) via ${info.routingStyle}; ${info.existingTests.length} existing test file(s)`,
  );
  if (!info.playwright.installed) {
    log.warn(
      `@playwright/test is not installed in this project. Install it: ${info.packageManager} add -D @playwright/test && npx playwright install chromium`,
    );
  }
  return { info, created };
}

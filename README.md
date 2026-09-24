# @company/ai-qa

An AI-powered QA agent for web projects. Install it into any web application and it will:

1. read your **Figma** design and your **source code**,
2. write prioritized **test scenarios** (functional, visual, responsive),
3. turn approved scenarios into maintainable **Playwright tests**,
4. run them with **video, screenshots, traces, console and network logs**,
5. **triage every failure** (product bug? test bug? environment? design mismatch?),
6. file **confirmed** defects in **ClickUp** with evidence attached,
7. write a **QA report**.

The engine lives in this package. A target project only holds its configuration and generated
artifacts in `.qa/`.

```
Figma + source code → analysis → scenarios → Playwright tests → execution + evidence
        → failure analysis → confirmed bugs → ClickUp tasks → QA report
```

## How the AI works (and how it authenticates)

All reasoning runs through the **Claude Code CLI** that is already installed and logged in on the
machine (`claude -p`, headless mode with structured JSON output). That means:

- **No API key is stored or required by this tool.** It uses whatever authentication Claude Code
  has: a Claude subscription login, an `ANTHROPIC_API_KEY` in the environment, or Bedrock/Vertex.
- Every AI task is sandboxed: only read-only tools (`Read`, `Glob`, `Grep`) plus the MCP tools the
  task needs, with an explicit allow-list, a spend cap, and no access to your personal Claude Code
  settings, plugins or hooks. **The agent can never edit application code.**
- Each task returns data validated against a schema; the engine writes all files itself.
- Every AI transcript is kept in `.qa/artifacts/logs/ai/` for auditing.

Deterministic checks decide pass/fail; the AI decides *what* to check and *why* something failed.
Visual verdicts come from computed-CSS comparison against Figma tokens and pixel comparison
against Figma frames, never from a model saying "looks right".

## Requirements

- Node.js ≥ 22.12
- [Claude Code](https://code.claude.com) installed and authenticated (`claude --version` works)
- `@playwright/test` in the target project with a browser installed (`npx playwright install chromium`)
- Optional: Figma access (for design analysis) and a ClickUp personal API token (for bug filing)

## Installation

```bash
npm install -D @company/ai-qa @playwright/test
npx playwright install chromium
npx ai-qa init --figma "https://www.figma.com/design/<fileKey>/<name>" --clickup-list <listId>
npx ai-qa doctor
```

`init` detects the framework (Next.js, Nuxt, SvelteKit, Remix/React Router, Astro, Angular, Vite…),
package manager, TypeScript, dev command and port, routes, component directories, design-system
libraries and existing tests, then writes a minimal `.qa/config.ts` containing only what applies.

Both `--figma` and `--clickup-list` are optional; add them later by editing `.qa/config.ts`.

## Commands

| Command | What it does |
|---|---|
| `ai-qa init` | Detect the project and create `.qa/config.ts`, `.qa/rules.md`, `.qa/.gitignore` |
| `ai-qa doctor` | Verify Claude Code, Playwright, the app URL, Figma and ClickUp configuration |
| `ai-qa analyze` | Analyze the source code (`.qa/app-model.json`) and the Figma file (`.qa/design-system.json`) |
| `ai-qa scenarios` | Generate/refresh test scenarios per page (`.qa/scenarios/*.json`) |
| `ai-qa generate` | Generate Playwright tests from approved scenarios (`.qa/tests/*.spec.ts`) |
| `ai-qa test` | Run the tests and collect evidence — no AI involved |
| `ai-qa triage` | Classify the failures of the latest run and write a report |
| `ai-qa report` | Rebuild the report of a run from stored results |
| `ai-qa run` | The full pipeline: analyze → scenarios → generate → test → triage → (file) → report |
| `ai-qa changes` | Show what changed since the last analysis: new/changed/removed pages, changed shared files, and with `--design` new/changed Figma frames |
| `ai-qa ui` | Local dashboard: every scenario with its result, screenshots, videos, traces, analysis, and a button to log confirmed bugs in ClickUp |

Scoping and flags:

```bash
ai-qa run --changed                # only new/changed pages (a new feature) — see `ai-qa changes`
ai-qa run --changed --design       # also re-extract the design when Figma frames changed
ai-qa run --page checkout          # one page (route or name)
ai-qa run --category visual        # functional | visual | responsive
ai-qa run --feature auth           # by feature tag
ai-qa run --resume                 # continue an interrupted run
ai-qa run --refresh                # ignore caches; re-read code and Figma
ai-qa test --grep CHECKOUT-002     # specific scenario ids
ai-qa scenarios --page login --force --max 8
ai-qa ui --port 4310
ai-qa --cwd ../other-project doctor
```

`ai-qa run` exits with code 1 when defects were found, so it can gate a CI job.

### Checking only what is new

Nothing is regenerated from scratch on every run:

- **Analysis** is per page. `ai-qa changes` compares each page's own source files with the hashes
  stored at analysis time (free, no AI). Only new and changed pages are re-analyzed; unchanged
  pages keep their model verbatim, so their scenarios and tests stay cached too.
- Files shared by every page (router entry, layout, global CSS) are tracked separately as
  *shared files*: registering a new route does not mark every page as changed. A changed shared
  file is reported with a hint to do a full run when it matters (e.g. global styles).
- **Scenarios** and **tests** are cached per page on their inputs. When a page changes, its
  existing scenarios are handed to the AI to update — ids and `approved` flags are kept.
- **Design**: the Figma extraction is cached; `--design` inspects the file (one metadata call per
  Figma page) and re-extracts only when frames were added or a page's structure changed.

Typical flow after adding a feature: `ai-qa changes` → `ai-qa run --changed` → review in
`ai-qa ui` → log the confirmed bugs from the dashboard.

## Configuration (`.qa/config.ts`)

```ts
import { defineConfig } from '@company/ai-qa';

export default defineConfig({
  project: { name: 'shop', framework: 'next', packageManager: 'pnpm' },
  app: {
    baseUrl: 'http://127.0.0.1:3000',
    startCommand: 'pnpm dev',        // omit if the app is already running
    startTimeoutMs: 120_000,
    reuseExistingServer: true,
  },
  source: { include: ['src', 'app'], exclude: ['node_modules', '.next'] },
  figma: {
    fileUrl: 'https://www.figma.com/design/<fileKey>/<name>',
    frames: [                        // optional: pin frames to routes
      { name: 'checkout-desktop', nodeId: '12:34', route: '/checkout', viewport: 'desktop' },
    ],
  },
  clickup: {
    listId: '901523571090',
    tokenEnv: 'CLICKUP_API_TOKEN',   // the token is read from this env var, never from config
    tags: ['ai-qa'],
    status: 'to do',                 // optional; default is the list's first status
    attachEvidence: true,
  },
  browsers: ['chromium'],            // chromium | firefox | webkit
  viewports: {
    desktop: { width: 1440, height: 900 },
    tablet: { width: 834, height: 1112, hasTouch: true },
    mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
  },
  tests: { timeoutMs: 30_000, workers: 2, verifyRetries: 1 },
  visual: { pixelThreshold: 0.1, acceptableDiffRatio: 0.02 },
  ai: {
    model: 'sonnet',                 // any Claude Code model alias/id
    claudePath: 'claude',
    maxBudgetUsdPerTask: 3,
    minConfidenceToFile: 0.7,
    mcpServers: {
      figma: { type: 'http', url: 'https://mcp.figma.com/mcp' },
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'] },
    },
  },
});
```

The full schema (with defaults) is in `src/config/schema.ts`; invalid configs fail fast with a
readable error. `.qa/rules.md` is free-form guidance (test accounts, out-of-scope areas, known
issues) that is included in every AI prompt.

### Secrets

Nothing secret is written to `.qa/`. ClickUp is authenticated through the environment variable
named in `clickup.tokenEnv`; Figma and Claude are authenticated through Claude Code's own OAuth
flows. `.qa/.gitignore` excludes artifacts, reports and state; scenarios, tests, config and rules
are meant to be committed.

## Figma setup

1. Claude Code must have the official Figma MCP server (`https://mcp.figma.com/mcp`) authorized:
   run `claude mcp add --transport http figma https://mcp.figma.com/mcp` once and complete the
   OAuth login when prompted inside Claude Code. `ai-qa` passes the same server to its AI tasks.
2. Put the file URL in `figma.fileUrl`. The agent lists pages and frames, reads variables, text
   styles and component specs, and downloads a 1:1 screenshot of each screen frame to
   `.qa/design/refs/`.
3. Optionally pin frames to routes in `figma.frames`; otherwise routes are inferred from frame
   names and content and marked with their certainty.

`.qa/design-system.json` distinguishes `observed` (read from Figma data), `inferred` and lists
everything `unknown`. Tokens are never invented.

**Figma plan limits.** The Figma MCP server allows only 20 read calls **per month** on Starter
plans (200+/day with a Dev/Full seat on paid plans). `ai-qa` reports when calls were rejected,
keeps the partial result, and fetches missing reference screenshots on the next run.

## ClickUp setup

1. Create a personal API token in ClickUp (Settings → Apps) and export it:
   `export CLICKUP_API_TOKEN=pk_...` (or set the variable in CI).
2. Put the target list id in `clickup.listId` (from the list URL or the API). `ai-qa doctor`
   verifies the token and shows the list name.
3. Confirmed defects become tasks named `[ai-qa] <title>` with a markdown description (severity,
   category, page, steps, expected/actual, root cause, environment, test ids) and the screenshot,
   video, trace and design-diff images attached. Priority maps from severity.

**Nothing is ever filed automatically — there is no flag or setting for it.** After a run,
confirmed defects wait in the report and in the dashboard (`ai-qa ui`); a task is created only when
a person clicks *Create task* on a failed test. Symptoms of one underlying defect are grouped into
one bug report, so one click covers all the tests it affects.

## Dashboard (`ai-qa ui`)

`npx ai-qa ui` serves a local page (default `http://127.0.0.1:4310`) built from the files the
pipeline writes — no database, no external service.

- The sidebar lists pages with pass/fail counts; the verdict panel shows the run's pass ratio and
  distinct defects. Scenarios that were not part of the selected run are hidden unless you ask.
- Each scenario is one row: status, id, title, and for failures the analyzer's classification.
  Clicking a row opens a modal with what happened (analysis, root cause, expected vs actual), the
  evidence (screenshot, video, trace, console/network log, page snapshot) and, collapsed, the test
  error and the scenario's steps.
- Every failed row has either an *Open task* link or a *Create task* button. The dashboard checks
  ClickUp for the task recorded for that defect (from this run or an earlier run of the same
  defect, cached for a minute); if it still exists you get the link, otherwise — never created, or
  deleted in ClickUp — the button. A click creates the task from the bug report (consolidated for
  confirmed defects; for failures the analyzer did not confirm it is built from the scenario and
  the error and tagged `needs-verification`). Filters: All / Failures / Passing, type (functional,
  visual, responsive) and page.
- The token must be in the environment of the shell that started the UI
  (`CLICKUP_API_TOKEN=pk_... npx ai-qa ui`). Filing results are written back to the run so the
  report and the dashboard stay consistent.

## Playwright setup

`ai-qa` generates `.qa/playwright.config.ts` from your config on every run: one project per
browser × viewport, video/trace/screenshot always on, JSON reporter. Tests select their viewport
through tags (`@desktop`, `@mobile`, …). You can run them yourself:

```bash
cd .qa && npx playwright test --config playwright.config.ts --grep @checkout
npx playwright show-trace .qa/artifacts/runs/<run>/traces/CHECKOUT-002_chromium-desktop.zip
```

Generated tests import `test`/`expect` from `@company/ai-qa/playwright`, which adds:

- `qa.expectDesignTokens(locator, { backgroundColor: '#2563EB', borderRadius: '8px', ... })` —
  computed-style comparison against Figma values (colors as RGBA, lengths ±0.5px, families,
  shorthand expansion);
- `qa.compareWithDesign('Home / Desktop')` — pixel comparison (pixelmatch) with the Figma reference,
  attaching expected/actual/diff images and recording `match | acceptable | mismatch`;
- `qa.expectNoHorizontalOverflow()` — fails on horizontal scroll and names the offending elements;
- automatic capture of console errors, page errors and failed/4xx/5xx requests.

## Generated files

```
.qa/
  config.ts              project configuration (commit)
  rules.md               free-form QA rules for the AI (commit)
  project.json           deterministic project discovery
  app-model.json         AI analysis of the source: pages, forms, states, business rules, test data
  design-system.json     tokens, components, screens from Figma (observed / inferred / unknown)
  design/refs/*.png      1:1 Figma screenshots used as visual references
  scenarios/<page>.json  test scenarios with ids, steps, expected results, priority, approval flag
  tests/<page>.spec.ts   generated Playwright tests (commit; regenerated when scenarios change)
  playwright.config.ts   generated on each run
  state.json             stage hashes, run checkpoints, filed-bug fingerprints (resumability)
  artifacts/runs/<run>/  videos/ traces/ screenshots/ logs/ design/ results.json triage.json filing.json
  artifacts/logs/        ai-qa.log and every AI transcript
  reports/<run>/         report.md, report.html, bugs.json, bugs/BUG-00n.md
  reports/latest.md
```

## Failure analysis

Each failed test is classified as `PRODUCT_BUG`, `TEST_BUG`, `ENVIRONMENT_FAILURE`,
`INFRASTRUCTURE_FAILURE`, `DESIGN_MISMATCH` or `UNKNOWN`:

1. Unambiguous cases are decided by rules (connection refused, browser missing, spec syntax
   errors, flaky = passed on retry).
2. Everything else is analyzed by the AI with the error, the test code, the final screenshot,
   the DOM snapshot at failure, console/network logs, the deterministic check results, the scenario,
   the page's source analysis and the Figma data. It reads the application source to find the cause.
3. Defects are consolidated: several failing tests caused by one CSS rule become one issue.

Only confirmed defects are filed. Test bugs are listed in the report with a suggested fix — the
agent never edits tests to make them pass, and never edits application code.

## State and resumability

Stages are cached on content hashes: analysis reruns only when source files change, scenarios only
when a page's model/design changed, tests only when scenarios changed. Runs are checkpointed in
`.qa/state.json`; `ai-qa run --resume` continues an interrupted run from the last completed stage
using the stored results. `--refresh` forces re-analysis.

## Example workflow

```bash
npm install -D @company/ai-qa @playwright/test && npx playwright install chromium
npx ai-qa init --figma https://www.figma.com/design/KEY/Shop --clickup-list 901523571090
export CLICKUP_API_TOKEN=pk_...
npx ai-qa doctor
npx ai-qa analyze                  # review .qa/app-model.json and .qa/design-system.json
npx ai-qa scenarios                # review .qa/scenarios/*.json, set approved:false to drop one
npx ai-qa run                      # generates tests, runs, triages, files bugs, writes report
open .qa/reports/latest.md
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `App did not become ready at http://localhost:...` while the dev server log says ready | `localhost` resolved to IPv6 (`::1`) but the server or the OS only accepts IPv4 (or vice versa). The error prints a loopback probe; bind the server explicitly (`--host 127.0.0.1`) and use `http://127.0.0.1:<port>` in `app.baseUrl`. |
| `Figma MCP rejected N call(s) because of plan limits` | Monthly/daily Figma MCP quota exhausted. Partial results are kept; re-run `ai-qa analyze` later. |
| `AI task ... failed (error_max_budget_usd)` | Raise `ai.maxBudgetUsdPerTask` or narrow the scope (`--page`). |
| `Claude Code exited ... without a result` | Run `claude --version` and `claude -p "hi"`; log in with `claude` if needed. |
| `No page matches "..."` | Use a route (`/checkout`), a slug (`checkout`) or the page name from `app-model.json`. |
| Visual tests fail with `no-reference` | The screen has no downloaded reference; check `design-system.json` → `references`. |
| A test is wrong, not the app | The triage report says `TEST_BUG` with the reason; fix `.qa/scenarios/<page>.json` (the expectation) and rerun `ai-qa generate --page <page> --force`, or set `approved: false`. |
| Everything is regenerated each run | `.qa/state.json` is missing or ignored; keep it writable (it is git-ignored but must persist locally/in CI cache). |

Logs: `.qa/artifacts/logs/ai-qa.log` (all levels), `ai-qa --debug ...` for console verbosity,
`AI_QA_DEBUG=1` to print stack traces.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md). Development and validation instructions are in
[CONTRIBUTING.md](./CONTRIBUTING.md); the intentionally buggy fixture app used for end-to-end
validation is in `fixtures/demo-shop`.

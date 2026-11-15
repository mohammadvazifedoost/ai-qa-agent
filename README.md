# AI QA Agent

An AI-powered QA agent for web projects. Install it into any web application from GitHub and run
the `ai-qa-agent` command. It will:

1. read your **Figma** design and your **source code** and build one model of the application:
   every page, and every user journey ranked by how much the app depends on it,
2. write prioritized **test scenarios** (functional, visual, responsive, accessibility), including
   the **critical flows** the app cannot do without,
3. turn approved scenarios into maintainable **Playwright tests**,
4. run them against a **production build** of your app, with **video, screenshots, traces,
   console and network logs**,
5. **triage every failure** (product bug? test bug? environment? design mismatch?),
6. file **confirmed** defects in **ClickUp** or **Jira** with evidence attached (on your click),
7. write a **QA report** and, on request, a **bug-fix plan** for developers.

The AI engine is your choice: **Claude Code**, **OpenAI Codex CLI** or **OpenCode**.

```
Figma + source code → analysis → scenarios → Playwright tests → production build
        → execution + evidence → failure analysis → confirmed bugs
        → ClickUp tasks / Jira issues → QA report
```

The engine lives in this package. The project you test only holds its configuration and the
generated files, all in one `.qa/` folder. The agent **never edits your application code**.

## Contents

- [Quick start](#quick-start)
- [Installing in another project](#installing-in-another-project)
- [Requirements](#requirements)
- [How the AI works (and how it authenticates)](#how-the-ai-works-and-how-it-authenticates)
- [Commands](#commands)
- [Configuration (`.qa/config.ts`)](#configuration-qaconfigts)
- [Using it without Figma or a bug tracker](#using-it-without-figma-or-a-bug-tracker-code-only-mode)
- [Figma setup](#figma-setup) · [ClickUp setup](#clickup-setup) · [Jira setup](#jira-setup-jira-cloud)
- [Dashboard](#dashboard-ai-qa-agent-ui)
- [Running in CI](#running-in-ci)
- [Generated files](#generated-files)
- [Writing apps the agent tests well](#writing-apps-the-agent-tests-well)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Quick start

Run these in the root of the web project you want to test (the one with its own `package.json`):

```bash
# 1. Install the agent from GitHub, plus Playwright
npm install -D github:mohammadvazifedoost/ai-qa-agent @playwright/test
npx playwright install chromium

# 2. Make sure one AI CLI is installed and logged in (Claude Code shown here)
claude --version

# 3. Detect the project and create .qa/config.ts
npx ai-qa-agent init

# 4. Check that everything is reachable
npx ai-qa-agent doctor

# 5. Run the whole pipeline, then review the results in the dashboard
npx ai-qa-agent run
npx ai-qa-agent ui          # http://127.0.0.1:4310
```

That is all you need for code-only QA. Add a Figma file, ClickUp or Jira later (see below).

## Installing in another project

### 1. Add the package

The package is installed straight from this GitHub repository. npm clones it and compiles it
(TypeScript → `dist/`) during installation, so the first install takes a minute.

```bash
npm install -D github:mohammadvazifedoost/ai-qa-agent
```

Equivalent forms:

```bash
npm install -D git+https://github.com/mohammadvazifedoost/ai-qa-agent.git
npm install -D github:mohammadvazifedoost/ai-qa-agent#main      # a branch
npm install -D github:mohammadvazifedoost/ai-qa-agent#v0.2.0    # a tag (recommended for teams)
npm install -D github:mohammadvazifedoost/ai-qa-agent#948c91f   # an exact commit
```

Your `package.json` then contains:

```json
{
  "devDependencies": {
    "@mohammadvazifedoost/ai-qa-agent": "github:mohammadvazifedoost/ai-qa-agent",
    "@playwright/test": "^1.45.0"
  }
}
```

> **Names at a glance.**
>
> | What | Name |
> |---|---|
> | GitHub repository | `mohammadvazifedoost/ai-qa-agent` |
> | Package name (imports, `npm uninstall`) | `@mohammadvazifedoost/ai-qa-agent` |
> | Command | `ai-qa-agent` |
>
> Imports use the package name, e.g. `import { defineConfig } from '@mohammadvazifedoost/ai-qa-agent'`.
> Always run the command through the local install (`npx ai-qa-agent` in a project where it is
> installed): an unrelated package named `ai-qa-agent` exists on the npm registry, and `npx`
> would download that one if this package is not installed.
> The command is always `ai-qa-agent`.

> **npm 11.x / 12 says "Fetching packages of type git have been disabled" (`EALLOWGIT`)?**
> Recent npm versions block git dependencies by default. Allow them for this project:
>
> ```bash
> npm config set allow-git all --location=project   # writes .npmrc in the project
> ```
>
> or once on the command line: `npm install --allow-git=all -D github:mohammadvazifedoost/ai-qa-agent`.
> A warning that "install scripts were blocked" for `@mohammadvazifedoost/ai-qa-agent` can be ignored if
> `npx ai-qa-agent --help` works: the build runs while npm prepares the git package.

**pnpm / Yarn** use the same spec (`pnpm add -D github:mohammadvazifedoost/ai-qa-agent`,
`yarn add -D github:mohammadvazifedoost/ai-qa-agent`). If your package manager blocks the build
script of dependencies and `npx ai-qa-agent` reports a missing `dist/cli.js`, allow builds for
`@mohammadvazifedoost/ai-qa-agent` (e.g. `pnpm approve-builds`) and reinstall.

### 2. Add Playwright

The generated tests run with your project's own Playwright (a peer dependency, version 1.45 or
later):

```bash
npm install -D @playwright/test
npx playwright install chromium        # add firefox / webkit if you enable them in the config
```

### 3. Initialise

```bash
npx ai-qa-agent init
```

`init` detects the framework (Next.js, Nuxt, SvelteKit, Remix/React Router, Astro, Angular, Vite…),
package manager, TypeScript, dev command and port, the commands that build and serve a production
build, routes, component directories, design-system libraries and existing tests, then writes:

- `.qa/config.ts`: a minimal configuration containing only what applies. A comment in the `app`
  section shows the production build and serve commands that were detected, or says why they
  could not be detected and what to set,
- `.qa/rules.md`: free-form guidance for the AI (test accounts, out-of-scope areas, known issues),
- `.qa/.gitignore`: keeps run artifacts, reports and state out of git.

Useful `init` options (all optional; you can also edit `.qa/config.ts` later):

| Option | Purpose |
|---|---|
| `--ai <provider>` | `claude-code` (default), `codex` or `opencode` |
| `--model <model>` | Model for the AI engine, e.g. `sonnet`, `opus` |
| `--base-url <url>` | URL the app is served at (default: the detected dev port) |
| `--figma <url>` | Figma file with the designs |
| `--clickup-list <id>` | ClickUp list where bugs are created |
| `--jira-url <url> --jira-project <KEY>` | Jira Cloud site and project where bugs are created |
| `--force` | Overwrite an existing `.qa/config.ts` |

Example with every integration:

```bash
npx ai-qa-agent init \
  --figma "https://www.figma.com/design/<fileKey>/<name>" \
  --clickup-list 901523571090 \
  --base-url http://127.0.0.1:3000
```

### 4. Check and run

```bash
npx ai-qa-agent doctor      # AI CLI, Playwright, app URL, Figma, ClickUp/Jira
npx ai-qa-agent run         # analyze → scenarios → generate → test → triage → report
npx ai-qa-agent ui          # review results, evidence, and log bugs
```

The agent tests a **production build** of your app: it builds the app, serves the build on a free
port, runs the tests and stops the server again. `doctor` prints the build and serve commands it
will use, or the reason it cannot work them out. See
[Production-mode testing](#production-mode-testing).

### 5. Add npm scripts (optional)

```json
{
  "scripts": {
    "qa": "ai-qa-agent run",
    "qa:changed": "ai-qa-agent run --changed",
    "qa:test": "ai-qa-agent test",
    "qa:ui": "ai-qa-agent ui"
  }
}
```

### 6. What to commit

Commit `.qa/config.ts`, `.qa/rules.md`, `.qa/.gitignore`, `.qa/scenarios/` and `.qa/tests/` so the
team shares the same scenarios and tests. Artifacts, reports and `state.json` are already ignored
by `.qa/.gitignore`. No secrets are ever written to `.qa/`.

### Updating and removing

```bash
npm install -D github:mohammadvazifedoost/ai-qa-agent         # pull the latest main
npm install -D github:mohammadvazifedoost/ai-qa-agent#v0.2.0  # or move to a newer tag
npm uninstall @mohammadvazifedoost/ai-qa-agent                # remove (then delete .qa/ if you like)
```

`package-lock.json` pins the exact commit, so everyone on the team gets the same version until
someone updates it.

### Upgrading from 0.1 to 0.2

Your `.qa/config.ts`, scenarios and tests keep working. Three things behave differently:

- **Tests run against a production build**, not the dev server. Run `npx ai-qa-agent doctor`: it
  shows the build and serve commands, or tells you what to add under `app.production`. To keep
  testing the dev server, set `app.mode: 'development'`; results are then labelled as not
  production-validated. See [Production-mode testing](#production-mode-testing).
- **The application is analyzed again once.** `app-model.json` now ranks pages and journeys, and
  a model written by 0.1 does not have that. `run` and `analyze` rebuild it by themselves;
  `scenarios` and `generate` ask you to run `analyze` first.
- **Scenarios and tests are refreshed once**, because the model they are built from changed.
  Scenario ids, `approved` flags, scenarios written by a person and removed scenarios are kept.
  Generated tests are now rejected when they contain fixed waits, forced clicks or skipped tests,
  so a regenerated spec can differ from the old one in those places.

[Critical flows](#critical-flows-smoke-tests) are now selected from the same analysis as
everything else, so the first `scenarios --critical` after the upgrade can return different
flows than before.

### Several projects at once

You can also install it once globally and point it at any project:

```bash
npm install -g github:mohammadvazifedoost/ai-qa-agent
ai-qa-agent --cwd ../shop doctor
ai-qa-agent --cwd ../admin run --changed
```

A per-project install is still recommended, because `.qa/config.ts` and the generated tests import
`@mohammadvazifedoost/ai-qa-agent` from the project's own `node_modules`.

## Requirements

- **Node.js ≥ 22.12**
- **Git**, so npm can clone the package
- **One AI CLI installed and logged in:** [Claude Code](https://code.claude.com) (`claude`),
  [Codex CLI](https://github.com/openai/codex) (`npm i -g @openai/codex`, then `codex login`) or
  [OpenCode](https://opencode.ai) (`npm i -g opencode-ai`, then `opencode auth login`)
- **`@playwright/test` ≥ 1.45** in the target project with a browser installed
  (`npx playwright install chromium`)
- **An app that builds:** the tests run against a production build, so the project needs a
  working build command and a way to serve the result (detected for the common frameworks, see
  [Production-mode testing](#production-mode-testing))
- Optional: Figma access (for design analysis) and a ClickUp or Jira account (for bug filing)

## How the AI works (and how it authenticates)

All reasoning runs through an agent CLI that is already installed and logged in on the machine.
Pick one with `ai.provider` (or `ai-qa-agent init --ai <provider>`):

| `ai.provider` | Runs | Authentication | `ai.model` examples |
|---|---|---|---|
| `claude-code` (default) | `claude -p` (headless, native JSON-schema output) | Claude subscription login, `ANTHROPIC_API_KEY`, Bedrock/Vertex | `sonnet` (default), `opus` |
| `codex` | `codex exec --json --sandbox read-only` | `codex login` (ChatGPT account) or an OpenAI API key | omit for Codex's default, `gpt-5-codex` |
| `opencode` | `opencode run --format json` with an injected read-only agent | `opencode auth login` (any provider OpenCode supports) | `openai/gpt-5.5`, `anthropic/claude-sonnet-4-5` |

For every provider:

- **No API key is stored or required by this tool.** It uses whatever authentication the CLI has.
- Every AI task is read-only: only file read/search tools plus the MCP tools the task needs, with
  an explicit allow-list. Claude Code runs with `--permission-mode dontAsk` and isolated settings;
  Codex runs in its `read-only` sandbox with approvals disabled; OpenCode runs a dedicated agent
  (passed through `OPENCODE_CONFIG_CONTENT`) whose permissions deny everything else, and
  `opencode run` auto-rejects anything not allowed. **The agent can never edit application code.**
- Each task returns data validated against a schema. Claude Code enforces the schema natively; for
  Codex and OpenCode the schema is part of the prompt, the final message is parsed and validated,
  and one correction round is requested if it does not match.
- The engine writes all files itself. Every AI transcript is kept in `.qa/artifacts/logs/ai/`.
- Cost: Claude Code reports dollars and honours `ai.maxBudgetUsdPerTask`; OpenCode reports what its
  provider reports; Codex reports tokens only (shown in the log) and has no per-task cap.
- Figma through MCP: the remote Figma server needs OAuth *in the CLI you use*: Claude Code via
  `claude mcp add`, Codex via `codex mcp login figma`, OpenCode via `opencode mcp auth figma`.

Deterministic checks decide pass/fail; the AI decides *what* to check and *why* something failed.
Visual verdicts come from computed-CSS comparison against Figma tokens and pixel comparison
against Figma frames, never from a model saying "looks right".

### Agents and prompts

Each AI task is done by one of seven agents. An agent has one job, and its output is a file that
the next agent reads:

| Agent | Job | Writes |
|---|---|---|
| Application analyst | Reads the source and describes every page and user journey, with importance and criticality | `app-model.json` |
| Design analyst | Extracts tokens, components and screens from Figma | `design-system.json` |
| Scenario designer | Decides what is worth testing on a page, or turns the selected critical journeys into scenarios | `scenarios/<page>.json` |
| Test author | Implements approved scenarios as Playwright tests, checking locators on the running app | `tests/<page>.spec.ts` |
| Failure triager | Classifies one failed test from its evidence and the source | `triage.json` |
| Defect consolidator | Groups verdicts that have the same root cause | `triage.json` (issues) |
| Fix planner | Turns confirmed bugs into a plan for developers | `docs/bug-fix-plan/` |

All agents share a few rules:

- **Evidence first.** A statement about the code, the app or the design must come from something
  the agent read or observed.
- **Intended and observed behaviour are kept apart.** The analyst records what the code does and
  what a journey is meant to achieve, and lists the difference as a gap. Scenarios assert the
  intended result, so a bug in the code fails a test instead of becoming its expectation.
- **Unknown is a valid answer.** What cannot be determined is reported in `unknowns`, not filled
  with a guess. A feature that is not implemented gets an outcome that can be checked, not
  invented texts or screens.
- **Each agent stays in its role.** The scenario designer does not analyze the app again, the
  test author does not change what a scenario expects, and the planner does not re-triage.

The exact prompts, with real examples from the demo fixture, are in
[`docs/prompt-examples.md`](./docs/prompt-examples.md). The roles and hand-offs are described in
[ARCHITECTURE.md](./ARCHITECTURE.md#ai-agents-and-hand-offs).

### Using Codex or OpenCode instead of Claude Code

Claude is not required. To use another engine, install and log in to its CLI, then pick it at init:

```bash
# Codex
npm i -g @openai/codex
codex login                      # ChatGPT account or OpenAI API key
npx ai-qa-agent init --ai codex

# OpenCode
npm i -g opencode-ai
opencode auth login              # any provider OpenCode supports
npx ai-qa-agent init --ai opencode
```

For a project that is already initialised, change `ai.provider` in its config instead:

```ts
ai: {
  provider: 'codex',            // or 'opencode'
  // model: 'gpt-5-codex',      // Codex: omit for its default
  // model: 'openai/gpt-5.5',   // OpenCode: provider/model format
  // command: 'codex',          // optional: path to the CLI executable
}
```

Remove `model: 'sonnet'` and `command: 'claude'` if they are set, as they only apply to Claude Code.
Remember that `maxBudgetUsdPerTask` has no effect with Codex, and that Figma OAuth must be done
again in the new CLI (see above).

## Commands

Run every command with `npx ai-qa-agent …` in a project where it is installed locally.

| Command | What it does |
|---|---|
| `ai-qa-agent init` | Detect the project and create `.qa/config.ts`, `.qa/rules.md`, `.qa/.gitignore` |
| `ai-qa-agent doctor` | Verify the AI CLI, Playwright, how the app is built and served for testing, Figma and ClickUp/Jira configuration |
| `ai-qa-agent analyze` | Analyze the source code (`.qa/app-model.json`: pages and ranked journeys, used by every mode) and the Figma file (`.qa/design-system.json`); `--skip-design`, `--refresh` |
| `ai-qa-agent scenarios` | Generate/refresh test scenarios per page (`.qa/scenarios/*.json`); `--critical` for only the [critical flows](#critical-flows-smoke-tests) |
| `ai-qa-agent scenarios list` | List scenarios (id, type, page, latest status, title); `--page`, `--removed` |
| `ai-qa-agent scenarios remove <id...>` | Delete unnecessary/unusable scenarios and their tests; they are not regenerated (`--reason "<text>"`) |
| `ai-qa-agent scenarios restore <id...>` | Undo a removal; the test comes back on the next `generate` |
| `ai-qa-agent generate` | Generate Playwright tests from approved scenarios (`.qa/tests/*.spec.ts`); `--critical` for only the critical flows' tests |
| `ai-qa-agent test` | Build the app, serve the production build, run the tests and collect evidence (no AI involved); `--critical` for only the critical flows |
| `ai-qa-agent triage` | Classify the failures of the latest run and write a report |
| `ai-qa-agent report` | Rebuild the report of a run from stored results |
| `ai-qa-agent plan` | Write a plan for fixing the bugs behind a run's failed tests into the project (`docs/bug-fix-plan/<run>-plan.md`); `--run`, `--dir`, `--force` |
| `ai-qa-agent run` | The full pipeline: analyze → scenarios → generate → test → triage → report; `--critical` for a smoke run of the critical flows only |
| `ai-qa-agent changes` | Show what changed since the last analysis: new/changed/removed pages, changed shared files, and with `--design` new/changed Figma frames |
| `ai-qa-agent ui` | Local dashboard: every scenario with its result, screenshots, videos, traces, analysis, and a button to log confirmed bugs in ClickUp or Jira |

Global options: `-C, --cwd <dir>` (target project root), `--debug` (verbose logging),
`-h, --help` (help for any command, e.g. `ai-qa-agent run --help`).

Scoping and flags:

```bash
ai-qa-agent run --changed                # only new/changed pages (a new feature); see `ai-qa-agent changes`
ai-qa-agent run --changed --design       # also re-extract the design when Figma frames changed
ai-qa-agent run --page checkout          # one page (route or name)
ai-qa-agent run --category visual        # functional | visual | responsive | accessibility
ai-qa-agent run --feature auth           # by feature tag
ai-qa-agent run --resume                 # continue an interrupted run
ai-qa-agent run --refresh                # ignore caches; re-read code and Figma
ai-qa-agent test --grep CHECKOUT-002     # specific scenario ids
ai-qa-agent scenarios --page login --force --max 8   # cap this run; default: scenarios.maxPerPage or no limit
ai-qa-agent scenarios list --page checkout
ai-qa-agent scenarios remove CHECKOUT-008 --reason "order placement is out of scope"
ai-qa-agent ui --port 4310
ai-qa-agent --cwd ../other-project doctor
```

`ai-qa-agent run` exits with code 1 when defects were found, so it can gate a CI job.

### A typical step-by-step workflow

```bash
npx ai-qa-agent analyze      # review .qa/app-model.json (pages, journeys, unknowns) and .qa/design-system.json
npx ai-qa-agent scenarios    # review .qa/scenarios/*.json; set "approved": false to skip one
npx ai-qa-agent generate     # Playwright tests in .qa/tests/ (builds and serves the app to check locators)
npx ai-qa-agent test         # run them against the production build (no AI)
npx ai-qa-agent triage       # classify failures, write the report
npx ai-qa-agent ui           # review, log confirmed bugs, create a fix plan
```

`ai-qa-agent run` does all of these in one go.

### Checking only what is new

Nothing is regenerated from scratch on every run:

- **Analysis** is per page. `ai-qa-agent changes` compares each page's own source files with the hashes
  stored at analysis time (free, no AI). Only new and changed pages are re-analyzed; unchanged
  pages keep their model verbatim, so their scenarios and tests stay cached too.
- Files shared by every page (router entry, layout, global CSS) are tracked separately as
  *shared files*: registering a new route does not mark every page as changed. A changed shared
  file is reported with a hint to do a full run when it matters (e.g. global styles).
- **Scenarios** and **tests** are cached per page on their inputs. When a page changes, its
  existing scenarios are handed to the AI to update; ids and `approved` flags are kept.
- **Design**: the Figma extraction is cached; `--design` inspects the file (one metadata call per
  Figma page) and re-extracts only when frames were added or a page's structure changed.

Typical flow after adding a feature: `ai-qa-agent changes` → `ai-qa-agent run --changed` → review in
`ai-qa-agent ui` → log the confirmed bugs from the dashboard.

### Critical flows (smoke tests)

For a quick "is the app basically working?" check without a full suite, generate and run only the
app's critical flows: the journeys the app exists for, such as logging in, the main purchase or
checkout flow, or the primary create/submit action.

```bash
npx ai-qa-agent scenarios --critical         # one scenario per critical journey (--max 3, --force)
npx ai-qa-agent generate --critical          # write only their tests
npx ai-qa-agent test --critical              # run only them (no AI)
npx ai-qa-agent run --critical               # all of the above, then triage and report
```

- **There is one analysis for every mode.** `analyze` reads the whole app once and records its
  user journeys in `.qa/app-model.json` → `flows`. Each journey has a `kind` (`happy-path`,
  `alternate`, `error-path`), a `criticality` (`critical`, `important`, `secondary`) with the
  reason, the intended steps and outcome, and how much of it the code implements
  (`implementation`, `gaps`). Critical mode does not analyze the app again or use a simpler
  analysis: it selects the journeys that are `critical` happy paths and writes a scenario for
  each. A full run uses the same journeys to set priorities.
- Which journeys are critical is therefore a result of `analyze`, and you can read it in
  `app-model.json`. If it is wrong, say what matters in `.qa/rules.md` (for example "Checkout is
  the core journey; the newsletter form is optional") and run `ai-qa-agent analyze --refresh`.
  When the analysis finds no critical journey, `scenarios --critical` says so and does not ask
  the AI. An `app-model.json` written by an older version is analyzed again first.
- A critical flow is an ordinary scenario with `"critical": true`: functional, high priority, the
  happy path end to end. A journey can span several pages; it is stored with the page where it
  starts and gets that page's id (e.g. `CHECKOUT-004`), and its `routes` field lists every route
  it visits, so the test author and the triager get the models of all those pages. Scenario
  files without these fields stay valid.
- `scenarios --critical` only replaces the AI's critical flows. Other scenarios, scenarios
  written by a person and removed scenarios are kept as they are, and regenerating a page
  (`ai-qa-agent scenarios`) leaves the critical flows that start on it alone. An approved
  scenario that already covers a journey is marked critical instead of being duplicated. A
  journey the code does not implement is still covered: its scenario states the intended
  outcome, so the test fails until the feature works. It is cached: the AI is asked again only
  when the selected journeys, their pages, the test data or the rules change, or with
  `--force`. Remove a flow you do not want with `scenarios remove <id>` so it is not suggested
  again.
- There is no limit on how many flows (or, for regular generation, scenarios per page) the AI
  returns. To cap them, set `scenarios: { maxCritical, maxPerPage }` in `.qa/config.ts`; `--max`
  overrides the config for one run.
- `generate --critical` writes only the missing or outdated critical tests. A page without a spec
  gets one with just those tests; a later full `generate` adds the rest. Generated tests carry the
  `@critical` tag, so `npx playwright test --grep @critical` works too.
- `test --critical` and `run --critical` select the tests by scenario id, and combine with `--page`,
  `--feature` and `--grep`. `run --critical` skips the Figma extraction and cannot be combined with
  `--changed`.
- In the dashboard, critical flows show a *Critical flow* chip, the Overview lists them with their
  results, and **Run tests → Critical flows** starts a new run with only their tests. *Choose
  critical flows* on the dashboard's Project page does the same as `scenarios --critical`.

### Removing scenarios

Some generated scenarios are not worth keeping (duplicates, out of scope, untestable). Delete them
with `ai-qa-agent scenarios remove <id...> [--reason "<text>"]` (find ids with
`ai-qa-agent scenarios list`) or with *Remove* at the bottom of a scenario's panel in the dashboard.

- The scenario leaves the `scenarios` array of `.qa/scenarios/<page>.json` and its
  `test('<ID>: …')` block is cut out of `.qa/tests/<page>.spec.ts`, without AI; other tests and
  helpers are untouched. The edited spec is checked with `playwright test --list`; if it no longer
  loads, the original is put back and nothing changes.
- It is recorded under `removed` in the same scenario file (id, title, reason, time, full
  scenario). Scenario generation tells the AI not to recreate removed scenarios and drops any that
  come back with a removed id or title, so it stays gone after `scenarios --force` or a page change.
- The spec's generation cache is updated, so `generate` does not rewrite the spec because of it.
- Past run results and evidence are kept; the dashboard just stops listing the scenario.
- Undo with `ai-qa-agent scenarios restore <id>`: the scenario returns (approved) to the JSON and
  its test comes back on the next `ai-qa-agent generate --page <page>` (or `run`), which
  regenerates that page's spec with AI.

### Adding and editing scenarios

In the dashboard, *Add scenario* opens a form (page, title, type, priority, viewport, steps,
expected results, and optional preconditions, test data, feature and rationale). Either fill it in
yourself, or write one sentence under *Describe the test* and click *Draft with AI*: the AI fills
in the fields for you to review, and nothing is saved until you click *Add scenario*. *Edit* at
the bottom of a scenario's panel opens the same form for an existing scenario.

- Scenarios you add or edit get `"origin": "person"` in `.qa/scenarios/<page>.json` and show a
  *Yours* chip. Scenario generation keeps them exactly as written: the AI is told not to repeat
  them, and any AI scenario that reuses their id or title is dropped. Editing an AI scenario makes
  it yours.
- New scenarios get the next free id on the page; ids of removed scenarios are never reused.
- Saving does not touch the tests. A scenario without a test shows *No test yet*, and one changed
  after its test was written shows *Test out of date*; both are listed under the *Needs a test*
  tab. Its panel then offers *Create test* or *Rewrite test* (always available for approved
  scenarios): the AI writes only that scenario's test, and it is spliced into
  `.qa/tests/<page>.spec.ts` in place of the old one (or after the last test), so every other test
  in the file stays exactly as it was. The edited file is checked with `playwright test --list`;
  after three failed attempts the original file is kept. A page with no spec file yet gets its
  whole file generated instead.
- *All* lists every scenario, the ones with a result in the selected run first; *Not run (N)* lists
  those without one. A scenario with a test has *Run this test* (*Run this test again* once it has
  a result) in its panel: Playwright runs only that test, and its result replaces the scenario's
  result in the selected run (evidence under `.qa/artifacts/runs/<run>/reruns/`), marked as run on
  its own. An earlier AI analysis of that test is no longer shown, since it described an older
  failure. With no run yet, a new run is started. `ai-qa-agent test` still runs everything.
- *Run tests* in the top bar opens a menu: *All tests* (a new run with every test, like
  `ai-qa-agent test`; the dashboard switches to it when done), *Failed tests (N)* (only the failed
  and flaky tests of the selected run, run again and updated in it), *Critical flows (N)* (a new
  run with only those) and *Tests not run yet (N)* (every test without a result in the selected
  run, added to that run). *Refresh* (the round-arrows icon) reloads results and re-checks the bug
  tracker. Runs and fix plans continue in the background; reloading the page keeps showing their
  progress. *Cancel* in
  the progress banner stops Playwright or the AI at once (the whole process tree) and changes
  nothing: no results are merged, no plan is written, and a cancelled run of all tests is recorded
  as failed with "Cancelled".
- The menu on the left shows how the tests run (production build or development server) and the
  bug tracker in use: *connected* (verified against the tracker with your token, with the project
  or list), *credentials missing* (which variables to set), *cannot connect* (the error), or *not
  set up*. With no tracker configured it lists the ones you can set up.

### Bug-fix plans

`ai-qa-agent plan` (or *Create fix plan* on the dashboard's Overview and Defects pages) turns the failed tests of a run
into a document for developers: a summary table in the suggested fix order, then per bug what is
wrong, steps to reproduce, the root cause with file and line, the proposed fix (with a short code
hint where it helps), files to change, risks, how to verify, and screenshot evidence. Failed tests
the AI judges to be test bugs, flaky or environment problems are listed at the end with the reason.

- It is written to `<project>/docs/bug-fix-plan/<run-id>-plan.md`; change the folder with `plans: { dir: '...' }`
  in `.qa/config.ts` or `--dir`.
- One AI call reads the source code and the failures; it never edits code. It needs only a test
  run with failures, no other step first. When the run was triaged, the planner starts from the
  triage verdicts instead of working them out again, and the plan says what the run was tested
  against.
- An existing plan is not overwritten without `--force` (the dashboard asks first), since the team
  may have edited it.

## Configuration (`.qa/config.ts`)

```ts
import { defineConfig } from '@mohammadvazifedoost/ai-qa-agent';

export default defineConfig({
  project: { name: 'shop', framework: 'next', packageManager: 'pnpm' },
  app: {
    baseUrl: 'http://127.0.0.1:3000', // dev URL; production testing uses its host with a free port
    mode: 'production',              // default; 'development' tests the dev server instead
    production: {                    // optional: detected from the framework and package.json
      buildCommand: 'pnpm run build',                           // false: nothing to build
      startCommand: 'pnpm exec next start -p {port} -H {host}', // {port}/{host} are filled in
      buildTimeoutMs: 600_000,
    },
    startCommand: 'pnpm dev',        // dev server; used only with mode: 'development'
    startTimeoutMs: 120_000,
    reuseExistingServer: true,       // mode 'development' only
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
    tags: ['ai-qa-agent'],
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
  scenarios: {
    maxPerPage: 15,                  // optional cap per page; omit for no limit (default)
    maxCritical: 5,                  // optional cap on critical flows; omit for no limit (default)
  },
  visual: { pixelThreshold: 0.1, acceptableDiffRatio: 0.02 },
  ai: {
    provider: 'claude-code',         // claude-code | codex | opencode
    model: 'sonnet',                 // provider-specific; omit for the provider's default
    command: 'claude',               // optional: path to the CLI executable
    maxBudgetUsdPerTask: 3,
    minConfidenceToFile: 0.7,
    mcpServers: {
      figma: { type: 'http', url: 'https://mcp.figma.com/mcp' },
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'] },
    },
  },
});
```

The full schema (with defaults) is in [`src/config/schema.ts`](./src/config/schema.ts); invalid
configs fail fast with a readable error. `.qa/rules.md` is free-form guidance (test accounts,
out-of-scope areas, known issues) that is included in every AI prompt. Writing good rules is the
easiest way to improve results, for example:

```md
- Log in with qa@example.com / Passw0rd! (seeded test user).
- The /admin area is out of scope.
- Prices are shown in EUR with two decimals.
- Known issue: the newsletter form is disabled on staging; do not report it.
```

### Production-mode testing

Tests run against a production build, not the development server. A dev server compiles pages on
demand, which makes the first visit of every page slow and causes timeouts that are not bugs; it
also differs from what users get (no minification, different error handling, dev-only overlays).

For `generate`, `test` and `run` the agent:

1. works out the build and serve commands: `app.production` in the config wins, the rest is
   detected from the framework and the scripts in `package.json`;
2. builds the app (`NODE_ENV=production` plus `app.env`). The build is skipped when no file of
   the project changed since the last successful build;
3. starts the production server on a free port, so it never collides with a dev server you have
   running, and waits until it answers;
4. runs the tests against that URL (the generated Playwright config takes it from
   `AI_QA_BASE_URL`), stores the results, and stops the server.

| Framework | Build | Serve |
|---|---|---|
| Next.js | `build` script | `next start -p {port} -H {host}` |
| Vite, SvelteKit | `build` script | `vite preview --port {port} --host {host} --strictPort` |
| Astro | `build` script | `astro preview --port {port} --host {host}` |
| Gatsby | `build` script | `gatsby serve -p {port} -H {host}` |
| Nuxt | `build` script | `node .output/server/index.mjs` (port from `PORT`) |
| Remix, React Router | `build` script | `start` script (port from `PORT`) |
| Angular, Create React App, anything else | `build` script | not detectable: set `app.production.startCommand`, e.g. `npx serve -s dist -l {port}` |

What you can rely on:

- **No silent fallback.** If the build fails, the run stops, shows the end of the build output
  (the full output is in `logs/app-build.log` of the run) and no test is run. If the commands
  cannot be worked out, the error says what is missing and how to configure it. The dev server
  is never used instead.
- **Reports say what was tested.** `results.json` records `app: { url, mode, build }`, and the
  report, the bug reports and the fix plan repeat it. A run against the dev server is labelled
  "development server — not production-validated".
- **Testing the dev server is a decision you make**, with `app.mode: 'development'`. Then
  `app.startCommand`, `app.baseUrl` and `app.reuseExistingServer` apply as before.
- **Ports.** With `{port}` in the command (or a framework that reads `PORT`) every run gets a
  free port. A server that only works at one address needs `app.production.baseUrl`; if
  something already answers there, the run stops, because it could be a dev server. Set
  `app.production.reuseExistingServer: true` only for a server you know is a production build;
  the report then says "production server that was already running".
- **Environment.** The build and the server get the environment of the `ai-qa-agent` process,
  `NODE_ENV=production`, and the variables in `app.env`. Put values that a framework inlines at
  build time (`NEXT_PUBLIC_*`, `VITE_*`) in `app.env`: changing them there triggers a new build,
  changing them only in your shell does not.

### Secrets and environment variables

Nothing secret is written to `.qa/`. ClickUp is authenticated through the environment variable
named in `clickup.tokenEnv`, Jira through the variables named in `jira.tokenEnv` and
`jira.emailEnv`; the AI engine and Figma are authenticated through the chosen CLI's own login and
OAuth flows. `.qa/.gitignore` excludes artifacts, reports and state; scenarios, tests, config and rules
are meant to be committed.

The *Bug tracker* page of the dashboard can keep the token (and the Jira email) for you in
`.qa/.env.local`, a git-ignored file read when any command starts. A variable already set in the
shell wins over that file.

Setting a variable for the current shell:

```bash
export CLICKUP_API_TOKEN=pk_...          # macOS / Linux / Git Bash
$env:CLICKUP_API_TOKEN = "pk_..."       # Windows PowerShell
set CLICKUP_API_TOKEN=pk_...            # Windows cmd
```

## Using it without Figma or a bug tracker (code-only mode)

Both integrations are optional. With no `figma` section the agent works from the source code and
the running application alone: it still analyzes routes, forms, states and business rules, writes
functional and responsive scenarios (responsive expectations come from general usability rules:
no horizontal overflow, reachable navigation, stacking), generates and runs the Playwright tests,
captures video/screenshots/traces, and triages failures. Visual/design-token scenarios are simply
not generated, since there is no design to compare against.

With no `clickup` or `jira` section, confirmed defects stay in the report
(`.qa/reports/<run>/bugs/*.md`) and in the dashboard, which shows no *Create task* / *Create issue*
buttons.

```bash
npm install -D github:mohammadvazifedoost/ai-qa-agent @playwright/test
npx playwright install chromium
npx ai-qa-agent init            # no --figma, no --clickup-list / --jira-*
npx ai-qa-agent run             # code-only end-to-end QA
npx ai-qa-agent ui
```

Add `figma` / `clickup` / `jira` to `.qa/config.ts` later at any time; the next run picks them up.

## Figma setup

1. The AI CLI must have the official Figma MCP server (`https://mcp.figma.com/mcp`) authorized.
   With Claude Code run `claude mcp add --transport http figma https://mcp.figma.com/mcp` once and
   complete the OAuth login when prompted inside Claude Code. AI QA Agent passes the same server to
   its AI tasks. With Codex run `codex mcp login figma`, with OpenCode `opencode mcp auth figma`.
2. Put the file URL in `figma.fileUrl` (or pass `--figma <url>` to `init`). The agent lists pages
   and frames, reads variables, text styles and component specs, and downloads a 1:1 screenshot of
   each screen frame to `.qa/design/refs/`.
3. Optionally pin frames to routes in `figma.frames`; otherwise routes are inferred from frame
   names and content and marked with their certainty.

`.qa/design-system.json` distinguishes `observed` (read from Figma data), `inferred` and lists
everything `unknown`. Tokens are never invented.

**Figma plan limits.** The Figma MCP server allows only 20 read calls **per month** on Starter
plans (200+/day with a Dev/Full seat on paid plans). AI QA Agent reports when calls were rejected,
keeps the partial result, and fetches missing reference screenshots on the next run.

## ClickUp setup

1. Create a personal API token in ClickUp (Settings → Apps) and set it as `CLICKUP_API_TOKEN`
   (see [Secrets](#secrets-and-environment-variables)), or as a secret in CI.
2. Put the target list id in `clickup.listId` (from the list URL or the API), or pass
   `--clickup-list <id>` to `init`. `ai-qa-agent doctor` verifies the token and shows the list name.
3. Confirmed defects become tasks named `[AI QA Agent] <title>` with a markdown description (severity,
   category, page, steps, expected/actual, root cause, environment, test ids) and the screenshot,
   video, trace and design-diff images attached. Priority maps from severity.

## Jira setup (Jira Cloud)

1. Create an API token at id.atlassian.com → Security → API tokens and set it together with the
   account email: `JIRA_API_TOKEN=...` and `JIRA_EMAIL=you@company.com` (or put `email` in the
   config; it is not a secret, the token is).
2. Add the section (or run `npx ai-qa-agent init --jira-url https://yourco.atlassian.net --jira-project SHOP`):

   ```ts
   jira: {
     baseUrl: 'https://yourco.atlassian.net',
     projectKey: 'SHOP',
     issueType: 'Bug',                 // default
     tokenEnv: 'JIRA_API_TOKEN',       // default
     emailEnv: 'JIRA_EMAIL',           // default
     labels: ['ai-qa-agent'],          // default
     priorities: { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' }, // default
   },
   ```
3. `ai-qa-agent doctor` verifies the credentials and shows the project name.
4. Defects become issues through the official REST API v3: the bug report is converted to Atlassian
   Document Format, labels are added, priority is mapped from severity (and dropped automatically if
   the project does not use that field), and screenshot, video, trace and design diffs are attached.

If both `clickup` and `jira` are configured, set `tracker: 'jira'` or `tracker: 'clickup'`.

**Nothing is ever filed automatically; there is no flag or setting for it.** After a run,
confirmed defects wait in the report and in the dashboard (`ai-qa-agent ui`); a task/issue is
created only when a person clicks *Create task* (ClickUp) or *Create issue* (Jira) on a failed
test. Symptoms of one underlying defect are grouped into one bug report, so one click covers all
the tests it affects.

## Dashboard (`ai-qa-agent ui`)

`npx ai-qa-agent ui` serves a local page (default `http://127.0.0.1:4310`) built from the files the
pipeline writes. There is no database and no external service.

The menu on the left has the project, five pages in two groups (*Results*: Overview, Defects,
Scenarios; *Setup*: Project, Bug tracker; *Set up* next to Bug tracker while it is not connected)
and, under them, the selected run at a glance (a ring of passed, flaky and failed tests with the
pass rate). The top bar has the run picker (every run, newest first, with its date,
counts and verdict; arrow keys move through it, Escape closes it), two icon buttons (dark / light
mode, and *Refresh*), *Add scenario* and *Run tests*. On a small screen the menu opens from the
button in the top bar.

- **Overview** answers "how did the run go": passed / failed / flaky / not run with the pass rate
  against the target, the defects to review, results per page (a page name opens its scenarios),
  the critical flows with their results, and what to do next. Before the first run it shows the
  steps to get started instead.
- **Scenarios** lists every scenario with its result. Filter by result (*All*, *Failed*, *Passed*,
  *Not run*, *Needs a test*, each with its count), page, type (functional, visual, responsive,
  accessibility) or search; long lists are paged. Selecting a scenario opens its panel: the result
  and why it failed (with a link to the defect), the evidence (screenshot, video, trace,
  console/network log, page snapshot), the test error (collapsed), preconditions, steps and
  expected results, and the actions *Run this test*, *Create test* / *Rewrite test*, *Edit* and
  *Remove*.
- **Defects** lists what needs a decision: the defects the analyzer confirmed, by severity, then
  the failed tests it did not confirm as a product bug (test problem, environment problem, cause
  not confirmed, not analyzed). A defect shows what was expected and what happened, the cause with
  file and line, how the analyzer decided, the steps to reproduce, the tests that found it and
  their evidence.
- **Project** shows what the agent knows about the application and brings it up to date without
  a terminal, in three steps. Each step says whether it is out of date, asks before it starts
  (what changes, what stays) and then runs in the background with a progress line and *Cancel*:
  1. *Application analysis*: the pages, journeys and when they were analyzed, and which pages
     changed in the code since then. *Update the analysis* reads only the changed and new pages
     (`ai-qa-agent analyze`); *Analyze everything again* reads the whole application
     (`analyze --refresh`), optionally with the Figma design.
  2. *Scenarios*: per page, how many there are and whether they are older than the analysis.
     *Update scenarios* writes the pages that are out of date or have none, *Regenerate all
     scenarios* writes every page (`scenarios --force`), and each row can be written on its own.
     Pages are saved one by one, so cancelling keeps the pages already written.
  3. *Critical flows*: the ones chosen, and *Choose critical flows* (`scenarios --critical`), with
     an optional maximum.

  Long tables (the pages of the analysis, scenarios per page, results per page on Overview) get a
  search box, *All* / *Changed* (or *Out of date*, *With failures*) with counts, and ten rows at a
  time with *Previous* / *Next*.

  These steps call the AI, so they take minutes and are billed by your AI provider; the result
  line ends with the cost when the provider reports it. Checking what is out of date compares
  files only and is free. The menu shows *Out of date* next to Project when step 1 or 2 needs an
  update.

- Every defect has either an *Open task … in ClickUp* / *Open … in Jira* link or a *Create task in
  ClickUp* / *Create issue in Jira* button. The dashboard checks the tracker for the item recorded
  for that defect (from this run or an earlier run of the same defect, cached for a minute); if it
  still exists you get the link, otherwise (never created, or deleted there) the button. A click
  creates it from the bug report (consolidated for confirmed defects; for failures the analyzer
  did not confirm it is built from the scenario and the error and labelled `needs-verification`).
- *Remove* at the bottom of a scenario's panel removes the scenario and its test after an inline
  confirmation (optional reason); see [Removing scenarios](#removing-scenarios).
- *Delete screenshot* / *Delete video* (and *Delete all media* when there are several) under the
  evidence delete those files from the run after an inline confirmation and remove them from its
  `results.json`. Traces and logs are kept.
- The dashboard follows the light or dark setting of your system until you choose one with the
  button in the top bar; the choice is remembered in the browser. On a wide screen a list and the
  selected item sit side by side; on a narrow one the item replaces the list, with a link back.
  Every view has its own address (`#/scenarios/CONTACT-009`, `#/defects/ISSUE-001`), so the
  browser's back button and bookmarks work.
- **Bug tracker** connects ClickUp (list ID, API token, optional status of new tasks) or Jira (site
  address, project key, email, API token). *Test connection* checks them without saving; *Save and
  connect* tests again, then writes the list or project into `.qa/config.ts` (comments and the rest
  of the file are kept; `tracker` is set when both are configured) and the token and email into
  `.qa/.env.local`, never into config. A token set in the shell that started the UI still works and
  wins. Filing results are written back to the run so the report and the dashboard stay consistent.

### Accessibility checks

Scenarios of type `accessibility` check WCAG 2.1 A/AA with [axe-core](https://github.com/dequelabs/axe-core)
in the states that matter (page loaded, a form showing its errors, an open dialog or menu). The
generated tests reach the state and call `qa.expectAccessible()`:

```ts
await qa.expectAccessible();                                   // the whole page
await qa.expectAccessible({ include: page.getByRole('dialog') }); // one region
await qa.expectAccessible({ disableRules: ['color-contrast'] });  // skip rules by id
```

- **Serious** and **critical** violations fail the test; minor and moderate ones do not. Every
  violation (rule, impact, help text, elements) is attached to the result as `qa-a11y.json`.
- The AI adds plain assertions for what axe does not check, e.g. that validation errors are
  linked to their fields with `aria-describedby`.
- Pages with a strict Content-Security-Policy that blocks inline scripts need Playwright's
  `bypassCSP` for axe to be injected.

## Playwright setup

AI QA Agent generates `.qa/playwright.config.ts` from your config on every run: one project per
browser × viewport, video/trace/screenshot always on, JSON reporter. Tests select their viewport
through tags (`@desktop`, `@mobile`, …). You can run them yourself:

```bash
cd .qa && npx playwright test --config playwright.config.ts --grep @checkout
npx playwright show-trace .qa/artifacts/runs/<run>/traces/CHECKOUT-002_chromium-desktop.zip
```

Generated tests import `test`/`expect` from `@mohammadvazifedoost/ai-qa-agent/playwright`, which adds:

- `qa.expectDesignTokens(locator, { backgroundColor: '#2563EB', borderRadius: '8px', ... })`:
  computed-style comparison against Figma values (colors as RGBA, lengths ±0.5px, families,
  shorthand expansion);
- `qa.compareWithDesign('Home / Desktop')`: pixel comparison (pixelmatch) with the Figma reference,
  attaching expected/actual/diff images and recording `match | acceptable | mismatch`;
- `qa.expectNoHorizontalOverflow()`: fails on horizontal scroll and names the offending elements;
- `qa.expectAccessible()`: axe-core WCAG checks (see above);
- automatic capture of console errors, page errors and failed/4xx/5xx requests.

Generated tests follow fixed reliability rules:

- **Locators** in this order: role and accessible name, test id, label, another stable attribute,
  then a relation to a nearby element. No CSS class chains, no XPath, no position in a list
  unless the scenario is about the position.
- **Assertions** state the expected result of the scenario and carry a message that says what
  was checked, so a failure reads like `Total after SAVE10 … Expected "$37.80", Received "$42.00"`.
- **Waiting** is done by Playwright's web-first assertions. No fixed waits, no `networkidle`.
- **No hidden failures:** no `force: true`, no `test.skip` / `test.fixme` / `test.only`, no
  `try/catch` around an assertion, no serial mode.
- **Independence:** every test starts from a fresh browser and builds its own state through the
  UI.

The mechanical part of these rules is checked in code: a generated spec that contains a fixed
wait, `networkidle`, `force: true`, a skipped or focused test, serial mode or an XPath locator is
sent back to the test author. If it still has them after three attempts, generation stops with
the list of problems and the spec is not accepted.

You can use the same helpers in hand-written tests:

```ts
import { test, expect } from '@mohammadvazifedoost/ai-qa-agent/playwright';

test('primary button matches the design @desktop', async ({ page, qa }) => {
  await page.goto('/');
  await qa.expectDesignTokens(page.getByRole('button', { name: 'Buy now' }), {
    backgroundColor: '#2563EB',
    borderRadius: '8px',
  });
  await qa.expectNoHorizontalOverflow();
});
```

## Running in CI

`ai-qa-agent test` needs no AI and is the cheapest check for every pull request: it runs the
committed tests in `.qa/tests/` and collects evidence. `ai-qa-agent run` adds analysis,
generation and triage, and needs an AI CLI with credentials in CI. Both exit with code 1 when tests
fail or defects are found.

Example GitHub Actions workflow in the target project (`.github/workflows/qa.yml`):

```yaml
name: QA
on: [pull_request]

jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci
      - run: npx playwright install --with-deps chromium

      # Only needed for `run` (AI steps). `test` alone needs no AI.
      - run: npm i -g @anthropic-ai/claude-code

      # Keep .qa/state.json between runs so unchanged pages are not re-analyzed
      - uses: actions/cache@v4
        with:
          path: .qa/state.json
          key: qa-state-${{ github.ref }}
          restore-keys: qa-state-

      - run: npx ai-qa-agent run --changed
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: qa-report
          path: |
            .qa/reports/
            .qa/artifacts/runs/
```

Both commands build the app and serve the production build inside the job, so the job needs the
project's dependencies (`npm ci`) and every variable the build reads. A failed build fails the
job with the build output. Nothing has to be started beforehand, and no port has to be free.

If CI uses npm 11.x or 12 and fails with `EALLOWGIT`, commit the project `.npmrc` with
`allow-git=all` (see [Installing](#1-add-the-package)).

## Generated files

```
.qa/
  config.ts              project configuration (commit)
  rules.md               free-form QA rules for the AI (commit)
  project.json           deterministic project discovery
  app-model.json         AI analysis of the source, shared by every mode: pages (elements, forms, states,
                         business rules, importance), ranked user journeys, auth, integrations, test data, unknowns
  design-system.json     tokens, components, screens from Figma (observed / inferred / unknown)
  design/refs/*.png      1:1 Figma screenshots used as visual references
  scenarios/<page>.json  test scenarios with ids, steps, expected results, priority, approval flag (commit)
  tests/<page>.spec.ts   generated Playwright tests (commit; regenerated when scenarios change)
  playwright.config.ts   generated on each run
  state.json             stage hashes, run checkpoints, filed-bug fingerprints (resumability)
  artifacts/runs/<run>/  videos/ traces/ screenshots/ logs/ design/ results.json triage.json filing.json
                         results.json records what was tested: app { url, mode, build };
                         logs/app-build.log and logs/app-server.log are the build and server output
  artifacts/production-build.json  fingerprint of the last successful production build (skips unchanged builds)
  artifacts/logs/        ai-qa-agent.log and every AI transcript
  reports/<run>/         report.md, report.html, bugs.json, bugs/BUG-00n.md
  reports/latest.md
docs/bug-fix-plan/       bug-fix plans written by `ai-qa-agent plan` (outside .qa/, for developers)
```

## Failure analysis

Each failed test is classified as `PRODUCT_BUG`, `TEST_BUG`, `ENVIRONMENT_FAILURE`,
`INFRASTRUCTURE_FAILURE`, `DESIGN_MISMATCH` or `UNKNOWN`:

1. Unambiguous cases are decided by rules (connection refused, browser missing, spec syntax
   errors, flaky = passed on retry).
2. Everything else is analyzed by the AI with the error, the test code, the final screenshot,
   the DOM snapshot at failure, console/network logs, the deterministic check results, the
   scenario, and the analysis of every page the scenario visits. Figma data is added only for
   design-related failures. The triager first checks that the test did what the scenario says and
   that the expectation is legitimate, then reads the application source to find the cause.
   Behaviour that is missing altogether (a button without a handler) is a product bug when the
   test asserted it in a generic way, and a test bug when the test demanded a text or route that
   nothing defines. A failed critical flow that is a product bug is at least high severity.
3. Defects are consolidated: several failing tests caused by one CSS rule become one issue.

The report, every bug report and the fix plan state what the run was tested against, for example
`http://127.0.0.1:14944 (production build)`.

Only confirmed defects are filed. Test bugs are listed in the report with a suggested fix. The
agent never edits tests to make them pass, and never edits application code.

## State and resumability

Stages are cached on content hashes: analysis reruns only when source files change, scenarios only
when a page's model/design changed, tests only when scenarios changed. Runs are checkpointed in
`.qa/state.json`; `ai-qa-agent run --resume` continues an interrupted run from the last completed stage
using the stored results. `--refresh` forces re-analysis.

## Writing apps the agent tests well

The agent understands your app the way a screen reader does. The analysis step reads the source
and records each page's headings, the accessible names of buttons, links and inputs (from visible
text, `<label htmlFor>` and `aria-label`), forms with their exact validation messages, and the
loading, empty and error states ([`src/analyze/app.ts`](./src/analyze/app.ts)). The test generator
is then told to prefer `getByRole` / `getByLabel` / `getByText` with exact accessible names, to use
`getByTestId` only where the page model lists a `data-testid`, and to avoid CSS/XPath selectors
([`src/generate/playwright.ts`](./src/generate/playwright.ts)). In the demo shop's generated tests
that is 90 `getByRole`, 46 `getByText`, 7 `getByLabel` and 5 `getByTestId` calls. So an app that is
accessible is also an app the agent finds its way around, and a missing or vague name usually ends
up as a `TEST_BUG` or a wrong scenario rather than a useful finding.

**Use the copy-paste rules:** [`docs/AGENTS.qa-guidelines.md`](./docs/AGENTS.qa-guidelines.md)
holds the same guidelines as short MUST/SHOULD rules for an AI coding agent. Paste its content into
your app's `AGENTS.md` (or `CLAUDE.md`, `.cursor/rules`, ...) so new code follows them. It is not
shipped in the npm package; copy it from the repository.

### Checklist

1. **Semantic HTML first.** Real `<button>`, `<a href>`, `<form>`, `<label>`, `<ul>/<li>`,
   `<table>`; one `<h1>` per page and a logical heading order; landmarks (`<header>`, `<nav>`,
   `<main>`, `<footer>`). No clickable `<div>`s.
2. **Every control has a short, unique, visible name.** Use `aria-label` / `aria-labelledby` only
   when there is no visible text (icon buttons), and make repeated controls distinct
   (`Remove Ceramic Mug`, not five `Remove` buttons).
3. **Inputs are labelled** with `<label htmlFor>` (or a wrapping `<label>`); placeholders are not
   labels.
4. **Validation messages are tied to their fields** with `aria-describedby` and `aria-invalid`;
   form-level errors use `role="alert"`, confirmations `role="status"`.
5. **Loading, empty and error states are explicit**: `aria-busy` on the region that loads, visible
   text such as `Applying…` or `Your cart is empty`, and a real message on error.
6. **`data-testid` only where a role and name cannot identify the element** (a price in a `<dd>`,
   a chart, a canvas), following the naming convention below.
7. **Deterministic rendering**: no generated ids or class names as identifiers, stable list order
   and keys, mockable time and randomness, animations that respect `prefers-reduced-motion`.
8. **Routes are declared literally** so they can be found in the source (see below).
9. **Test data is seedable and documented** in `.qa/rules.md`.
10. **No console errors or failing requests in normal use.** Tests capture both as evidence, and
    the triage step reads them.

### Roles and accessible names

```tsx
// Bad: no role, no name, the agent can only guess a CSS selector
<div className="btn-x7f2" onClick={addToCart}><CartIcon /></div>

// Good: a real button with a name that says what it does to which item
<button type="button" onClick={addToCart} aria-label={`Add ${product.name} to cart`}>
  <CartIcon aria-hidden="true" />
</button>
// → page.getByRole('button', { name: 'Add Ceramic Mug to cart' })
```

Prefer visible text over `aria-label`: the name the user reads is the name the scenario uses.
Name regions that repeat (`<nav aria-label="Main">`, `<ul aria-label="Order items">`,
`<section aria-labelledby="products-heading">`) so a test can scope to one of them.

### Forms and validation

```tsx
<form onSubmit={submit} noValidate aria-label="Sign in">
  <label htmlFor="login-email">Email</label>
  <input
    id="login-email"
    type="email"
    aria-invalid={!!errors.email}
    aria-describedby={errors.email ? 'login-email-error' : undefined}
  />
  {errors.email && <p id="login-email-error">Enter a valid email address</p>}

  {formError && <p role="alert">{formError}</p>}
  <button type="submit" disabled={submitting} aria-busy={submitting}>
    {submitting ? 'Signing in…' : 'Sign in'}
  </button>
</form>
```

Keep validation messages as literal strings in the code (or one messages file): the analyzer copies
them into the page model, and the tests assert them exactly.

### Ids and test ids

Tests use Playwright's default test-id attribute, `data-testid` (`getByTestId`); the agent does not
change `testIdAttribute`. Use this convention for both `data-testid` and `id`:

- **kebab-case `<page>-<component>-<element>`**, e.g. `checkout-summary-total`,
  `login-email`, `login-email-error`; drop the component part when the page has only one, as in
  `login-email`.
- **Stable across renders and builds**: never from `useId()`, `Math.random()`, a CSS-module hash
  or an array index.
- **List items carry the item's domain key**, e.g. `checkout-line-${product.sku}`, and the same value
  as the React `key`.
- **Unique within the page**, and never reused for a different element after a refactor.

```tsx
// Bad: index-based, changes when the list is reordered
<li data-testid={`item-${i}`}>…</li>
// Good: tied to the data
<li key={line.sku} data-testid={`checkout-line-${line.sku}`}>…</li>

// A value with no role or name of its own
<dt>Total</dt>
<dd data-testid="checkout-summary-total">{formatPrice(totalCents)}</dd>
```

Element ids also show up in failure output: `qa.expectNoHorizontalOverflow()` names offenders as
`tag#id.class`, so a meaningful id makes the report readable.

### Routes, state and test data

- **Declare routes as string literals.** Detection reads file-based routes (Next.js `app/` and
  `pages/`, SvelteKit, Remix, Nuxt, Astro) and, for config routers, `<Route path="/x">` or
  `path: '/x'` ([`src/discovery/detect.ts`](./src/discovery/detect.ts)). Routes built at runtime
  from variables are invisible until the AI analysis finds them.
- **Reach every page through visible navigation.** Tests build preconditions through the UI (add a
  product, then go to checkout); in-memory state only survives client-side navigation, so link to
  the pages a flow needs.
- **Make test data reproducible.** Provide a seed script or fixed fixtures, a test account, and a
  stubbed or sandboxed payment/email provider, and write them in `.qa/rules.md`, which is included
  in every AI prompt:

  ```md
  ## Test data

  - Log in with qa@example.com / password from env QA_PASSWORD (created by `npm run db:seed`).
  - Coupon SAVE10 gives 10% off; EXPIRED is an expired coupon.
  ```

- **Remove nondeterminism the tests cannot control.** Let tests freeze time (read the clock in one
  place), seed or inject randomness, avoid A/B flags and rotating content in the test environment,
  and disable or shorten animations under `prefers-reduced-motion: reduce`. A test that passes only
  on retry is reported as flaky and never filed.
- **Make the production build reproducible**: one `build` script, a server that takes its port
  from an argument or `PORT`, and test configuration from environment variables (`app.env`),
  not from code edits.

### Accessibility

Accessibility scenarios run axe-core (WCAG 2.1 A/AA) and fail on **serious** and **critical**
violations (see [Accessibility checks](#accessibility-checks)). Beyond the points above: images have
`alt` (empty for decoration), text meets contrast ratios, everything is reachable and operable with
the keyboard with a visible focus, dialogs use `<dialog>` or `role="dialog"` with a name and manage
focus, and toggles expose `aria-expanded` / `aria-pressed`. If you use design tokens, keep them as
CSS custom properties with the values from Figma: the analyzer records them, and visual tests
compare computed styles against the design.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `EALLOWGIT: Fetching packages of type "git" have been disabled` | npm 11.x/12 blocks git dependencies by default. Run `npm config set allow-git all --location=project` and install again. |
| `npx ai-qa-agent` says *could not determine executable to run* or `dist/cli.js` is missing | The package was not built during install. Reinstall with npm (`npm install -D github:mohammadvazifedoost/ai-qa-agent`); with pnpm/Yarn allow the package's build scripts. Git must be installed. |
| `Cannot find module '@mohammadvazifedoost/ai-qa-agent'` in `.qa/config.ts` or a test | Install the package in the project itself (not only globally); the import name is `@mohammadvazifedoost/ai-qa-agent`. |
| `The production build failed: "..." exited with code N. Tests were not run.` | The app does not build. The message ends with the build output; the full output is in `.qa/artifacts/runs/<run>/logs/app-build.log`. Fix the build (run the command yourself to reproduce) or correct `app.production.buildCommand`. |
| `Production-mode testing is not possible: ...` | The serve or build command could not be detected (unknown framework, no `build` script, Angular/CRA without a static server). Set `app.production.startCommand` / `buildCommand`; `ai-qa-agent doctor` shows the result. |
| `Something already answers at http://...` in production mode | The production server has a fixed URL and another process (often the dev server) uses it. Stop that process, use `{port}` in `app.production.startCommand`, or set `app.production.reuseExistingServer: true` if it really is a production server. |
| The build is not repeated although something changed | The build is skipped when no project file changed (path, size, modification time) outside dependency and output folders. Delete `.qa/artifacts/production-build.json` to force a build. |
| `app-model.json was written by an older version` | The application model gained journey ranking. Run `ai-qa-agent analyze` (a `run` does it by itself); scenarios and tests are then refreshed once. |
| `App did not become ready at http://localhost:...` while the dev server log says ready | `localhost` resolved to IPv6 (`::1`) but the server or the OS only accepts IPv4 (or vice versa). The error prints a loopback probe; bind the server explicitly (`--host 127.0.0.1`) and use `http://127.0.0.1:<port>` in `app.baseUrl`. |
| `Figma MCP rejected N call(s) because of plan limits` | Monthly/daily Figma MCP quota exhausted. Partial results are kept; re-run `ai-qa-agent analyze` later. |
| `AI task ... failed (error_max_budget_usd)` | Raise `ai.maxBudgetUsdPerTask` or narrow the scope (`--page`). |
| `Claude Code exited ... without a result` | Run `claude --version` and `claude -p "hi"`; log in with `claude` if needed. |
| `No page matches "..."` | Use a route (`/checkout`), a slug (`checkout`) or the page name from `app-model.json`. |
| Visual tests fail with `no-reference` | The screen has no downloaded reference; check `design-system.json` → `references`. |
| A test is wrong, not the app | The triage report says `TEST_BUG` with the reason; fix `.qa/scenarios/<page>.json` (the expectation) and rerun `ai-qa-agent generate --page <page> --force`, or drop it with `ai-qa-agent scenarios remove <id>`. |
| Everything is regenerated each run | `.qa/state.json` is missing or ignored; keep it writable (it is git-ignored but must persist locally/in CI cache). |

Logs: `.qa/artifacts/logs/ai-qa.log` (all levels), `ai-qa-agent --debug ...` for console verbosity,
`AI_QA_DEBUG=1` to print stack traces.

## Developing this package

```bash
git clone https://github.com/mohammadvazifedoost/ai-qa-agent.git
cd ai-qa-agent
npm install          # also builds dist/ (prepare script)
npm run check        # typecheck + lint + unit tests + build
```

To try local changes in another project without pushing, install from the folder:
`npm install -D ../ai-qa-agent` (rebuild with `npm run build` after each change).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map and [CONTRIBUTING.md](./CONTRIBUTING.md)
for development and validation instructions; the intentionally buggy fixture app used for
end-to-end validation is in [`fixtures/demo-shop`](./fixtures/demo-shop).

## License

[MIT](./LICENSE) © mohammadvazifedoost

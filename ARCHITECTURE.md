# AI QA Agent — Architecture

## Principles

1. **Engine and target are separate.** The engine is this package; a target project contains only
   `.qa/` (config, rules, generated scenarios/tests, artifacts, state).
2. **The AI reasons, the engine acts.** Claude decides what to test, writes test code, and explains
   failures. The engine writes files, starts servers, runs Playwright, compares pixels/styles,
   talks to ClickUp. Every AI answer is schema-validated (Zod → JSON Schema → Claude Code
   `--json-schema` → Zod again on the way back).
3. **Read-only AI.** Tasks get `Read`, `Glob`, `Grep` and explicit MCP tools only, with
   `--permission-mode dontAsk` (undeclared tools are denied, not prompted), `--strict-mcp-config`
   and empty `--setting-sources` (no user plugins/hooks/MCP servers leak in), plus a per-task budget.
4. **Deterministic verdicts.** Pass/fail of visual checks comes from computed CSS and pixelmatch.
   Failure classification starts with rules; the AI handles the ambiguous remainder and must cite
   the evidence it inspected.
5. **Incremental and resumable.** Every stage hashes its inputs and is skipped when unchanged; runs
   are checkpointed so `--resume` continues from the last completed stage. Change detection is
   per page: a page's own files are hashed separately from files shared by every page (router,
   layout, global CSS), so adding a route re-analyzes and re-tests only the new page.
6. **Humans decide what reaches the tracker.** Confirmed defects are presented in the report and
   the dashboard; ClickUp tasks are created only on an explicit click or flag.
7. **One analysis, many selections.** The application is analyzed once into `app-model.json`:
   every page with its importance, and every user journey with its kind, criticality and how
   much of it is implemented. No mode has an analysis of its own. A full run, a page run and a
   critical-flow run differ only in which journeys and scenarios they select from that model,
   and the selection of critical journeys is code, not a second AI opinion.
8. **Intended behaviour is separate from observed behaviour.** The model records what the code
   does (`businessRules`, prefixed `SUSPICIOUS:` when it looks wrong) and what a journey is meant
   to achieve (`steps`, `outcome`), with the difference in `gaps`. Scenarios assert the intended
   outcome, so a defect in the code fails a test instead of becoming its expectation. What could
   not be determined goes to `unknowns`; it is never filled with an assumption.
9. **Production builds are what is tested.** The app is built and served in production mode on
   a free port. A build that fails or a project whose production commands cannot be determined
   is an error with the real reason; the dev server is used only when the config says so, and
   every result records what it ran against.

## Pipeline

```
init ──► analyze ──► design ──► scenarios ──► generate ──► test ──► triage ──► file ──► report
 det.      AI         AI+Figma     AI          AI+browser   Playwright  rules+AI  ClickUp   engine
```

| Stage | Module | Input | Output | Cache key |
|---|---|---|---|---|
| init | `discovery/detect.ts`, `init/init.ts` | package.json, file tree | `.qa/config.ts`, `project.json` | — |
| changes | `changes/detect.ts` | project.json routes, per-page file hashes, optional Figma metadata | list of new/changed/removed pages, changed shared files, new/changed Figma frames | — (free; Figma part costs MCP calls) |
| analyze | `analyze/app.ts` | source files, project.json, rules | `app-model.json`, model version 2: pages (elements, forms, states, rules, importance, access, navigation), ranked journeys (kind, criticality + reason, intended steps/outcome, implementation, gaps), auth, state, integrations, test data, unknowns, per-page and shared-file hashes. Routes the AI skipped are analyzed in a second pass; remaining inconsistencies are written to `unknowns` as "Model check: …" | all-source hash for the fast path; otherwise only new/changed pages are re-analyzed and merged, and the app-level facts (summary, auth, journeys, test data) are refreshed with them. A model of an older version is analyzed again in full |
| design | `design/figma.ts` | Figma MCP (metadata, variables, design context, screenshots) | `design-system.json`, `design/refs/*.png` | figma config + viewports |
| scenarios | `scenarios/generate.ts` | page model, the ranked journeys that pass through the page, the other pages (for navigation), test data, design subset, viewports | `scenarios/<page>.json`; a scenario that leaves its page lists every route in `routes` | per page: page files hash + model + journeys + design |
| (critical flows) | `scenarios/critical.ts` | the journeys of the shared model with `criticality: critical` and `kind: happy-path` (`selectCriticalJourneys`, deterministic), the full page models of every route they visit, test data, auth; `--critical` on `scenarios`/`generate`/`test`/`run` | one scenario per selected journey with `critical: true`, stored in the scenario file of its start page, or an existing approved scenario promoted to critical; journeys left uncovered are logged with the reason. No critical journey in the model: a warning and no AI call. Tests tagged `@critical`, selected by scenario id | `state.criticalInputs` (selected journeys, their pages, test data, auth, viewports, rules) |
| generate | `generate/playwright.ts`, `generate/scenario-test.ts` | approved scenarios, the page model plus the models of every other route the scenarios visit, the running production build, Playwright MCP (to confirm locators on it) | `tests/<page>.spec.ts`, validated with `playwright test --list` and `lintSpec` (fixed waits, `networkidle`, `force: true`, `.only`/`.skip`/`.fixme`, serial mode, XPath, wrong import); up to 3 fix rounds | per spec: scenarios + model + related pages |
| test | `runner/*` | specs, generated `playwright.config.ts`, the production build (`runner/server.ts`) | `artifacts/runs/<id>/` evidence + `results.json` including `app: { url, mode, build }` | — (the build is skipped when the project fingerprint is unchanged) |
| triage | `triage/*` | outcomes + evidence + scenario + the page models of the scenario's routes + source; design data only for design-related failures | `triage.json` (per-failure verdicts, consolidated issues) | — |
| plan | `plan/plan.ts` | failed outcomes, their scenarios and the triage verdicts | bug-fix plan; starts from the triage verdict instead of re-deriving it | — |
| file | `bugs/file.ts` | confirmed issues | `filing.json` marking them *pending* — the pipeline never creates tasks | — |
| (dashboard button) | `bugs/file.ts` `fileIssues`, `integrations/clickup.ts` | one issue or one failure, on a person's click | ClickUp task + attachments (or a comment on the task filed earlier), `filing.json`, `state.bugs` | fingerprint of scenario ids, root-cause files |
| ui | `ui/server.ts`, `ui/index.html`, `ui/client/*` | scenarios, run results, triage, filing | local dashboard (`/api/overview`, `GET /api/project` for what is out of date, `POST /api/project/analyze|scenarios|critical` to run those stages as cancellable jobs, `/files/*`, `POST /api/file` to log one issue, `POST /api/scenarios/delete` to remove a scenario, `POST /api/media/delete` to delete a result's screenshots/video, `POST /api/runs/critical` to run only critical flows, `GET /api/tracker` + `POST /api/tracker/test|save` to connect ClickUp or Jira (config through `config/edit.ts`, secrets in `.qa/.env.local` through `config/local-env.ts`); every POST must be `application/json`) | — |
| (remove / restore) | `scenarios/manage.ts`, `scenarios/spec-edit.ts` | scenario ids from the CLI or the dashboard | scenario moved to `removed` in `scenarios/<page>.json`; its test cut from the spec (validated with `--list`, rolled back on failure); `generatedSpecs` kept fresh | — |
| report | `report/model.ts`, `report/render.ts`, `report/evidence.ts` | results, scenarios, triage, filing (no AI) | `reports/<id>/report.json` (the `QaReport` model), `report.md`, `report.html`, `bugs/*.md`; also served as `GET /api/report?run=<id>` | — |

## Modules

```
src/
  cli.ts                  commander CLI; maps commands/flags to pipeline stages
  index.ts                public API: defineConfig + types
  config/                 Zod schema (+ defaults) and jiti-based loader for .qa/config.ts
  core/                   paths, logger (console + file), fs/hash helpers, process spawning
  ai/engine.ts            AiEngine contract (AiTask/AiResult/ToolCallRecord), canonical MCP tool names,
                          prompt-based structured output + JSON extraction + correction round
  ai/index.ts             provider factory (ai.provider) and the doctor check for each CLI
  ai/claude.ts            ClaudeRunner: spawns `claude -p --output-format stream-json` with a native
                          JSON schema, isolated settings, allow-listed tools, spend cap
  ai/codex.ts             CodexRunner: `codex exec --json --sandbox read-only`, MCP servers via -c
                          overrides with enabled_tools allow-lists, token usage
  ai/opencode.ts          OpenCodeRunner: `opencode run --format json` with a read-only agent and MCP
                          servers injected via OPENCODE_CONFIG_CONTENT; corrections reuse the session
  ai/context.ts           system prompts: the rules every agent shares (BASE_SYSTEM) plus one role
                          per agent (systemPrompt(role)); project rules; Figma URL parsing
  ai/prompts.ts           prompt fragments shared by several agents: expectation rules, step rules,
                          the priority rubric, what counts as a low-value scenario
  discovery/detect.ts     deterministic framework/route/test detection
  analyze/app.ts          AppModel schema and version; full analysis, per-route incremental analysis
                          + merge, model checks; journey ranking helpers (rankedFlows, criticalFlows)
                          and requireAppModel, the only way later stages read the model
  changes/detect.ts       deterministic code change detection (per-page + shared-file hashes) and
                          opt-in Figma change detection (frame list + page structure hashes)
  ui/server.ts            local dashboard server (node:http): the JSON API and the static files
  ui/index.html           the dashboard's single page: the frame (menu, top bar, dialog)
  ui/project.ts           the Project page's server side: what is out of date (file comparison,
                          no AI) and the analyze / scenarios / critical-flow steps as jobs
  ui/client/*             browser modules, no framework: logic.ts (filters, routes, defects; no
                          DOM, unit-tested), shell.ts (menu + top bar), overview.ts / scenarios.ts /
                          defects.ts / project.ts (the pages), editor.ts (scenario form), actions.ts
                          (run, write test, log bug, delete), theme.ts (light / dark), main.ts
                          (event dispatch and hash routing)
  ui/tailwind.css         design tokens + component classes; compiled by the Tailwind CLI during
                          `npm run build` into dist/ui/styles.css, served at /styles.css (no CDN,
                          no build step for users of the package)
  design/schema.ts        DesignSystem schema with observed/inferred/unknown certainty
  design/figma.ts         extraction task (read-only Figma tools), reference image download,
                          rate-limit reporting, back-fill of missing references
  scenarios/              Scenario schema, generation per page (respects removed scenarios), page
                          selection helpers
  scenarios/critical.ts   critical-flow (smoke) mode: selects the critical happy paths of the shared
                          model, has one scenario written per journey, merges into page files,
                          selects their tests
  scenarios/manage.ts     list/remove/restore scenarios; removal tombstones and spec cache upkeep
  scenarios/spec-edit.ts  lexer-based removal of one test('<ID>: …') block from a spec (no AI)
  generate/playwright.ts  test generation + validation loop; lintSpec (reliability rules as code)
  generate/scenario-test.ts  writes or replaces the test of a single scenario in a spec
  playwright/index.ts     runtime for generated tests (fixtures: qa helpers, log capture)
  playwright/style.ts     pure CSS value comparison
  runner/production.ts    production commands per framework, {port}/{host} placeholders, free port,
                          build fingerprint; EnvironmentError / BuildError
  runner/server.ts        ensureApp: build (or reuse the current build), serve, wait, stop (kills
                          the process tree; loopback diagnostics); development mode only by config
  runner/playwright-config.ts  renders playwright.config.ts (project per browser × viewport); the
                          base URL comes from AI_QA_BASE_URL, set by the runner for each run
  runner/results.ts       Playwright JSON report → normalized TestOutcome + evidence copying
  runner/run.ts           executes Playwright with filters (files, tags, scenario ids)
  runner/media.ts         delete a result's screenshots/video and drop them from results.json
  triage/rules.ts         deterministic classifications
  triage/triage.ts        AI verdict per failure (3 in parallel), consolidation into issues
  bugs/report.ts          bug markdown, environment, evidence selection
  bugs/file.ts            ClickUp filing with dedupe via state fingerprints
  integrations/tracker.ts IssueTracker interface + selection (tracker / clickup / jira sections)
  integrations/clickup.ts minimal ClickUp REST v2 client (validated responses)
  integrations/jira.ts    minimal Jira Cloud REST v3 client (basic auth, ADF, attachments, priority fallback)
  integrations/adf.ts     Markdown → Atlassian Document Format for bug descriptions
  report/evidence.ts      evidence of one result from disk: parsed assertion, console/page errors,
                          failed and 4xx/5xx requests, captured vs missing artifacts
  report/model.ts         buildQaReport: the structured, schema-validated report (one entry per
                          scenario, consolidated issues, fix order, regression, statistics)
  report/render.ts        Markdown and HTML renderings of the model (8 sections, per-scenario template)
  report/report.ts        writes report.json/md/html and the per-issue bug files
  triage/analysis.ts      engine checks of an AI analysis (locations exist, category agrees with the
                          classification, no test-weakening fixes, severity floor) and rule analyses
  state/state.ts          .qa/state.json store (stage hashes, runs, filed bugs)
  pipeline/context.ts     loads config/state/runner once per invocation
  pipeline/run.ts         stage orchestration with checkpoints and resume
```

## AI agents and hand-offs

Every AI task runs as one of seven agents. An agent's system prompt is the shared rules
(`BASE_SYSTEM`: evidence first, observed versus intended, "unknown" is a valid answer, read-only,
stay in role, be concrete, answer through the structured output) followed by its role: objective,
the decisions it may take, what it must not do, and who consumes its output. The task prompt then
has fixed sections: `## Task`, the data it works on, `## Procedure`, and the rules for its output.

| Agent (`AgentRole`) | Tasks | Decides | Must not | Hands over to |
|---|---|---|---|---|
| `app-analyst` | full analysis, analysis of changed or missed routes | what each page does, which journeys exist, their criticality, what is unknown | invent behaviour that is not in the code; write tests or scenarios | scenario designer, test author, triager (through `app-model.json`) |
| `design-analyst` | Figma extraction, design change detection, missing reference images | what the design specifies, with observed / inferred / unknown certainty | guess tokens or measurements | scenario designer, triager (through `design-system.json`) |
| `scenario-designer` | scenarios per page, critical-flow scenarios, a scenario drafted from a description | which behaviours are worth a test, their priority and expected results | re-analyze the app; pick critical journeys (they are given); invent copy for features that do not exist | test author (through `scenarios/<page>.json`) |
| `test-author` | a page's spec, the test of one scenario | locators, waits and assertions that implement a scenario | change what a scenario expects; weaken an assertion to make a test pass | runner, triager (through `tests/<page>.spec.ts`) |
| `failure-triager` | one verdict per failed test | product bug, test bug, design mismatch, environment or unknown, with the evidence | edit tests or code; classify without the evidence | defect consolidator, fix planner (through `triage.json`) |
| `defect-consolidator` | grouping verdicts by root cause | which failures are the same defect | change a verdict | report, tracker filing |
| `fix-planner` | bug-fix plan | the order and content of the fixes | re-triage; change code | the developer |

The contracts between agents are the Zod schemas of those files. A field with a default
(`criticality`, `importance`, `routes`, …) is required from the AI but optional when an older
file is read, so existing `.qa` folders keep loading; only `app-model.json` carries a version,
because later stages need its journey ranking.

## AI engine integration details (Claude Code shown; see ai/codex.ts and ai/opencode.ts for the others)

`ClaudeRunner.run(task)` builds this command:

```
claude -p --output-format stream-json --verbose --model <model>
       --json-schema <schema> --tools Read,Glob,Grep
       --allowedTools Read,Glob,Grep,mcp__figma__get_metadata,...
       --permission-mode dontAsk --setting-sources "" --strict-mcp-config
       --mcp-config <tmp mcp.json> --no-session-persistence --max-budget-usd <cap>
       [--append-system-prompt <system>] [--add-dir <dir>]
```

with the prompt on stdin. The stream is parsed line by line: `assistant` events register tool
uses, `user` events carry tool results (text and images), and the final `result` event carries
`structured_output`, cost and turn count. Tool-call records let the engine act on tool results
deterministically — for example, Figma screenshot URLs are taken from the `get_screenshot` result
rather than from the model's answer.

Why the CLI and not the Agent SDK: the SDK requires an API key, whereas the CLI uses whatever
authentication the developer already has (including a Claude subscription). The CLI also ships the
tool sandbox, MCP client, structured-output tool and budget enforcement we need.

## Evidence model

Each test's last attempt yields: `video` (webm), `trace` (zip), `screenshots`, `errorContext`
(accessibility snapshot at failure, from Playwright), `logs` (console/page errors, failed and 4xx/5xx
requests, recorded by the `qaCapture` fixture) and `design` images (expected/actual/diff from
`compareWithDesign`). Helpers also push annotations (`qa-design-tokens`, `qa-visual`, `qa-overflow`)
with the deterministic check results, which the triage prompt receives verbatim.

## Failure classification

Every failed test gets a classification (who must act: app, test, environment, nobody yet) and a
category (what broke): APP_FUNCTIONAL, UI_RENDERING, BACKEND_API, DATA_INTEGRITY, AUTH,
NAVIGATION, STATE_MANAGEMENT, PERFORMANCE_TIMEOUT, TEST_IMPLEMENTATION, ENVIRONMENT_INFRA, FLAKY,
UNKNOWN. The triager's structured `analysis` holds failure point, expected/actual/difference,
timing, root cause (verified facts apart from hypotheses, code locations, missing evidence, next
checks; status verified/hypothesis/unconfirmed) and the fix (target, changes, steps, alternatives,
side effects, acceptance criteria, verification, regression scenarios). `triage/analysis.ts` then
checks it: locations that do not exist are removed and listed, a "verified" cause without a verified
location becomes a hypothesis, a category that contradicts the classification is corrected or the
verdict becomes UNKNOWN, an unconfirmed cause gets the fix target "investigate", fixes that skip,
loosen or time out the test are flagged, unknown regression ids are dropped, and a product bug in a
critical flow is at least high. The scenario's expected results always stay its acceptance criteria.
Executed `test.step`s are recorded per result, so the failed step comes from the run, not the AI.

In the report a scenario is passed, failed, error (its check could not run: environment,
infrastructure or a programming error in the test), blocked (its spec did not load), skipped or
not run (outside the run; listed, not counted). Pass rate = passed / scenarios of the run.
Consolidated issues: the triage's defects (BUG-*), plus test problems failing at the same spec line
(TEST-*), environment failures with the same diagnosis (ENV-*) and unconfirmed failures (INV-*);
every scenario keeps its own report and points at its issue.


```
flaky (passed on retry)          → UNKNOWN (not filed)
connection refused / DNS         → ENVIRONMENT_FAILURE
browser missing / crashed        → INFRASTRUCTURE_FAILURE
exception raised by spec code    → TEST_BUG
anything else                    → AI verdict with confidence + evidence list
```

AI verdicts of `PRODUCT_BUG` / `DESIGN_MISMATCH` must include a bug draft (otherwise they are
downgraded to `UNKNOWN`). Defects are then consolidated by root cause into issues; an issue is
fileable when it reproduced on every attempt and confidence ≥ `ai.minConfidenceToFile`. The issue
fingerprint (hash of its scenario ids) is stored with the ClickUp task id so later runs comment on
the existing task instead of duplicating it.

## Safety boundaries

- AI tasks cannot write files or run commands (no `Edit`, `Write`, `Bash`).
- The engine writes only inside `.qa/` of the target project.
- Test generation is validated but never "fixed" by weakening assertions; failing tests are
  classified, and test bugs are reported for a human (or a scenario edit) to resolve. Patterns
  that hide failures or make tests flaky (fixed waits, forced clicks, skipped tests) are rejected
  by `lintSpec` before a spec is accepted.
- The app under test is started on its own port and stopped after the run; a server that was
  already running is never used as "production" unless the config says it is one.
- Bugs are filed only after triage confirms them, with the confidence threshold and retry
  reproduction as gates.

# Architecture

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

## Pipeline

```
init ──► analyze ──► design ──► scenarios ──► generate ──► test ──► triage ──► file ──► report
 det.      AI         AI+Figma     AI          AI+browser   Playwright  rules+AI  ClickUp   engine
```

| Stage | Module | Input | Output | Cache key |
|---|---|---|---|---|
| init | `discovery/detect.ts`, `init/init.ts` | package.json, file tree | `.qa/config.ts`, `project.json` | — |
| changes | `changes/detect.ts` | project.json routes, per-page file hashes, optional Figma metadata | list of new/changed/removed pages, changed shared files, new/changed Figma frames | — (free; Figma part costs MCP calls) |
| analyze | `analyze/app.ts` | source files, project.json, rules | `app-model.json` (pages, forms, states, rules, test data, per-page and shared-file hashes) | all-source hash for the fast path; otherwise only new/changed pages are re-analyzed and merged |
| design | `design/figma.ts` | Figma MCP (metadata, variables, design context, screenshots) | `design-system.json`, `design/refs/*.png` | figma config + viewports |
| scenarios | `scenarios/generate.ts` | page model, flows, design subset, viewports | `scenarios/<page>.json` | per page: page files hash + model + design |
| generate | `generate/playwright.ts` | approved scenarios, page model, Playwright MCP (to confirm locators on the live app) | `tests/<page>.spec.ts`, validated with `playwright test --list`; up to 3 fix rounds | per spec: scenarios + model |
| test | `runner/*` | specs, generated `playwright.config.ts` | `artifacts/runs/<id>/` evidence + `results.json` | — |
| triage | `triage/*` | outcomes + evidence + scenario + source + design | `triage.json` (per-failure verdicts, consolidated issues) | — |
| file | `bugs/file.ts` | confirmed issues | `filing.json` marking them *pending* — the pipeline never creates tasks | — |
| (dashboard button) | `bugs/file.ts` `fileIssues`, `integrations/clickup.ts` | one issue or one failure, on a person's click | ClickUp task + attachments (or a comment on the task filed earlier), `filing.json`, `state.bugs` | fingerprint of scenario ids, root-cause files |
| ui | `ui/server.ts`, `ui/page.ts` | scenarios, run results, triage, filing | local dashboard (`/api/overview`, `/files/*`, `POST /api/file` to log one issue) | — |
| report | `report/report.ts` | everything above | `reports/<id>/report.md|html`, `bugs/*.md` | — |

## Modules

```
src/
  cli.ts                  commander CLI; maps commands/flags to pipeline stages
  index.ts                public API: defineConfig + types
  config/                 Zod schema (+ defaults) and jiti-based loader for .qa/config.ts
  core/                   paths, logger (console + file), fs/hash helpers, process spawning
  ai/claude.ts            ClaudeRunner: spawns `claude -p --output-format stream-json`, streams
                          the event log to a transcript, captures every tool call/result, validates
                          structured output, tracks cost
  ai/context.ts           shared system prompt, project rules, Figma URL parsing
  discovery/detect.ts     deterministic framework/route/test detection
  analyze/app.ts          AppModel schema; full analysis and per-route incremental analysis + merge
  changes/detect.ts       deterministic code change detection (per-page + shared-file hashes) and
                          opt-in Figma change detection (frame list + page structure hashes)
  ui/server.ts, ui/page.ts local dashboard server (node:http) and its single static page
  design/schema.ts        DesignSystem schema with observed/inferred/unknown certainty
  design/figma.ts         extraction task (read-only Figma tools), reference image download,
                          rate-limit reporting, back-fill of missing references
  scenarios/              Scenario schema, generation per page, page selection helpers
  generate/playwright.ts  test generation + validation loop
  playwright/index.ts     runtime for generated tests (fixtures: qa helpers, log capture)
  playwright/style.ts     pure CSS value comparison
  runner/server.ts        start/wait/stop the app (kills the process tree; loopback diagnostics)
  runner/playwright-config.ts  renders playwright.config.ts (project per browser × viewport)
  runner/results.ts       Playwright JSON report → normalized TestOutcome + evidence copying
  runner/run.ts           executes Playwright with filters (files, tags, scenario ids)
  triage/rules.ts         deterministic classifications
  triage/triage.ts        AI verdict per failure (3 in parallel), consolidation into issues
  bugs/report.ts          bug markdown, environment, evidence selection
  bugs/file.ts            ClickUp filing with dedupe via state fingerprints
  integrations/clickup.ts minimal ClickUp REST v2 client (validated responses)
  report/report.ts        markdown + HTML report
  state/state.ts          .qa/state.json store (stage hashes, runs, filed bugs)
  pipeline/context.ts     loads config/state/runner once per invocation
  pipeline/run.ts         stage orchestration with checkpoints and resume
```

## Claude Code integration details

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
  classified, and test bugs are reported for a human (or a scenario edit) to resolve.
- Bugs are filed only after triage confirms them, with the confidence threshold and retry
  reproduction as gates.

# Bug-fix plan command — design

Date: 2026-09-24 · Status: implemented (revised: works from failed tests, no triage step)

## Goal

After a test run, developers get one readable document that tells them how to fix the bugs behind
the failed tests in their own code: what is wrong, why, what to change, where, in which order,
and how to check the fix. The document lives in the project that uses AI QA Agent, so it can be
reviewed and committed like any other file.

**Reader:** developers fixing bugs by hand (not an AI agent). Plain language first; file and
line references so they know where to look; short code hints only where they help.

## Command

```
ai-qa-agent plan [--run <id>] [--dir <folder>] [--force]
```

- `--run`: the run to plan for. Default: the latest run with `results.json`.
- `--dir`: output folder, relative to the project root. Default: `plans.dir` from
  `.qa/config.ts`, which defaults to `docs/bug-fix-plan`.
- `--force`: overwrite an existing plan for that run.

## Input

The run's `results.json` (failed and flaky tests: error message, first screenshot, project), the
scenarios behind them (page, steps, expected results), and read-only access to the source
directories in `source.include`. Nothing else has to run first; triage is not used.

Refusals (no AI call, non-zero exit, clear message): no run with results; the plan file exists and
`--force` is not given. No failed tests → no AI call, no file; the command says so.

## AI step

One `ctx.ai.run` task (`plan-<run-id>`) on the configured engine, tools `Read`, `Glob`, `Grep`
only. The AI decides, per failure, whether the app is wrong or the test is, groups failures with a
shared cause into one bug, and returns for each bug: title, severity, page, the failure keys it
explains, expected vs actual, root cause, locations, fix, optional code hint, risks, manual
verification, effort (S/M/L) and related bugs; plus a fix order, the failures not included
(TEST_BUG / FLAKY / ENVIRONMENT with a reason) and cross-cutting notes.

Code reconciles the answer: unknown failure keys are dropped, a failure belongs to the first bug
that claims it, bugs explaining no failure of the run are dropped, the order is the AI's for
known bugs, and any failure neither explained nor listed is added to "Not included" as UNKNOWN.

## Output

`<dir>/<run-id>-plan.md`: title and run facts; summary table in fix order (#, bug, severity, page,
effort, files); optional notes; one section per bug (what is wrong, steps to reproduce from the
scenario, root cause, proposed fix + code hint, files, risks, how to verify including
`npx ai-qa-agent test --grep <ID>`, related bugs, screenshot links relative to the plan file);
"Not included" table.

## Dashboard

*Create fix plan* in the toolbar plans the selected run as a background job (`POST /api/plan`,
shared progress banner, one job at a time). Disabled with a tooltip when the run has no failed
tests. When the plan exists the button reads *Update fix plan* and asks before overwriting; *View
plan* (toolbar and the done banner) shows the file's Markdown in the modal (`GET /api/plan`).

## Components

`src/plan/plan.ts` (`collectFailures`, `PlanSchema`, `reconcilePlan`, `renderPlan`,
`planStatus`, `writeBugFixPlan`), `plans.dir` in `src/config/schema.ts`, the `plan` command in
`src/cli.ts`, the overview `plan` field and `/api/plan` in `src/ui/server.ts`, the buttons in
`src/ui/page.ts`. Tests in `test/plan.test.ts` with a fake AI.

## Out of scope

Per-bug plan files, applying fixes automatically, and using triage results as input.

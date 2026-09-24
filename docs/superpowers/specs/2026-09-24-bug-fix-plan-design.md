# Bug-fix plan command — design

Date: 2026-09-24 · Status: approved in conversation, awaiting spec review

## Goal

After a test run has been triaged, developers get one readable document that tells them how to
fix the confirmed bugs in their own code: what is wrong, why, what to change, where, in which
order, and how to check the fix. The document lives in the project that uses AI QA Agent, next
to its other docs, so it can be reviewed and committed like any other file.

**Reader:** developers fixing bugs by hand (not an AI agent). Plain language first; file and
line references so they know where to look; short code hints only where they help.

## Command

```
ai-qa-agent plan [--run <id>] [--dir <folder>] [--force]
```

- `--run`: the run to plan for. Default: the latest run with `results.json` (same rule as
  `triage` and `report`).
- `--dir`: output folder, relative to the project root. Default: `plans.dir` from
  `.qa/config.ts`, which defaults to `docs/bug-fix-plans`.
- `--force`: overwrite an existing plan for that run.

Config (optional, new section):

```ts
plans: { dir: 'docs/bug-fix-plans' }
```

## Input

The run's `triage.json` (`TriageResult`) and `results.json` (`TestRunResult`), the scenarios,
and read-only access to the source directories in `source.include`.

- **Included:** issues with `fileable: true` (confirmed `PRODUCT_BUG` / `DESIGN_MISMATCH` above
  the confidence threshold) whose failing tests still fail in the run. An issue whose failures
  were all run again on their own (`rerunAt`) and now pass is not included.
- **Not included** (listed at the end with the reason): non-fileable issues
  (`notFiledReason`), failures classified as `TEST_BUG`, `ENVIRONMENT_FAILURE`,
  `INFRASTRUCTURE_FAILURE` or `UNKNOWN` (their classification and summary), failed or flaky tests
  with no analysis ("not analyzed"), and issues that pass after a re-run.

Refusals (no AI call, non-zero exit, clear message):

- No run with results → "Run `ai-qa-agent test` first."
- The run has no `triage.json` → "Run `ai-qa-agent triage` first." The command never triages
  on its own, so it never spends AI on analysis implicitly.
- The plan file exists and `--force` is not given → names the file and the flag.

No confirmed bugs → no AI call, no file; prints "No confirmed bugs in run <id>; nothing to plan"
plus the not-included count.

## AI step

One `ctx.ai.run` task (`plan-<run-id>`) on the configured engine, tools `Read`, `Glob`, `Grep`
only — it reads code, never edits it. The prompt contains every included issue (bug draft,
scenario steps and expected results, test error message, triage reasoning and suspected root
cause) and the project rules. One task sees all bugs, so it can group bugs with a shared cause.

Structured output (zod):

```ts
{
  order: string[];              // issue ids, the suggested fix order
  bugs: Array<{
    issueId: string;
    rootCause: string;          // plain words
    locations: string[];        // "src/cart.ts:42" style
    fix: string;                // plain words
    codeHint: string | null;    // short snippet, optional
    risks: string;              // side effects to watch
    verify: string[];           // manual checks
    effort: 'S' | 'M' | 'L';
    relatedIssueIds: string[];  // share a cause or should be fixed together
  }>;
  notes: string[];              // cross-cutting remarks, may be empty
}
```

Code validates the answer: every included issue appears exactly once in `bugs` and in `order`;
unknown ids are dropped; missing ones are appended to the order and rendered with triage data
only and a "no fix plan from the AI" note. The AI is not asked again for these cases.

## Output

`<dir>/<run-id>.md` (e.g. `docs/bug-fix-plans/2026-09-24_15-24-46.md`), rendered by code:

1. Title, run id, date, app URL, number of bugs planned and not included.
2. Summary table in fix order: #, bug title, severity, page, effort, files.
3. Optional "Notes" from the AI.
4. One section per bug in fix order: what is wrong; steps to reproduce; expected vs actual;
   root cause; proposed fix (+ code hint); files to change; risks; how to verify (manual steps and
   `npx ai-qa-agent test --grep <SCENARIO-ID>`); related bugs; evidence links (screenshots,
   relative to the plan file).
5. "Not included": id / test, classification, reason.

The command prints the file path, bug count and AI cost.

## Dashboard

A *Create fix plan* button in the toolbar plans the selected run, with the same rules as the
command (default folder, no implicit triage).

- Disabled, with the reason as its tooltip, when the run has no `triage.json` ("Run
  `ai-qa-agent triage` first") or no confirmed bugs ("No confirmed bugs to plan").
- When `<dir>/<run-id>.md` exists the button reads *Update fix plan* and asks for confirmation
  before overwriting (the same as `--force`), because the team may have edited the file.
- It runs as a background job (`kind: 'plan'`, POST `/api/plan` with `{ runId }`), sharing the
  progress banner and the one-job-at-a-time rule of the run buttons. When done, the banner shows
  the file path and a *View plan* button that shows the Markdown in the modal (GET
  `/api/plan?run=<id>`, which returns only that plan file's text).
- The overview gains `plan: { exists, file, confirmedBugs, triaged }` for the selected run.

## Components

- `src/plan/plan.ts`: `collectPlanInput(ctx, run, triage)` (what is included / not included,
  pure), `buildPlanPrompt`, `PlanSchema`, `reconcilePlan` (validation above, pure),
  `renderPlan` (Markdown, pure), `writeBugFixPlan(ctx, opts)` (orchestration, file write).
- `src/config/schema.ts`: `plans.dir` with default.
- `src/cli.ts`: the `plan` command.
- `src/ui/server.ts`, `src/ui/page.ts`: the overview `plan` field, `/api/plan`, the button.
- README: command table row and a short "Bug-fix plans" section.

## Testing

Unit tests with a fake AI engine and a temp project:

- inclusion rules (fileable, non-fileable, test bug, not analyzed, passed on re-run);
- refusals: no triage, existing file without `--force`, no confirmed bugs (no AI call);
- reconciliation: unknown ids dropped, missing issues appended with the fallback note;
- rendering: order, summary table, relative evidence links, not-included list;
- output folder: config default, `plans.dir`, `--dir`.

Then one real run of `ai-qa-agent plan` on the demo-shop copy.

## Out of scope

Per-bug plan files, applying fixes automatically, and triaging implicitly.

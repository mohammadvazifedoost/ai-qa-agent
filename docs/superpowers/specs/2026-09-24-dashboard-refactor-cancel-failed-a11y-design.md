# Dashboard refactor, cancel, run failed tests, accessibility checks — design

Date: 2026-09-24 · Status: decisions made in conversation, awaiting spec review

Four changes, built in this order because the later ones touch the dashboard.

## 1. Split the dashboard page into real TypeScript files

**Why:** `src/ui/page.ts` is ~650 lines of HTML and browser JavaScript inside one `String.raw`
template. It cannot be type-checked, linted or unit-tested, and quoting inside the strings broke
several edits. No behaviour or visual change is intended.

**Build (decided: TypeScript only, no new dependencies):**

- `src/ui/client/*.ts`: the browser code as ES modules, compiled by `tsc` with a separate
  `tsconfig.client.json` (`lib: ["ES2023", "DOM"]`, `module: ESNext`, output `dist/ui/client/`).
  Imports use `.js` specifiers so the browser loads them directly.
- `src/ui/index.html`: the page shell (the static markup now at the top of `page.ts`), copied to
  `dist/ui/index.html` at build time. `<script type="module" src="/client/main.js">`.
- The server serves `/` (index.html) and `/client/*.js` from `dist/ui` with a path guard
  (only files inside `dist/ui/client`, only `.js`). `page.ts` and `PAGE_HTML` are removed.
- Tailwind keeps scanning the markup: `@source` points at `src/ui/index.html` and
  `src/ui/client/**/*.ts`.
- `npm run build` runs both tsc configs, copies the HTML and builds the CSS; `npm run typecheck`
  and `npm run lint` cover the client code too.

**Modules (one clear job each):** `api.ts` (typed fetch helpers for every endpoint, sharing the
server's `Overview` type via `import type`), `state.ts` (the loaded data and view filters),
`dom.ts` (`$`, `esc`, toast), `render.ts` (list, rail, verdict), `modal.ts` (scenario detail,
delete), `editor.ts` (add/edit form, AI draft), `jobs.ts` (toolbar, job banner, polling, plan
buttons), `drawer.ts` (mobile side drawer), `main.ts` (wiring). Inline `onclick="…"` handlers are
replaced by event delegation on `data-action` attributes, which removes the quoting problem.

**Tests:** unit tests (vitest, jsdom not needed) for the pure pieces: `esc`, the list filter,
status/grouping helpers, the not-run and needs-test counts. Then the full dashboard is clicked
through in a real browser at desktop and 390px widths, comparing with the current behaviour.

## 2. Run failed tests (decided: update the current run)

A *Run failed tests (N)* button in the toolbar re-runs only the failed and flaky tests of the
selected run and merges their results into it, exactly like *Run not-run tests*
(`runScenarioTests`, evidence under `<run>/reruns/`, outcomes marked `rerunAt`). Shown when N > 0.
Endpoint: `POST /api/runs/failed { runId }`, job kind `run-failed`.

## 3. Cancel a running job (decided: discard partial results)

- `run()` in `src/core/process.ts` accepts an `AbortSignal`. On abort it kills the whole process
  tree (Windows: `taskkill /pid <pid> /T /F`; elsewhere the child is spawned detached and its
  process group is killed) and rejects with a `Cancelled` error.
- The signal is threaded through `runTests`, `runScenarioTests`, `writeBugFixPlan` and the AI
  engines (`AiTask.signal`, passed to `run()` by the Claude Code, Codex and OpenCode engines).
- Each job gets an `AbortController`. `POST /api/job/cancel` aborts the running job; the job ends
  with status `cancelled`. Nothing is merged or written: a cancelled *Run all tests* run is
  recorded with status `failed` and error "Cancelled", merges are skipped, no plan file is
  written. The app server started for the run is stopped as usual (existing `finally`).
- The progress banner gets a *Cancel* button; after cancelling it shows "Cancelled" with Dismiss.

**Tests:** `run()` kills a long-running child on abort; `runScenarioTests` with an aborting runner
leaves results.json untouched; `writeBugFixPlan` with an aborted AI call writes no file.

## 4. Accessibility checks (decided: fail on serious and critical)

- New scenario category `accessibility` (added to `CATEGORIES`, the scenario generator prompt,
  the add/edit form, the type chip colours, and the "By test type" bars).
- New helper `qa.expectAccessible(options?)` in `@mohammadvazifedoost/ai-qa-agent/playwright`: runs
  `axe-core` in the page with the WCAG 2.0/2.1 A and AA rule tags, fails the test when there are
  `serious` or `critical` violations, and attaches every violation (all impacts) as a JSON
  attachment and a readable test annotation (rule, impact, help text, target selectors). Options:
  `include` (a locator to scope the check) and `disableRules`.
- Dependency: `axe-core` (MPL-2.0) as a runtime dependency of the package, injected with
  `page.addScriptTag({ content })` from `require.resolve('axe-core/axe.min.js')`. Installed from
  the public npm registry because this machine's mirror rejects some packages.
- The generator prompt tells the AI to use `qa.expectAccessible()` for accessibility scenarios
  after reaching the state to check (e.g. an open dialog, a form showing errors).
- Triage and the fix plan already have an `accessibility` bug category; scenario-to-bug mapping
  (`adhocIssue`) passes it through.

**Tests:** the helper against a local HTML page with a known serious violation (image without
alt) and a clean page; the schema accepts the new category; the rendering maps its chip.

## Out of scope

Keyboard-navigation or screen-reader flows beyond what axe checks, per-rule configuration in
`.qa/config.ts`, cancelling single-test actions (Run test, Create test), and a bundler.

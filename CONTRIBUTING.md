# Contributing

## Setup

```bash
npm install                     # engine dependencies
npm run check                   # typecheck + lint + unit tests + build
```

Requirements: Node ≥ 22.12, Claude Code installed and authenticated, Playwright chromium
(`npx playwright install chromium`).

If a private npm mirror is configured globally and rejects packages, install with
`npm_config_registry=https://registry.npmjs.org/ npm install`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run build` | Compile `src/` to `dist/` (the CLI is `dist/cli.js`) |
| `npm run typecheck` | `tsc --noEmit` over src and tests |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm test` | Vitest unit tests in `test/` |
| `npm run check` | All of the above |

## Project layout

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map. Rules of thumb:

- Anything the AI returns is described by a Zod schema next to the code that uses it. Keep
  `.describe()` texts precise: they are the instructions the model sees.
- Deterministic logic (parsing, comparison, classification rules, report rendering) must have
  unit tests. AI prompts are validated end to end against the fixture, not unit-tested.
- The engine never edits a target project's application code, and AI tasks never get write tools.
- Log with `logger('<scope>')`; never swallow errors — wrap them with context and rethrow.

## Validating against the fixture

`fixtures/demo-shop` is a small Vite + React app with planted defects, documented in
`fixtures/README.md` (kept outside the app so the agent cannot read the answers). The fixture is
linked to the engine via `"@company/ai-qa": "file:../.."`.

```bash
npm run build
cd fixtures/demo-shop && npm install
npx ai-qa doctor
npx ai-qa run --no-file          # full pipeline; ~5 min and ~$1.50 of AI usage on Sonnet
cat .qa/reports/latest.md
```

Expected outcome: the three planted defects appear as distinct issues (coupon total not
discounted → `PRODUCT_BUG`; header not collapsing at 390px → `PRODUCT_BUG`/responsive;
primary button color/radius → `DESIGN_MISMATCH`), each pointing at the right file and line.
Additional real defects in the fixture may be reported (e.g. the inert "Place order" button); a
finding that does not correspond to actual behaviour is a regression in prompts or triage.

The fixture's Figma file is `https://www.figma.com/design/RPpqNkGynHaWPphAXkpFFH` (built with the
Figma MCP `use_figma` tool: variables, text styles, a Button component set and four screens). Its
design values intentionally differ from the app's CSS where `fixtures/README.md` says so.

Note the Figma MCP quota: Starter plans allow 20 read calls per month, so run `ai-qa analyze` on the
fixture sparingly; extracted results are cached in `.qa/design-system.json`.

### Validating feature-scoped runs

The fixture's `/contact` page was added after the first analysis specifically to exercise this
path. To replay it: check out the commit before the page existed, run `ai-qa analyze`, check out
HEAD again, then `npx ai-qa changes` must report `new page /contact` plus the changed shared files
(`src/main.tsx`, `src/components/Layout.tsx`, …) and nothing else; `npx ai-qa run --changed` must
analyze, generate and execute tests for `/contact` only.

### Dashboard

`npx ai-qa ui` in the fixture (with `CLICKUP_API_TOKEN` exported if you want to try the
*Log bug in ClickUp* button) serves the dashboard on http://127.0.0.1:4310. The page is a single
static HTML string in `src/ui/page.ts`; the JSON it consumes comes from `buildOverview()` in
`src/ui/server.ts`.

## Testing the ClickUp integration

Unit tests cover the client with a fake `fetch`. To verify against a real workspace:

```bash
export CLICKUP_API_TOKEN=pk_...
npx ai-qa init --force --clickup-list <listId> ...   # or add the clickup section by hand
npx ai-qa doctor                                    # validates the token and prints the list name
npx ai-qa run                                       # files confirmed defects
```

## Commit conventions

Small, focused commits with conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
Run `npm run check` before committing.

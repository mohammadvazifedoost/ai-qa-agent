# Contributing to AI QA Agent

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
| `npm run build` | Compile `src/` to `dist/` (the CLI is `dist/cli.js`) and the dashboard CSS (`dist/ui/styles.css`, Tailwind v4) |
| `npm run build:css` | Only the dashboard CSS — use while editing `src/ui/index.html`, `src/ui/client/*` or `src/ui/tailwind.css` |
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
linked to the engine via `"@mohammadvazifedoost/ai-qa-agent": "file:../.."`.

```bash
npm run build
cd fixtures/demo-shop && npm install
npx ai-qa-agent doctor
npx ai-qa-agent run --no-file          # full pipeline; ~5 min and ~$1.50 of AI usage on Sonnet
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

Note the Figma MCP quota: Starter plans allow 20 read calls per month, so run `ai-qa-agent analyze` on the
fixture sparingly; extracted results are cached in `.qa/design-system.json`.

### Validating feature-scoped runs

The fixture's `/contact` page was added after the first analysis specifically to exercise this
path. To replay it: check out the commit before the page existed, run `ai-qa-agent analyze`, check out
HEAD again, then `npx ai-qa-agent changes` must report `new page /contact` plus the changed shared files
(`src/main.tsx`, `src/components/Layout.tsx`, …) and nothing else; `npx ai-qa-agent run --changed` must
analyze, generate and execute tests for `/contact` only.

### Dashboard

`npx ai-qa-agent ui` in the fixture (connect a tracker on its *Bug tracker* page, or export
`CLICKUP_API_TOKEN`, if you want to try filing bugs) serves the dashboard on http://127.0.0.1:4310. The page is one static
file, `src/ui/index.html`, plus browser modules in `src/ui/client/` (plain TypeScript, no
framework; they may import only types from the rest of `src/`). The JSON they consume comes from
`buildOverview()` in `src/ui/server.ts`. Run `npm run build` after a change and reload the page.

- `logic.ts` holds everything that can be decided without the DOM (filters, counts, routes, the
  list of defects) and is covered by `test/ui-logic.test.ts`; put new rules there.
- `shell.ts` draws the menu and the top bar; `overview.ts`, `scenarios.ts`, `defects.ts` and
  `project.ts` draw the pages; `ui.ts` has the pieces they share. HTML is built as strings and every value
  from the project goes through `esc()`.
- Buttons carry `data-action` and are handled in one place, `main.ts`; there are no inline
  handlers. The current view is the URL hash (`#/scenarios/<id>`), parsed by `parseRoute()`.
- The menu is dark in both themes: the `.rail` class in `tailwind.css` gives the tokens their own
  values inside it, so the same token classes work there. Icons are inline stroke SVGs (`ICON` in
  `shell.ts`) in `currentColor`; a button that shows only an icon gets `btn-icon`, an `aria-label`
  and a `title`.
- Colours are tokens in `tailwind.css` with a light and a dark value each. Use the token classes
  (`bg-surface`, `text-ink`, `text-fail-ink`, …) rather than fixed colours, and check both themes.

## Testing the ClickUp integration

Unit tests cover the client with a fake `fetch`. To verify against a real workspace:

```bash
export CLICKUP_API_TOKEN=pk_...
npx ai-qa-agent init --force --clickup-list <listId> ...   # or add the clickup section by hand
npx ai-qa-agent doctor                                    # validates the token and prints the list name
npx ai-qa-agent run                                       # files confirmed defects
```

## Commit conventions

Small, focused commits with conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
Run `npm run check` before committing.

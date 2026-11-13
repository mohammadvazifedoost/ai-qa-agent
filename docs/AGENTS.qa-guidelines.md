<!--
  Copy-paste rules for apps tested by AI QA Agent (https://github.com/mohammadvazifedoost/ai-qa-agent).
  Paste everything below this comment into your app's AGENTS.md (or CLAUDE.md, .cursor/rules, ...).
  Background and examples: the "Writing apps the agent tests well" section of the README.
-->

## UI code rules for automated QA

This app is tested by an AI QA agent that reads the source and drives the UI with Playwright
through accessible roles and names (`getByRole`, `getByLabel`, `getByText`), and through
`data-testid` only where those are not enough. Follow these rules in every UI change.

### Semantics and names

- MUST use native elements for their purpose: `<button>` for actions, `<a href>` for navigation,
  `<form>` with a submit button for forms, `<label>` for inputs, `<ul>`/`<ol>`/`<table>` for lists
  and tables. MUST NOT attach click handlers to `<div>` or `<span>`.
- MUST give each page exactly one `<h1>` and keep heading levels in order. MUST use landmarks
  (`<header>`, `<nav>`, `<main>`, `<footer>`) and name repeated ones (`<nav aria-label="Main">`).
- MUST give every interactive element an accessible name that is unique on the page and says what
  it does: `Remove Ceramic Mug`, not several `Remove` buttons.
- SHOULD use visible text as the name. MUST use `aria-label` or `aria-labelledby` only when there is
  no visible text (icon buttons, unlabeled regions), and mark decorative icons `aria-hidden="true"`.
- MUST associate every input with a `<label htmlFor>` (or a wrapping `<label>`). Placeholders MUST
  NOT be the only label.
- MUST expose state on toggles and disclosures: `aria-expanded`, `aria-pressed`, `aria-selected`,
  `aria-current="page"` for the active nav link.

### Forms and feedback

- MUST link each field's error message with `aria-describedby="<field-id>-error"` and set
  `aria-invalid="true"` while the field is invalid.
- MUST render form-level errors with `role="alert"` and success confirmations with `role="status"`.
- MUST keep validation and status messages as literal strings in the source (inline or in one
  messages file), not assembled from fragments.
- MUST make loading visible: set `aria-busy="true"` on the region or button that is waiting, and show
  text such as `Saving…`. MUST render a distinct empty state and error state with visible text.

### Ids and test ids

- SHOULD NOT add `data-testid` when a role and accessible name identify the element. MUST add one
  for elements that have no role or name of their own (a value in a `<dd>`, a chart, a canvas, a
  badge count).
- MUST use the attribute `data-testid` (Playwright's default) and no other test attribute.
- MUST name `data-testid` and `id` values in kebab-case as `<page>-<component>-<element>`, for
  example `checkout-summary-total`, `login-email`, `login-email-error`. MAY omit `<component>` when
  the page has only one.
- MUST keep ids and test ids stable across renders and builds. MUST NOT derive them from `useId()`,
  random values, CSS-module hashes or array indexes.
- MUST give repeated items the item's domain key, for example
  ``data-testid={`checkout-line-${line.sku}`}``, and use the same key as the framework's list `key`.
- MUST keep ids unique within a page. MUST NOT reuse an id or test id for a different element.
- MUST NOT use generated or utility class names as the only way to identify an element.

### Routes, data and determinism

- MUST declare routes as string literals (file-based routes, `<Route path="/x">` or `path: '/x'`).
  MUST NOT build route paths at runtime from variables.
- MUST make every page reachable through visible links or buttons, not only by typing a URL.
- MUST keep test data seedable: a seed script or fixtures, a test account, and sandboxed payment
  and email providers. SHOULD document them in `.qa/rules.md`.
- MUST read the current time and random values through one module that tests can control. MUST NOT
  show A/B variants or rotating content in the test environment.
- MUST respect `prefers-reduced-motion: reduce` by disabling or shortening animations and
  transitions.
- MUST keep the console free of errors and avoid failing (4xx/5xx) requests during normal use.
- MUST start the app with one command on a fixed host and port, configured through environment
  variables.

### Accessibility (checked with axe-core, WCAG 2.1 A/AA)

- MUST give images an `alt` text (empty `alt=""` for decorative images).
- MUST meet WCAG AA color contrast.
- MUST make everything operable with the keyboard, with a visible focus indicator and a logical tab
  order.
- MUST implement dialogs with `<dialog>` or `role="dialog"` plus `aria-modal="true"` and a name,
  move focus into them on open and return it on close.
- SHOULD define design tokens as CSS custom properties with the values from the design.

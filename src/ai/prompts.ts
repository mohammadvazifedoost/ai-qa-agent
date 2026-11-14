/**
 * Prompt fragments shared by several agents. One wording per rule: the scenario designer, the
 * critical-flow selection and the scenario draft all state expectations the same way, and both
 * test-writing prompts follow the same test rules.
 */

/** How a scenario's expected results are derived. Used wherever scenarios are written. */
export const EXPECTATION_RULES = `- Expected results describe the INTENDED behaviour, so that a test can catch a defect. Derive them, in this order, from: the UI copy and labels, the design, what the rest of the code clearly intends (e.g. a discount is displayed, so the total must be reduced by it), then a product convention you can name.
- When the code implements the behaviour, use its exact visible texts and values (messages, headings, amounts worked out from the test data).
- When the application model marks the behaviour as suspicious or broken, state the correct result with the correct value and add "(code currently does X — file:line)" so the reader knows the test is expected to fail.
- When the behaviour is NOT IMPLEMENTED (e.g. a button with no handler), do not invent its texts, routes or screens. Describe an outcome that can be checked without guessing copy (e.g. "a visible confirmation appears and the cart is emptied") and say in "rationale" that it is not implemented, with the file.
- Never write an expected result that only restates what the code does when the model flags that code as wrong, and never write one you cannot trace to a source named above.`;

/** How steps are written so that a test author can implement them without guessing. */
export const STEP_RULES = `- Steps are single user actions in order, naming the control by its role and exact accessible name from the page model (e.g. "Click the button 'Add Ceramic Mug to cart'"), with the exact value to type.
- Preconditions and steps must build all the state the scenario needs through the UI, starting from a fresh browser with no session (e.g. add a product on / before opening the cart). A scenario never depends on another scenario having run.
- Use test data from the application model. Do not invent credentials, codes or records.
- "routes" lists every route the scenario visits, in order, starting with its page.`;

/** One prioritization scale for every scenario, so priorities are comparable across pages. */
export const PRIORITY_RUBRIC = `Rate each candidate on: business importance, user impact, how often it is used, what breaks for the user if it fails, and how likely a code change is to break it.
- high: part of a critical or core journey, or a rule about money, data or access. If it fails, users cannot complete a main task or get a wrong result.
- medium: an important function with a workaround, or an error/validation path of a core function.
- low: rarely used or cosmetic behaviour whose failure does not stop any task.`;

/** What is not worth a scenario. */
export const LOW_VALUE_RULES = `Do not return a scenario that:
- only checks that static elements exist or are visible, without an action and an outcome;
- verifies the same behaviour as another scenario with different data (merge them into one, or keep the more valuable one);
- covers an insignificant UI detail whose failure no user would notice or report;
- tests behaviour you cannot point to in the page model, the source or the design.`;

import { z } from 'zod';

export const CATEGORIES = ['functional', 'visual', 'responsive'] as const;
export type Category = (typeof CATEGORIES)[number];

export const ScenarioSchema = z.object({
  id: z.string().regex(/^[A-Z0-9]+-\d{3}$/, 'format PAGE-001'),
  page: z.string().startsWith('/'),
  feature: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .describe('kebab-case feature key, e.g. checkout, auth, navigation'),
  category: z.enum(CATEGORIES),
  priority: z.enum(['high', 'medium', 'low']),
  title: z.string(),
  preconditions: z.array(z.string()),
  steps: z.array(z.string()).min(1),
  expectedResults: z.array(z.string()).min(1),
  viewport: z.string().describe('Name of a configured viewport'),
  source: z.object({ figma: z.boolean(), code: z.boolean() }),
  testData: z.array(z.string()),
  /** For visual/design checks: which Figma screen and which exact token values to assert. */
  design: z
    .object({
      screen: z.string().nullable().describe('Figma screen name with a reference image, or null'),
      tokens: z.array(
        z.object({
          element: z
            .string()
            .describe('How a user identifies the element, e.g. "the \'Add to cart\' button"'),
          properties: z.record(z.string(), z.string()).describe('CSS property → expected value from Figma'),
        }),
      ),
    })
    .nullable(),
  rationale: z.string().describe('Why this scenario matters / what risk it covers'),
  approved: z.boolean(),
  /** Who wrote it. Missing means the AI; `person` scenarios are never rewritten or dropped by regeneration. */
  origin: z.enum(['ai', 'person']).optional(),
  /** When a person last added or edited it (ISO timestamp). */
  editedAt: z.string().optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** What the AI returns: it cannot claim a scenario was written by a person. */
export const AiScenarioSchema = ScenarioSchema.omit({ origin: true, editedAt: true });

export const isPersonScenario = (s: Pick<Scenario, 'origin'>): boolean => s.origin === 'person';

/** A scenario a person deleted. Kept so regeneration does not bring it back, and for `restore`. */
export const RemovedScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  reason: z.string().optional(),
  removedAt: z.string(),
  scenario: ScenarioSchema,
});
export type RemovedScenario = z.infer<typeof RemovedScenarioSchema>;

export const ScenarioFileSchema = z.object({
  page: z.string(),
  generatedAt: z.string(),
  /** Hash of everything the scenarios were derived from; a change marks them outdated. */
  inputHash: z.string(),
  scenarios: z.array(ScenarioSchema),
  removed: z.array(RemovedScenarioSchema).default([]),
});
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

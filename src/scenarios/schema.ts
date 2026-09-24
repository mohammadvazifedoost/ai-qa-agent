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
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const ScenarioFileSchema = z.object({
  page: z.string(),
  generatedAt: z.string(),
  /** Hash of everything the scenarios were derived from; a change marks them outdated. */
  inputHash: z.string(),
  scenarios: z.array(ScenarioSchema),
});
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

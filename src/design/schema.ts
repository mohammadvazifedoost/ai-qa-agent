import { z } from 'zod';

/**
 * How we know a fact about the design:
 * - observed: read directly from Figma data (variables, styles, node properties)
 * - inferred: derived from observed data (e.g. a breakpoint inferred from frame widths)
 * - unknown: could not be determined; never filled in with a guess
 */
export const Certainty = z.enum(['observed', 'inferred', 'unknown']);

const Evidence = z
  .string()
  .describe('Where this came from, e.g. "variable color/primary" or "node 12:34 fill"');

export const TokenSchema = z.object({
  name: z.string(),
  value: z.string().describe('CSS-ready value, e.g. "#2563EB", "8px", "700"'),
  certainty: Certainty,
  evidence: Evidence,
});

export const TypographySchema = z.object({
  name: z.string(),
  fontFamily: z.string(),
  fontWeight: z.number(),
  fontSize: z.string(),
  lineHeight: z.string(),
  letterSpacing: z.string().optional(),
  certainty: Certainty,
  evidence: Evidence,
});

export const ComponentSchema = z.object({
  name: z.string(),
  nodeId: z.string(),
  description: z.string().optional(),
  variants: z.array(z.string()),
  /** Measured visual properties per variant, in CSS terms (backgroundColor, borderRadius, height, color, ...). */
  specs: z.array(
    z.object({
      variant: z.string(),
      properties: z.record(z.string(), z.string()),
      certainty: Certainty,
    }),
  ),
});

export const ScreenSchema = z.object({
  name: z.string(),
  nodeId: z.string(),
  width: z.number(),
  height: z.number(),
  route: z.string().nullable().describe('App route this screen represents, if it can be determined'),
  routeCertainty: Certainty,
  viewport: z.string().describe('Viewport name, e.g. desktop | tablet | mobile'),
  keyElements: z
    .array(z.string())
    .describe('Notable visible elements, e.g. "hamburger menu button in header"'),
});

export const DesignSystemSchema = z.object({
  source: z.object({ fileKey: z.string(), fileUrl: z.string() }),
  colors: z.array(TokenSchema),
  typography: z.array(TypographySchema),
  spacing: z.array(TokenSchema),
  radius: z.array(TokenSchema),
  shadows: z.array(TokenSchema),
  breakpoints: z.array(TokenSchema),
  components: z.array(ComponentSchema),
  screens: z.array(ScreenSchema),
  layoutRules: z.array(z.object({ rule: z.string(), certainty: Certainty, evidence: Evidence })),
  unknowns: z.array(z.string()).describe('Things that could not be determined from the Figma file'),
});
export type DesignSystem = z.infer<typeof DesignSystemSchema>;

/** What the engine persists: the AI output plus the locally saved reference images. */
export const DesignSystemFileSchema = DesignSystemSchema.extend({
  extractedAt: z.string(),
  /** Hash of each Figma page's metadata XML at extraction time; used by `ai-qa changes --design`. */
  figmaPageHashes: z.record(z.string(), z.string()).optional(),
  references: z.array(
    z.object({
      screen: z.string(),
      nodeId: z.string(),
      file: z.string().describe('Path relative to .qa/'),
      width: z.number(),
      height: z.number(),
    }),
  ),
});
export type DesignSystemFile = z.infer<typeof DesignSystemFileSchema>;

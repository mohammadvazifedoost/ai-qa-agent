import { z } from 'zod';

export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  isMobile: z.boolean().optional(),
  hasTouch: z.boolean().optional(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

/** MCP server definitions, in the same shape Claude Code's `--mcp-config` accepts. */
export const McpServerSchema = z.union([
  z.object({
    type: z.literal('stdio').optional(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.enum(['http', 'sse']),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);
export type McpServer = z.infer<typeof McpServerSchema>;

export const FigmaFrameSchema = z.object({
  /** Human-readable name, used for reference image file names. */
  name: z.string().regex(/^[a-z0-9-]+$/, 'use kebab-case'),
  /** Figma node id, e.g. "12:34". */
  nodeId: z.string().regex(/^\d+[:-]\d+$/),
  /** App route this frame represents, e.g. "/checkout". */
  route: z.string().startsWith('/'),
  /** Viewport name from `viewports` this frame was designed for. */
  viewport: z.string(),
});
export type FigmaFrame = z.infer<typeof FigmaFrameSchema>;

export const QaConfigSchema = z
  .object({
    project: z.object({
      name: z.string(),
      framework: z.string().optional(),
      packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).default('npm'),
    }),
    app: z.object({
      baseUrl: z.string().url(),
      /** Command that starts the app. Omit if the app is already running at baseUrl. */
      startCommand: z.string().optional(),
      startTimeoutMs: z.number().int().positive().default(120_000),
      reuseExistingServer: z.boolean().default(true),
      env: z.record(z.string(), z.string()).optional(),
    }),
    source: z.object({
      /** Directories (relative to project root) the AI may read to understand the app. */
      include: z.array(z.string()).min(1),
      exclude: z.array(z.string()).default(['node_modules', 'dist', 'build', '.next', '.nuxt', 'coverage']),
    }),
    figma: z
      .object({
        fileUrl: z.string().url(),
        frames: z.array(FigmaFrameSchema).default([]),
      })
      .optional(),
    clickup: z
      .object({
        listId: z.string(),
        /** Name of the environment variable that holds the ClickUp personal API token. */
        tokenEnv: z.string().default('CLICKUP_API_TOKEN'),
        tags: z.array(z.string()).default(['ai-qa-agent']),
        /** Status new tasks are created in, e.g. "to do". Omit to use the list's default status. */
        status: z.string().optional(),
        attachEvidence: z.boolean().default(true),
      })
      .optional(),
    jira: z
      .object({
        /** Jira Cloud site, e.g. https://yourco.atlassian.net */
        baseUrl: z.string().url(),
        /** Project key where bugs are created, e.g. "SHOP". */
        projectKey: z.string().regex(/^[A-Z][A-Z0-9_]+$/, 'Jira project keys are uppercase, e.g. SHOP'),
        issueType: z.string().default('Bug'),
        /** Atlassian account email. Or leave it out and set the variable named in `emailEnv`. */
        email: z.string().email().optional(),
        emailEnv: z.string().default('JIRA_EMAIL'),
        /** Name of the environment variable that holds the Atlassian API token (never commit it). */
        tokenEnv: z.string().default('JIRA_API_TOKEN'),
        labels: z.array(z.string()).default(['ai-qa-agent']),
        /** Jira priority name per severity. Dropped automatically if the project rejects priorities. */
        priorities: z
          .object({ critical: z.string(), high: z.string(), medium: z.string(), low: z.string() })
          .default({ critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' }),
        attachEvidence: z.boolean().default(true),
      })
      .optional(),
    /** Which bug tracker to use when both `clickup` and `jira` are configured. */
    tracker: z.enum(['clickup', 'jira']).optional(),
    browsers: z
      .array(z.enum(['chromium', 'firefox', 'webkit']))
      .min(1)
      .default(['chromium']),
    viewports: z.record(z.string(), ViewportSchema).default({
      desktop: { width: 1440, height: 900 },
      tablet: { width: 834, height: 1112, hasTouch: true },
      mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
    }),
    tests: z
      .object({
        timeoutMs: z.number().int().positive().default(30_000),
        workers: z.number().int().positive().default(2),
        /** Re-run each failing test this many times to separate flaky failures from real ones. */
        verifyRetries: z.number().int().min(0).max(3).default(1),
      })
      .default({ timeoutMs: 30_000, workers: 2, verifyRetries: 1 }),
    scenarios: z
      .object({
        /** Cap on scenarios generated per page. Omit for no limit: the AI covers what the page needs. */
        maxPerPage: z.number().int().positive().optional(),
        /** Cap on critical flows (`scenarios --critical`). Omit for no limit: one per critical journey. */
        maxCritical: z.number().int().positive().optional(),
      })
      .default({}),
    visual: z
      .object({
        /** Per-pixel colour distance threshold passed to pixelmatch (0..1). */
        pixelThreshold: z.number().min(0).max(1).default(0.1),
        /** Diff ratio at or below which differences count as acceptable rendering noise. */
        acceptableDiffRatio: z.number().min(0).max(1).default(0.02),
      })
      .default({ pixelThreshold: 0.1, acceptableDiffRatio: 0.02 }),
    plans: z
      .object({
        /** Folder in the project (relative to its root) where `ai-qa-agent plan` writes bug-fix plans. */
        dir: z.string().min(1).default('docs/bug-fix-plan'),
      })
      .default({ dir: 'docs/bug-fix-plan' }),
    ai: z
      .object({
        /** Which locally installed, logged-in agent CLI does the reasoning. */
        provider: z.enum(['claude-code', 'codex', 'opencode']).default('claude-code'),
        /**
         * Model for the provider: a Claude Code alias/id (`sonnet`, `opus`), a Codex model
         * (`gpt-5-codex`) or an OpenCode `provider/model`. Omit to use the provider's default
         * (Claude Code: `sonnet`).
         */
        model: z.string().optional(),
        /** Executable to run. Defaults to `claude`, `codex` or `opencode` on PATH. */
        command: z.string().optional(),
        /** @deprecated use `command`. Path to the `claude` executable. */
        claudePath: z.string().default('claude'),
        /** Hard spending cap per AI task (Claude Code `--max-budget-usd`; Codex/OpenCode have no per-run cap). */
        maxBudgetUsdPerTask: z.number().positive().default(3),
        /** MCP servers made available to AI tasks. Keys become the `mcp__<key>__*` tool prefix. */
        mcpServers: z.record(z.string(), McpServerSchema).default({}),
        /** Only failures classified with at least this confidence are filed as bugs. */
        minConfidenceToFile: z.number().min(0).max(1).default(0.7),
      })
      .default({
        provider: 'claude-code',
        claudePath: 'claude',
        maxBudgetUsdPerTask: 3,
        mcpServers: {},
        minConfidenceToFile: 0.7,
      }),
  })
  .superRefine((c, ctx) => {
    if (c.clickup && c.jira && !c.tracker) {
      ctx.addIssue({
        code: 'custom',
        path: ['tracker'],
        message: 'Both clickup and jira are configured: set tracker to "clickup" or "jira"',
      });
    }
    if (c.tracker && !c[c.tracker]) {
      ctx.addIssue({
        code: 'custom',
        path: ['tracker'],
        message: `tracker is "${c.tracker}" but there is no ${c.tracker} section`,
      });
    }
  });

export type QaConfigInput = z.input<typeof QaConfigSchema>;
export type QaConfig = z.output<typeof QaConfigSchema>;

/** Identity helper that gives `.qa/config.ts` type checking and autocompletion. */
export function defineConfig(config: QaConfigInput): QaConfigInput {
  return config;
}

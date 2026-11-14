import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ensureDir, slugify } from '../core/fs.js';
import { rel } from '../core/paths.js';

// --- Playwright JSON reporter shape (only the parts we use) --------------------------------

const Attachment = z.looseObject({
  name: z.string(),
  contentType: z.string(),
  path: z.string().optional(),
  body: z.string().optional(),
});
const PwError = z.looseObject({
  message: z.string().optional(),
  stack: z.string().optional(),
  snippet: z.string().optional(),
  location: z.looseObject({ file: z.string(), line: z.number(), column: z.number() }).optional(),
});
const PwResult = z.looseObject({
  status: z.string(),
  duration: z.number(),
  retry: z.number(),
  errors: z.array(PwError).default([]),
  attachments: z.array(Attachment).default([]),
});
const PwTest = z.looseObject({
  projectName: z.string(),
  status: z.enum(['expected', 'unexpected', 'flaky', 'skipped']),
  annotations: z.array(z.looseObject({ type: z.string(), description: z.string().optional() })).default([]),
  results: z.array(PwResult),
});
const PwSpec = z.looseObject({
  title: z.string(),
  file: z.string(),
  line: z.number(),
  tags: z.array(z.string()).default([]),
  tests: z.array(PwTest),
});
interface PwSuiteT {
  title: string;
  file?: string;
  specs?: z.infer<typeof PwSpec>[];
  suites?: PwSuiteT[];
}
const PwSuite: z.ZodType<PwSuiteT> = z.lazy(() =>
  z.looseObject({
    title: z.string(),
    file: z.string().optional(),
    specs: z.array(PwSpec).optional(),
    suites: z.array(PwSuite).optional(),
  }),
);
export const PwReportSchema = z.looseObject({
  suites: z.array(PwSuite).default([]),
  errors: z.array(PwError).default([]),
  stats: z.looseObject({
    expected: z.number(),
    unexpected: z.number(),
    flaky: z.number(),
    skipped: z.number(),
  }),
});
export type PwReport = z.infer<typeof PwReportSchema>;

// --- Our normalized outcome ----------------------------------------------------------------

export const TestOutcomeSchema = z.object({
  key: z.string(),
  scenarioId: z.string().nullable(),
  title: z.string(),
  file: z.string(),
  line: z.number(),
  project: z.string(),
  tags: z.array(z.string()),
  status: z.enum(['passed', 'failed', 'flaky', 'skipped']),
  attempts: z.number(),
  durationMs: z.number(),
  error: z
    .object({
      message: z.string(),
      stack: z.string().optional(),
      snippet: z.string().optional(),
      location: z.string().optional(),
    })
    .nullable(),
  annotations: z.array(z.object({ type: z.string(), description: z.string().optional() })),
  artifacts: z.object({
    video: z.string().nullable(),
    trace: z.string().nullable(),
    screenshots: z.array(z.string()),
    errorContext: z.string().nullable(),
    logs: z.string().nullable(),
    design: z.array(z.string()),
  }),
  /** Set when this test was run again on its own (dashboard *Run test*) and merged into the run. */
  rerunAt: z.string().optional(),
});
export type TestOutcome = z.infer<typeof TestOutcomeSchema>;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

export function scenarioIdFromTitle(title: string): string | null {
  return title.match(/^([A-Z0-9]+-\d{3})\b/)?.[1] ?? null;
}

function* walk(suites: PwSuiteT[]): Generator<z.infer<typeof PwSpec>> {
  for (const s of suites) {
    for (const spec of s.specs ?? []) yield spec;
    yield* walk(s.suites ?? []);
  }
}

const STATUS: Record<z.infer<typeof PwTest>['status'], TestOutcome['status']> = {
  expected: 'passed',
  unexpected: 'failed',
  flaky: 'flaky',
  skipped: 'skipped',
};

/**
 * Normalize the Playwright JSON report and copy the evidence of each test's final attempt into
 * `<runDir>/{videos,traces,screenshots,logs,design}/` with predictable names.
 */
export function collectOutcomes(
  report: PwReport,
  runDir: string,
  projectRoot: string,
  testDir: string,
): TestOutcome[] {
  const outcomes: TestOutcome[] = [];
  for (const spec of walk(report.suites)) {
    for (const t of spec.tests) {
      const last = t.results.at(-1);
      const scenarioId = scenarioIdFromTitle(spec.title);
      const base = `${scenarioId ?? slugify(spec.title)}_${t.projectName}`;
      /** Attachments are either files on disk (`path`) or inlined base64 (`body`). */
      const copy = (
        att: z.infer<typeof Attachment> | undefined,
        dir: string,
        name: string,
      ): string | null => {
        if (!att) return null;
        const dest = path.join(runDir, dir, name);
        if (att.path && fs.existsSync(att.path)) {
          ensureDir(path.dirname(dest));
          fs.copyFileSync(att.path, dest);
        } else if (att.body !== undefined) {
          ensureDir(path.dirname(dest));
          fs.writeFileSync(dest, Buffer.from(att.body, 'base64'));
        } else return null;
        return rel(projectRoot, dest);
      };
      const atts = last?.attachments ?? [];
      const byName = (n: string): z.infer<typeof Attachment> | undefined => atts.find((a) => a.name === n);
      const screenshots = atts
        .filter((a) => a.name === 'screenshot')
        .map((a, i) => copy(a, 'screenshots', `${base}${i ? `-${i}` : ''}.png`))
        .filter((p): p is string => !!p);
      const design = atts
        .filter((a) => a.name.startsWith('design-'))
        .map((a) => copy(a, 'design', `${base}_${slugify(a.name.replace(/\.png$/, ''))}.png`))
        .filter((p): p is string => !!p);
      const errors = last?.errors ?? [];
      const err = errors[0];
      // Runtime annotations live on the result in recent Playwright versions, on the test in older ones.
      const annotations = [
        ...t.annotations,
        ...((last as { annotations?: typeof t.annotations } | undefined)?.annotations ?? []),
      ];
      outcomes.push({
        key: `${scenarioId ?? spec.title}@${t.projectName}`,
        scenarioId,
        title: spec.title,
        file: rel(projectRoot, path.join(testDir, spec.file)),
        line: spec.line,
        project: t.projectName,
        tags: spec.tags,
        status: STATUS[t.status],
        attempts: t.results.length,
        durationMs: t.results.reduce((n, r) => n + r.duration, 0),
        error: err
          ? {
              // Soft assertions produce several errors; keep them all.
              message: errors.map((e) => stripAnsi(e.message ?? 'Unknown error')).join('\n\n'),
              stack: err.stack ? stripAnsi(err.stack) : undefined,
              snippet: err.snippet ? stripAnsi(err.snippet) : undefined,
              location: err.location
                ? `${rel(projectRoot, err.location.file)}:${err.location.line}`
                : undefined,
            }
          : null,
        annotations: annotations
          .filter(
            (a, i) =>
              annotations.findIndex((b) => b.type === a.type && b.description === a.description) === i,
          )
          .map((a) => ({ type: a.type, description: a.description })),
        artifacts: {
          video: copy(byName('video'), 'videos', `${base}.webm`),
          trace: copy(byName('trace'), 'traces', `${base}.zip`),
          screenshots,
          errorContext: copy(byName('error-context'), 'logs', `${base}_error-context.md`),
          logs: copy(byName('qa-logs.json'), 'logs', `${base}_console-network.json`),
          design,
        },
      });
    }
  }
  return outcomes;
}

export const TestRunResultSchema = z.object({
  runId: z.string(),
  runDir: z.string(),
  /** What the tests ran against. Missing in results written before production-mode testing. */
  app: z
    .object({
      url: z.string(),
      mode: z.enum(['production', 'development']),
      build: z.enum(['built', 'cached', 'none', 'existing-server']),
    })
    .optional(),
  outcomes: z.array(TestOutcomeSchema),
  /** Errors outside any single test, e.g. a spec file that does not compile. */
  globalErrors: z.array(z.string()),
  exitCode: z.number().nullable(),
  stats: z.object({ passed: z.number(), failed: z.number(), flaky: z.number(), skipped: z.number() }),
});
export type TestRunResult = z.infer<typeof TestRunResultSchema>;

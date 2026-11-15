/**
 * Evidence of one test result, read from the files the run captured. No AI: everything here is
 * either in the Playwright report or in an artifact on disk, and what was not captured is listed
 * as missing rather than assumed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { failedStepOf, videosOf, type TestOutcome } from '../runner/results.js';

const CapturedLogsSchema = z.looseObject({
  console: z
    .array(z.looseObject({ type: z.string(), text: z.string(), location: z.string().optional() }))
    .default([]),
  pageErrors: z.array(z.string()).default([]),
  network: z
    .array(
      z.looseObject({
        url: z.string(),
        method: z.string(),
        status: z.number().optional(),
        failure: z.string().optional(),
      }),
    )
    .default([]),
});

export interface LogSummary {
  consoleErrors: string[];
  consoleWarnings: number;
  pageErrors: string[];
  /** Requests that never got a response (DNS, refused, aborted). */
  failedRequests: string[];
  /** Responses with status 4xx/5xx. */
  httpErrors: string[];
}

const MAX = 8;

/** Console and network findings of a result, or null when its log was not captured or unreadable. */
export function summarizeLogs(root: string, logs: string | null): LogSummary | null {
  if (!logs) return null;
  const file = path.resolve(root, logs);
  if (!fs.existsSync(file)) return null;
  let parsed: z.infer<typeof CapturedLogsSchema>;
  try {
    parsed = CapturedLogsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
  const unique = (xs: string[]): string[] => [...new Set(xs)].slice(0, MAX);
  return {
    consoleErrors: unique(parsed.console.filter((c) => c.type === 'error').map((c) => c.text.slice(0, 300))),
    consoleWarnings: parsed.console.filter((c) => c.type === 'warning').length,
    pageErrors: unique(parsed.pageErrors.map((e) => e.slice(0, 300))),
    failedRequests: unique(
      parsed.network.filter((n) => n.failure).map((n) => `${n.method} ${n.url} — ${n.failure}`),
    ),
    httpErrors: unique(
      parsed.network.filter((n) => n.status !== undefined).map((n) => `${n.method} ${n.url} → ${n.status}`),
    ),
  };
}

export const hasLogFindings = (l: LogSummary): boolean =>
  l.consoleErrors.length + l.pageErrors.length + l.failedRequests.length + l.httpErrors.length > 0;

/** What a Playwright assertion error says, field by field. Every field is null when absent. */
export interface AssertionFacts {
  /** The matcher, e.g. `toBeVisible`, `toHaveText`. */
  matcher: string | null;
  /** The assertion's own message (the text passed to `expect(x, message)`). */
  message: string | null;
  locator: string | null;
  expected: string | null;
  received: string | null;
  timeoutMs: number | null;
  /** The locator matched no element. */
  elementNotFound: boolean;
  /** The test hit its overall timeout (as opposed to an assertion timeout). */
  testTimeout: boolean;
}

const field = (message: string, name: string): string | null => {
  const m = message.match(new RegExp(`^\\s*${name}(?: string| pattern)?:\\s*(.+)$`, 'm'));
  return m ? m[1]!.trim() : null;
};

export function parseAssertion(message: string | undefined): AssertionFacts | null {
  if (!message) return null;
  const first = message.split('\n')[0] ?? '';
  const matcher = message.match(/\.(to[A-Z]\w*|not\.to[A-Z]\w*)\(/)?.[1] ?? null;
  const own = first.replace(/^Error:\s*/, '');
  const timeout = field(message, 'Timeout');
  return {
    matcher,
    // A first line that is the matcher call itself is not a message of the test author.
    message: own && !/^expect\(/.test(own) && !/^(Timeout|Test timeout)/.test(own) ? own : null,
    locator: field(message, 'Locator'),
    expected: field(message, 'Expected'),
    received: field(message, 'Received'),
    timeoutMs: timeout ? Number.parseInt(timeout, 10) || null : null,
    elementNotFound: /element\(s\) not found/.test(message),
    testTimeout: /Test timeout of \d+ms exceeded/.test(message),
  };
}

export type EvidenceKind =
  | 'error'
  | 'failed-step'
  | 'assertion'
  | 'code'
  | 'screenshot'
  | 'video'
  | 'trace'
  | 'dom-snapshot'
  | 'console-network'
  | 'design-diff'
  | 'check';

export interface EvidenceItem {
  kind: EvidenceKind;
  label: string;
  /** Project-relative path of the artifact, when the item is a file. */
  path?: string;
  /** The text of the item (error line, assertion values, log findings). */
  detail?: string;
}

export interface ResultEvidence {
  items: EvidenceItem[];
  /** Evidence that would help but was not captured for this result. */
  missing: string[];
  logs: LogSummary | null;
  assertion: AssertionFacts | null;
}

/** Everything this result captured, with each artifact checked on disk, and what is missing. */
export function evidenceOf(o: TestOutcome, root: string): ResultEvidence {
  const items: EvidenceItem[] = [];
  const missing: string[] = [];
  const exists = (p: string | null | undefined): p is string => !!p && fs.existsSync(path.resolve(root, p));
  const failed = o.status === 'failed' || o.status === 'flaky';

  if (o.error) {
    items.push({
      kind: 'error',
      label: 'Playwright error',
      detail: o.error.message.split('\n\n')[0]!.trim(),
    });
    if (o.error.location) items.push({ kind: 'code', label: 'Failed at', detail: o.error.location });
  }
  const step = failedStepOf(o);
  if (step) {
    items.push({
      kind: 'failed-step',
      label: `Failed step ${step.index + 1} of ${o.steps!.length} executed`,
      detail: [step.step.title, ...(step.step.failedPath ?? [])].join(' › '),
    });
  }
  const assertion = parseAssertion(o.error?.message);
  if (assertion && (assertion.expected !== null || assertion.received !== null || assertion.locator)) {
    items.push({
      kind: 'assertion',
      label: assertion.matcher ? `Assertion ${assertion.matcher}` : 'Assertion',
      detail: [
        assertion.locator && `locator ${assertion.locator}`,
        assertion.expected !== null && `expected ${assertion.expected}`,
        assertion.received !== null && `received ${assertion.received}`,
        assertion.elementNotFound && 'element not found',
        assertion.timeoutMs !== null && `after ${assertion.timeoutMs} ms`,
      ]
        .filter(Boolean)
        .join('; '),
    });
  }
  for (const a of o.annotations.filter((x) => x.type.startsWith('qa-'))) {
    items.push({ kind: 'check', label: a.type, detail: a.description });
  }

  const shots = o.artifacts.screenshots.filter(exists);
  shots.forEach((s, i) =>
    items.push({ kind: 'screenshot', label: `Screenshot${shots.length > 1 ? ` ${i + 1}` : ''}`, path: s }),
  );
  const videos = videosOf(o.artifacts).filter(exists);
  videos.forEach((v, i) =>
    items.push({ kind: 'video', label: videos.length > 1 ? `Video, page ${i + 1}` : 'Video', path: v }),
  );
  if (exists(o.artifacts.trace))
    items.push({ kind: 'trace', label: 'Playwright trace', path: o.artifacts.trace });
  if (exists(o.artifacts.errorContext))
    items.push({
      kind: 'dom-snapshot',
      label: 'Accessibility/DOM snapshot at failure',
      path: o.artifacts.errorContext,
    });
  for (const d of o.artifacts.design.filter(exists))
    items.push({ kind: 'design-diff', label: 'Design comparison', path: d });

  const logs = summarizeLogs(root, o.artifacts.logs);
  if (logs) {
    const findings = [
      ...logs.pageErrors.map((e) => `page error: ${e}`),
      ...logs.consoleErrors.map((e) => `console error: ${e}`),
      ...logs.httpErrors.map((e) => `HTTP ${e}`),
      ...logs.failedRequests.map((e) => `request failed: ${e}`),
    ];
    items.push({
      kind: 'console-network',
      label: 'Console and network log',
      path: o.artifacts.logs!,
      detail: findings.length
        ? findings.join('\n')
        : 'No page errors, console errors, failed requests or 4xx/5xx responses were recorded.',
    });
  }

  if (failed) {
    if (!o.error) missing.push('Playwright error message');
    if (!shots.length) missing.push('screenshot');
    if (!exists(o.artifacts.errorContext)) missing.push('DOM snapshot at failure');
    if (!logs) missing.push('console and network log');
    if (!exists(o.artifacts.trace)) missing.push('trace');
    if (!videos.length) missing.push('video');
    if (o.steps === undefined)
      missing.push('step-by-step execution record (results written before steps were recorded)');
    else if (o.steps.length === 0) missing.push('named test steps (the test uses no test.step)');
  }
  return { items, missing, logs, assertion };
}

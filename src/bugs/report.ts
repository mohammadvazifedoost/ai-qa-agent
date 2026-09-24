import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { QaContext } from '../pipeline/context.js';
import type { TestOutcome, TestRunResult } from '../runner/results.js';
import type { Issue } from '../triage/schema.js';

export interface BugEnvironment {
  baseUrl: string;
  browsers: string[];
  os: string;
  node: string;
  commit: string | null;
  runId: string;
}

export function environment(ctx: QaContext, runId: string): BugEnvironment {
  return {
    baseUrl: ctx.config.app.baseUrl,
    browsers: ctx.config.browsers,
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    commit: gitCommit(ctx.root),
    runId,
  };
}

/** Short HEAD commit of the target project, or null when it is not a plain git checkout. */
function gitCommit(root: string): string | null {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 12);
    return fs
      .readFileSync(path.join(root, '.git', head.slice(5)), 'utf8')
      .trim()
      .slice(0, 12);
  } catch {
    return null;
  }
}

export interface Evidence {
  key: string;
  project: string;
  screenshot: string | null;
  video: string | null;
  trace: string | null;
  design: string[];
  errorContext: string | null;
}

export function evidenceFor(issue: Issue, run: TestRunResult): Evidence[] {
  return issue.failureKeys
    .map((k) => run.outcomes.find((o) => o.key === k))
    .filter((o): o is TestOutcome => !!o)
    .map((o) => ({
      key: o.key,
      project: o.project,
      screenshot: o.artifacts.screenshots[0] ?? null,
      video: o.artifacts.video,
      trace: o.artifacts.trace,
      design: o.artifacts.design,
      errorContext: o.artifacts.errorContext,
    }));
}

const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' } as const;

/** Markdown bug report; used for the local report and as the ClickUp task description. */
export function renderBugMarkdown(issue: Issue, env: BugEnvironment, evidence: Evidence[]): string {
  const b = issue.bug;
  const lines = [
    `**Severity:** ${SEVERITY_LABEL[b.severity]}  `,
    `**Category:** ${b.category} (${issue.classification === 'DESIGN_MISMATCH' ? 'design mismatch' : 'product bug'})  `,
    `**Affected page:** \`${b.affectedPage}\`  `,
    `**Test IDs:** ${issue.scenarioIds.map((s) => `\`${s}\``).join(', ')}  `,
    `**Confidence:** ${Math.round(issue.confidence * 100)}%`,
    '',
    '## Steps to reproduce',
    ...b.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## Expected result',
    b.expectedResult,
    '',
    '## Actual result',
    b.actualResult,
    '',
    '## Suspected root cause',
    b.suspectedRootCause,
    '',
    '## Environment',
    `- App URL: ${env.baseUrl}`,
    `- Browser / viewport: ${[...new Set(evidence.map((e) => e.project))].join(', ') || env.browsers.join(', ')}`,
    `- OS: ${env.os}, Node ${env.node}`,
    `- Commit: ${env.commit ?? 'unknown'}`,
    `- QA run: ${env.runId}`,
    '',
    '## Evidence',
    ...evidence.flatMap((e) => [
      `- **${e.key}**`,
      e.screenshot ? `  - Screenshot: \`${e.screenshot}\`` : '',
      e.video ? `  - Video: \`${e.video}\`` : '',
      e.trace ? `  - Trace: \`${e.trace}\` (open with \`npx playwright show-trace <file>\`)` : '',
      ...e.design.map((d) => `  - Design comparison: \`${d}\``),
    ]),
    '',
    '_Filed automatically by ai-qa after failure analysis. The test failed on every retry._',
  ];
  return lines
    .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
    .filter((l) => l !== '  ' && !/^\s+$/.test(l))
    .join('\n');
}

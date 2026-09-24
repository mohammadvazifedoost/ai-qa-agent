import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../core/fs.js';
import { rel } from '../core/paths.js';
import { environment, evidenceFor, renderBugMarkdown } from '../bugs/report.js';
import type { FilingSummary } from '../bugs/file.js';
import type { QaContext } from '../pipeline/context.js';
import type { TestRunResult } from '../runner/results.js';
import type { TriageResult } from '../triage/schema.js';

export interface ReportFiles {
  markdown: string;
  html: string;
  bugsDir: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildMarkdown(
  ctx: QaContext,
  run: TestRunResult,
  triage: TriageResult | null,
  filing: FilingSummary | null,
  aiCostUsd: number,
): string {
  const s = run.stats;
  const out: string[] = [];
  out.push(`# QA report — ${ctx.config.project.name}`, '');
  out.push(`Run \`${run.runId}\` against ${ctx.config.app.baseUrl}`, '');
  out.push('## Summary', '');
  out.push(
    `| Passed | Failed | Flaky | Skipped |`,
    `|---|---|---|---|`,
    `| ${s.passed} | ${s.failed} | ${s.flaky} | ${s.skipped} |`,
    '',
  );
  if (run.globalErrors.length) {
    out.push('**Errors outside tests:**', ...run.globalErrors.map((e) => `- \`${e.split('\n')[0]}\``), '');
  }
  if (triage) {
    const counts = triage.failures.reduce<Record<string, number>>(
      (m, f) => ((m[f.classification] = (m[f.classification] ?? 0) + 1), m),
      {},
    );
    out.push('### Failure classification', '', '| Classification | Count |', '|---|---|');
    for (const [k, v] of Object.entries(counts)) out.push(`| ${k} | ${v} |`);
    out.push('');
    out.push(
      `**Distinct defects:** ${triage.issues.length} (${triage.issues.filter((i) => i.fileable).length} confirmed for filing)`,
      '',
    );
  }
  if (filing) out.push(`**Bug tracker:** ${filing.message}`, '');
  out.push(`**AI cost this run:** $${aiCostUsd.toFixed(2)}`, '');

  if (triage?.issues.length) {
    out.push('## Defects', '');
    for (const issue of triage.issues) {
      const f = filing?.results.find((r) => r.issueId === issue.id);
      const where = f?.url
        ? `[${f.taskId}](${f.url})`
        : f
          ? `${f.action}${f.reason ? `: ${f.reason}` : ''}`
          : (issue.notFiledReason ?? 'not filed');
      out.push(`### ${issue.id}: ${issue.bug.title}`, '');
      out.push(
        `- ${issue.classification} · ${issue.bug.severity} · ${issue.bug.category} · \`${issue.bug.affectedPage}\``,
      );
      out.push(`- Tests: ${issue.scenarioIds.join(', ')} · ClickUp: ${where}`);
      out.push(`- Expected: ${issue.bug.expectedResult}`);
      out.push(`- Actual: ${issue.bug.actualResult}`);
      out.push(`- Root cause: ${issue.bug.suspectedRootCause}`, '');
    }
  }
  if (triage) {
    const other = triage.failures.filter(
      (f) => f.classification !== 'PRODUCT_BUG' && f.classification !== 'DESIGN_MISMATCH',
    );
    if (other.length) {
      out.push(
        '## Failures that are not product defects',
        '',
        '| Test | Classification | Why |',
        '|---|---|---|',
      );
      for (const f of other)
        out.push(
          `| ${f.key} | ${f.classification} (${Math.round(f.confidence * 100)}%) | ${(f.testProblem ?? f.summary).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`,
        );
      out.push('');
    }
  }
  out.push('## All tests', '', '| Test | Project | Status | Attempts | Evidence |', '|---|---|---|---|---|');
  for (const o of run.outcomes) {
    const ev = [
      o.artifacts.screenshots[0] && 'screenshot',
      o.artifacts.video && 'video',
      o.artifacts.trace && 'trace',
    ]
      .filter(Boolean)
      .join(', ');
    out.push(`| ${o.title.replace(/\|/g, '\\|')} | ${o.project} | ${o.status} | ${o.attempts} | ${ev} |`);
  }
  out.push('', `Evidence directory: \`${rel(ctx.root, run.runDir)}\``);
  return out.join('\n') + '\n';
}

/** Minimal self-contained HTML rendering of the markdown report (tables, headings, lists). */
function markdownToHtml(md: string, title: string): string {
  const html: string[] = [];
  let inTable = false;
  let inList = false;
  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  for (const line of md.split('\n')) {
    if (line.startsWith('|')) {
      if (/^\|[-| ]+\|$/.test(line)) continue;
      const cells = line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((c) => inline(c.trim().replace(/\\\|/g, '|')));
      html.push(`${inTable ? '' : '<table>'}<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`);
      inTable = true;
      continue;
    }
    if (inTable) (html.push('</table>'), (inTable = false));
    if (line.startsWith('- ')) {
      html.push(`${inList ? '' : '<ul>'}<li>${inline(line.slice(2))}</li>`);
      inList = true;
      continue;
    }
    if (inList) (html.push('</ul>'), (inList = false));
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) html.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
  }
  if (inTable) html.push('</table>');
  if (inList) html.push('</ul>');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 16px;color:#0f172a}
table{border-collapse:collapse;width:100%;margin:1rem 0}td{border:1px solid #e2e8f0;padding:6px 8px;vertical-align:top}
tr:first-child td{font-weight:600;background:#f8fafc}code{background:#f1f5f9;padding:1px 4px;border-radius:4px;font-size:13px}
h3{margin-top:2rem}</style></head><body>${html.join('\n')}</body></html>`;
}

export function writeReport(
  ctx: QaContext,
  run: TestRunResult,
  triage: TriageResult | null,
  filing: FilingSummary | null,
  aiCostUsd: number,
): ReportFiles {
  const dir = path.join(ctx.paths.reportsDir, run.runId);
  const bugsDir = path.join(dir, 'bugs');
  ensureDir(bugsDir);
  const md = buildMarkdown(ctx, run, triage, filing, aiCostUsd);
  const markdown = path.join(dir, 'report.md');
  const html = path.join(dir, 'report.html');
  fs.writeFileSync(markdown, md);
  fs.writeFileSync(html, markdownToHtml(md, `QA report ${run.runId}`));
  const env = environment(ctx, run.runId);
  for (const issue of triage?.issues ?? []) {
    fs.writeFileSync(
      path.join(bugsDir, `${issue.id}.md`),
      `# ${issue.id}: ${issue.bug.title}\n\n${renderBugMarkdown(issue, env, evidenceFor(issue, run))}\n`,
    );
  }
  if (triage) fs.writeFileSync(path.join(dir, 'bugs.json'), JSON.stringify(triage.issues, null, 2));
  fs.copyFileSync(markdown, path.join(ctx.paths.reportsDir, 'latest.md'));
  return { markdown, html, bugsDir };
}

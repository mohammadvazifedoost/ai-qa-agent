/**
 * Markdown and HTML renderings of the QA report model. Both have the same eight sections and the
 * same per-scenario template; neither adds information that is not in the model.
 */
import path from 'node:path';
import type {
  AnalysisView,
  ConsolidatedIssue,
  Execution,
  QaReport,
  ScenarioReport,
  ScenarioStatus,
} from './model.js';

export const STATUS_LABEL: Record<ScenarioStatus, string> = {
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
  error: 'Error',
  'not-run': 'Not run',
};
const KIND_LABEL: Record<ConsolidatedIssue['kind'], string> = {
  application: 'Application defect',
  test: 'Test implementation',
  environment: 'Environment',
  unconfirmed: 'Needs investigation',
};
const CLASSIFICATION_LABEL: Record<string, string> = {
  PRODUCT_BUG: 'product bug',
  DESIGN_MISMATCH: 'design mismatch',
  TEST_BUG: 'test bug',
  ENVIRONMENT_FAILURE: 'environment failure',
  INFRASTRUCTURE_FAILURE: 'infrastructure failure',
  UNKNOWN: 'unconfirmed',
};
const ROOT_STATUS: Record<string, string> = {
  verified: 'Verified',
  hypothesis: 'Hypothesis (not verified)',
  unconfirmed: 'Unconfirmed',
};
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const pctText = (n: number | null): string => (n === null ? 'n/a' : `${n}%`);
const anchor = (id: string): string => `scenario-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
const issueAnchor = (id: string): string => `issue-${id.toLowerCase()}`;
const confidenceText = (a: AnalysisView): string =>
  `${cap(a.confidenceLevel)} (${Math.round(a.confidence * 100)}%), root cause ${ROOT_STATUS[a.rootCause.status]!.toLowerCase()}`;
const loc = (l: { file: string; line: number | null; symbol: string | null }): string =>
  `${l.file}${l.line !== null ? `:${l.line}` : ''}${l.symbol ? ` (${l.symbol})` : ''}`;

/** Link target of a project-relative artifact path, relative to the report's own folder. */
const linkTo = (base: string, p: string): string => path.posix.relative(base, p);

// --- Markdown ---------------------------------------------------------------------------------

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const list = (xs: readonly string[], empty = '_None._'): string[] =>
  xs.length ? xs.map((x) => `- ${x}`) : [empty];
const numbered = (xs: readonly string[]): string[] => xs.map((x, i) => `${i + 1}. ${x}`);
const fence = (s: string): string[] => ['```text', s.replace(/```/g, "'''").trim(), '```'];

function mdExecution(e: Execution, multi: boolean): string[] {
  const out: string[] = [];
  if (multi)
    out.push(`**${e.project}**: ${e.result}${e.attempts > 1 ? ` after ${e.attempts} attempts` : ''}`, '');
  if (e.steps === null) out.push('- Execution steps: not recorded for this result.');
  else if (e.steps.length === 0) out.push('- Execution steps: the test has no named steps.');
  else {
    out.push('- Execution steps:');
    e.steps.forEach((st, i) =>
      out.push(`  ${i + 1}. ${st.status === 'failed' ? '✗' : '✓'} ${st.title} (${st.durationMs} ms)`),
    );
    if (e.failedStep) out.push('  Steps after the failed step did not run.');
  }
  out.push(
    `- Failed step: ${e.failedStep ? `${e.failedStep.index + 1}. ${[e.failedStep.title, ...e.failedStep.path].join(' › ')}` : (e.failurePoint ?? 'none')}`,
  );
  if (e.error) {
    out.push(
      `- Execution error${e.error.location ? ` at \`${e.error.location}\`` : ''}:`,
      '',
      ...fence(e.error.message.slice(0, 1500)),
    );
    if (e.error.snippet) out.push('', ...fence(e.error.snippet));
  } else out.push('- Execution error: none recorded.');
  return out;
}

function mdScenario(s: ScenarioReport, base: string): string[] {
  const out: string[] = [];
  out.push(`<a id="${anchor(s.id)}"></a>`, '', `### ${s.id}: ${s.title}`, '');
  out.push(
    '#### Scenario information',
    '',
    `- Scenario ID: \`${s.id}\``,
    `- Scenario name: ${s.title}`,
    `- Priority: ${s.priority ? cap(s.priority) : 'unknown'}${s.critical ? ' (critical flow)' : ''}`,
    `- Execution status: **${STATUS_LABEL[s.status]}**${s.statusReason ? ` — ${s.statusReason}` : ''}`,
    `- Related page/feature: ${s.page ? `\`${s.page}\`` : 'unknown'}${s.feature ? ` / ${s.feature}` : ''}${s.category ? ` (${s.category})` : ''}`,
    ...(s.issueId ? [`- Consolidated issue: [${s.issueId}](#${issueAnchor(s.issueId)})`] : []),
    '',
    '#### Scenario objective',
    '',
    s.objective,
    '',
  );
  if (s.status === 'passed') {
    out.push(
      '#### Verified',
      '',
      ...list(s.verified, '_The test passed; it has no named steps or expected results to list._'),
      '',
      `Ran on: ${s.executions.map((e) => `${e.project}${e.attempts > 1 ? ` (passed after ${e.attempts} attempts)` : ''}`).join(', ')}`,
      '',
    );
    return out;
  }
  if (s.status === 'blocked' || s.status === 'skipped') {
    out.push('#### Execution details', '', `- ${s.statusReason ?? STATUS_LABEL[s.status]}`, '');
    if (s.verificationSteps.length) out.push('#### Verification', '', ...list(s.verificationSteps), '');
    return out;
  }

  const a = s.analysis;
  out.push('#### Execution details', '');
  if (s.steps.length) out.push('Scenario steps:', '', ...numbered(s.steps), '');
  const failing = s.executions.filter((e) => e.status !== 'passed' && e.status !== 'skipped');
  for (const e of failing) out.push(...mdExecution(e, s.executions.length > 1), '');
  const passedElsewhere = s.executions.filter((e) => e.status === 'passed');
  if (passedElsewhere.length) out.push(`Passed on: ${passedElsewhere.map((e) => e.project).join(', ')}`, '');

  out.push('#### Expected vs. actual behavior', '');
  out.push(
    `- **Expected:** ${a?.expected ?? s.observed?.expected ?? 'unknown'}`,
    `- **Actual:** ${a?.actual ?? s.observed?.actual ?? 'unknown'}`,
    `- **Difference:** ${a?.difference ?? s.observed?.difference ?? 'unknown'}`,
  );
  if (a && s.observed && a.method === 'ai') out.push(`- Recorded by Playwright: ${s.observed.difference}`);
  out.push('');

  out.push('#### Failure analysis', '');
  if (!a) {
    out.push(
      '- Failure category: not analyzed',
      '- Root cause: unconfirmed — this failure has not been analyzed. Run `npx ai-qa-agent triage` to diagnose it.',
      '',
    );
  } else {
    out.push(
      `- Failure category: ${a.categoryLabel} (${CLASSIFICATION_LABEL[a.classification]}${a.method === 'rule' ? ', by deterministic rule' : ''})`,
      `- Failure point: ${a.failurePoint}`,
      `- Origin: ${a.layer}`,
      `- Root cause: ${a.rootCause.statement}`,
      `- Root cause confidence: ${confidenceText(a)}`,
    );
    if (a.severity) out.push(`- Bug severity: ${cap(a.severity)}${a.bugTitle ? ` — ${a.bugTitle}` : ''}`);
    if (a.timing)
      out.push(`- Timing / async: ${a.timing.suspected ? 'possible' : 'unlikely'} — ${a.timing.explanation}`);
    if (a.testProblem && a.origin === 'test') out.push(`- Problem in the test: ${a.testProblem}`);
    out.push('');
    if (a.rootCause.facts.length) out.push('Verified facts:', '', ...list(a.rootCause.facts), '');
    if (a.rootCause.hypotheses.length)
      out.push('Hypotheses (not verified):', '', ...list(a.rootCause.hypotheses), '');
    out.push('Supporting evidence:', '');
    const ev = failing.flatMap((e) => e.evidence.items.map((i) => ({ e, i })));
    out.push(
      ...list(
        ev.map(
          ({ e, i }) =>
            `${s.executions.length > 1 ? `[${e.project}] ` : ''}${i.label}${i.path ? `: [${path.posix.basename(i.path)}](${linkTo(base, i.path)})` : ''}${i.detail && !i.path ? `: ${i.detail.split('\n').join('; ')}` : i.detail ? ` — ${i.detail.split('\n').join('; ')}` : ''}`,
        ),
      ),
      '',
    );
    if (a.evidenceReviewed.length)
      out.push(`Inspected by the analyzer: ${a.evidenceReviewed.join(', ')}`, '');
    const missing = [
      ...new Set([...failing.flatMap((e) => e.evidence.missing), ...a.rootCause.missingEvidence]),
    ];
    if (missing.length) out.push('Missing evidence:', '', ...list(missing), '');
    if (a.rootCause.investigation.length)
      out.push('Further investigation needed:', '', ...numbered(a.rootCause.investigation), '');
    if (a.engineNotes.length) out.push('Engine checks of this analysis:', '', ...list(a.engineNotes), '');
    for (const o of s.otherAnalyses)
      out.push(`- Also failed on ${o.project}: ${CLASSIFICATION_LABEL[o.classification]} — ${o.summary}`);
    if (s.otherAnalyses.length) out.push('');
  }

  out.push('#### Bug fix plan', '');
  if (!a?.fix) {
    out.push(
      a?.legacy
        ? `_This run was triaged by an older version without fix plans. ${a.testProblem ? `Test problem: ${a.testProblem}` : `Suspected cause: ${a.rootCause.statement}`}_`
        : '_No fix plan: the root cause is not established. Analyze the failure first._',
      '',
    );
  } else {
    const f = a.fix;
    out.push(
      `- Change: ${f.target === 'investigate' ? 'investigate first (cause unconfirmed)' : `the ${f.target}`}`,
      `- Affected files/components: ${a.rootCause.locations.length ? a.rootCause.locations.map((l) => `\`${loc(l)}\` (${l.role}: ${l.note})`).join('; ') : 'not identified in verified code'}`,
      `- Root cause: ${a.rootCause.statement}`,
      `- Recommended fix: ${f.summary}`,
      '',
      'Required changes:',
      '',
      ...list(f.requiredChanges),
      '',
    );
    if (f.implementationSteps.length)
      out.push('Recommended implementation steps:', '', ...numbered(f.implementationSteps), '');
    if (f.alternatives.length) out.push('Alternatives:', '', ...list(f.alternatives), '');
    out.push(
      `- Dependencies / side effects: ${f.sideEffects || 'none named'}`,
      `- Expected result: ${f.expectedAfterFix}`,
      '',
    );
    if (a.rejectedLocations.length)
      out.push(
        `_Locations named by the analyzer but not found in the project (left out): ${a.rejectedLocations.map((r) => `${r.file}${r.line !== null ? `:${r.line}` : ''} (${r.reason})`).join(', ')}._`,
        '',
      );
  }

  out.push('#### Acceptance criteria', '', ...list(s.acceptanceCriteria), '');
  out.push(
    '#### Verification and regression tests',
    '',
    'Verification:',
    '',
    ...list(s.verificationSteps),
    '',
  );
  out.push(
    'Regression:',
    '',
    ...list(
      [...s.regression.scenarioIds.map((id) => `Re-run [${id}](#${anchor(id)})`), ...s.regression.areas],
      '_See the regression recommendations section._',
    ),
    '',
  );
  return out;
}

function mdIssue(i: ConsolidatedIssue): string[] {
  return [
    `<a id="${issueAnchor(i.id)}"></a>`,
    '',
    `### ${i.rank}. ${i.id}: ${i.title}`,
    '',
    `- Kind: ${KIND_LABEL[i.kind]} · ${i.categoryLabel}${i.severity ? ` · severity ${cap(i.severity)}` : ''}${i.confidence !== null ? ` · confidence ${Math.round(i.confidence * 100)}%` : ''}`,
    `- Scenarios: ${i.scenarioIds.map((id) => `[${id}](#${anchor(id)})`).join(', ')}`,
    `- Root cause (${ROOT_STATUS[i.rootCauseStatus]!.toLowerCase()}): ${i.rootCause}`,
    ...(i.locations.length ? [`- Locations: ${i.locations.map((l) => `\`${loc(l)}\``).join(', ')}`] : []),
    ...(i.groupReason ? [`- Why grouped: ${i.groupReason}`] : []),
    ...(i.fix
      ? [`- Fix: ${i.fix.summary}`, ...i.fix.requiredChanges.map((c) => `  - ${c}`)]
      : ['- Fix: not established yet.']),
    ...(i.fix?.sideEffects ? [`- Side effects: ${i.fix.sideEffects}`] : []),
    ...(i.dependsOn.length
      ? [`- Depends on: ${i.dependsOn.map((d) => `[${d}](#${issueAnchor(d)})`).join(', ')}`]
      : []),
    ...i.related.map((r) => `- Related: [${r.id}](#${issueAnchor(r.id)}) — ${r.reason}`),
    ...(i.kind === 'application'
      ? [
          `- Bug tracker: ${i.tracker ? (i.tracker.url ? `[${i.tracker.taskId}](${i.tracker.url})` : i.tracker.taskId) : i.fileable ? 'confirmed for filing, not logged yet' : `not filed: ${i.notFiledReason ?? 'below the filing gates'}`}`,
        ]
      : []),
    '',
  ];
}

export function renderMarkdown(r: QaReport, base: string): string {
  const s = r.summary;
  const out: string[] = [];
  const failed = r.scenarios.filter((x) => x.status !== 'passed');
  out.push(`# QA report — ${r.project}`, '');
  out.push(
    `Run \`${r.runId}\` against ${r.target} · generated ${r.generatedAt.slice(0, 16).replace('T', ' ')} · AI cost $${r.aiCostUsd.toFixed(2)}`,
    '',
  );
  out.push(
    '**Contents:** 1. Executive summary · 2. Test execution statistics · 3. Critical findings · 4. Individual scenario reports · 5. Consolidated bug fix plan · 6. Recommended fix priorities · 7. Regression testing recommendations · 8. Evidence and execution artifacts',
    '',
  );

  out.push('## 1. Executive summary', '', s.headline, '');
  if (!r.triaged && failed.some((x) => x.status === 'failed'))
    out.push(
      '_The failures of this run have not been analyzed by the AI. Run `npx ai-qa-agent triage` for root causes and fix plans; only deterministic findings are shown._',
      '',
    );
  const top = r.issues.slice(0, 5);
  if (top.length) {
    out.push('Most important problems, in the order to address them:', '');
    out.push(
      ...top.map(
        (i) =>
          `${i.rank}. **${i.id}** ${i.title} — ${KIND_LABEL[i.kind]}${i.severity ? `, ${i.severity}` : ''}; ${i.scenarioIds.length} scenario(s). ${i.rankReason}`,
      ),
      '',
    );
  }
  out.push(
    `Application defects and test or environment problems are reported separately: ${s.findings.applicationScenarios} failed scenario(s) trace back to the application, ${s.findings.testIssues} to the tests themselves and ${s.findings.environmentIssues} to the environment.`,
    '',
  );

  out.push('## 2. Test execution statistics', '');
  out.push(
    '| Scenarios | Passed | Failed | Blocked | Skipped | Errors | Pass rate | Pass rate of executed |',
    '|---|---|---|---|---|---|---|---|',
    `| ${s.scenarios.total} | ${s.scenarios.passed} | ${s.scenarios.failed} | ${s.scenarios.blocked} | ${s.scenarios.skipped} | ${s.scenarios.error} | ${pctText(s.passRate)} | ${pctText(s.executedPassRate)} |`,
    '',
    `Pass rate = passed ÷ all scenarios of the run; blocked, skipped and errored scenarios count as not passed. "Pass rate of executed" leaves out scenarios whose checks never ran (blocked, skipped). Results per browser and viewport: ${s.results.total} (${s.results.passed} passed, ${s.results.failed} failed, ${s.results.flaky} flaky, ${s.results.skipped} skipped).`,
    '',
    '| Finding | Count |',
    '|---|---|',
    `| Confirmed application bugs (distinct) | ${s.findings.applicationBugs} (${s.findings.applicationBugsFileable} meet the filing gates) |`,
    `| Failed scenarios caused by the application | ${s.findings.applicationScenarios} |`,
    `| Test implementation issues | ${s.findings.testIssues} |`,
    `| Environment / infrastructure issues | ${s.findings.environmentIssues} |`,
    `| Unconfirmed root cause | ${s.findings.unconfirmed} |`,
    `| Flaky / intermittent | ${s.findings.intermittent} |`,
    `| Not analyzed | ${s.findings.notAnalyzed} |`,
    '',
  );
  if (s.scenarios.notRun || s.scenarios.drafts)
    out.push(
      `Not part of this run: ${s.scenarios.notRun} approved scenario(s) (listed at the end of section 4) and ${s.scenarios.drafts} unapproved draft(s).`,
      '',
    );

  out.push('## 3. Critical findings', '');
  out.push(
    ...list(
      r.criticalFindings.map(
        (f) =>
          `**${cap(f.level)}** — ${f.issueId ? `[${f.issueId}](#${issueAnchor(f.issueId)}) ` : ''}${f.title}${f.detail ? `: ${f.detail}` : ''}${f.scenarioIds.length ? ` (${f.scenarioIds.join(', ')})` : ''}`,
      ),
      '_No critical findings._',
    ),
    '',
  );

  out.push('## 4. Individual test scenario reports', '');
  out.push('| Scenario | Priority | Status | Failure category | Issue |', '|---|---|---|---|---|');
  for (const x of r.scenarios)
    out.push(
      `| [${x.id}](#${anchor(x.id)}) ${cell(x.title)} | ${x.priority ? cap(x.priority) : '—'} | ${STATUS_LABEL[x.status]} | ${x.analysis ? x.analysis.categoryLabel : x.status === 'failed' || x.status === 'error' ? 'not analyzed' : '—'} | ${x.issueId ?? '—'} |`,
    );
  out.push('');
  for (const x of r.scenarios) out.push(...mdScenario(x, base));
  if (r.notRun.length)
    out.push(
      '### Not part of this run',
      '',
      ...r.notRun.map((n) => `- \`${n.id}\` ${n.title} (${n.page})`),
      '',
    );

  out.push('## 5. Consolidated bug fix plan', '');
  out.push(
    r.issues.length
      ? 'Failures are grouped only where a shared cause is verified (the defect consolidator confirmed it in the code, or the tests fail at the same line). Every scenario keeps its own report in section 4.'
      : '_Nothing to fix._',
    '',
  );
  for (const i of r.issues) out.push(...mdIssue(i));

  out.push('## 6. Recommended fix priorities', '');
  if (r.issues.length) {
    out.push('| # | Issue | Kind | Severity | Scenarios | Why this order |', '|---|---|---|---|---|---|');
    for (const i of r.issues)
      out.push(
        `| ${i.rank} | [${i.id}](#${issueAnchor(i.id)}) ${cell(i.title)} | ${KIND_LABEL[i.kind]} | ${i.severity ? cap(i.severity) : '—'} | ${i.scenarioIds.length} | ${cell(i.rankReason)}${i.dependsOn.length ? ` Depends on ${i.dependsOn.join(', ')}.` : ''} |`,
      );
    out.push('');
  } else out.push('_Nothing to prioritize._', '');

  out.push('## 7. Regression testing recommendations', '');
  if (r.regression.length) {
    out.push(
      'Re-run these passing or untouched scenarios after the fixes, as well as the failed scenarios themselves.',
      '',
    );
    out.push('| Scenario | Why | After fixing |', '|---|---|---|');
    for (const g of r.regression)
      out.push(
        `| \`${g.scenarioId}\` ${cell(g.title)} | ${cell(g.reasons.join('; '))} | ${g.issueIds.join(', ')} |`,
      );
    out.push('');
  } else
    out.push(
      r.issues.length
        ? '_Re-run the failed scenarios; no other scenario shares their page, feature or code._'
        : '_None needed._',
      '',
    );

  out.push('## 8. Evidence and execution artifacts', '');
  out.push(`Evidence directory: \`${r.artifacts.runDir}\``, '');
  if (r.artifacts.files.length)
    out.push(
      ...r.artifacts.files.map(
        (f) => `- ${f.label}: [${path.posix.basename(f.path)}](${linkTo(base, f.path)})`,
      ),
      '',
    );
  out.push(
    '| Scenario | Browser / viewport | Result | Attempts | Captured | Missing |',
    '|---|---|---|---|---|---|',
  );
  for (const x of r.scenarios)
    for (const e of x.executions) {
      const files = e.evidence.items.filter((i) => i.path);
      out.push(
        `| ${x.id} | ${e.project} | ${e.result} | ${e.attempts} | ${files.map((i) => `[${cell(i.label)}](${linkTo(base, i.path!)})`).join(', ') || '—'} | ${cell(e.evidence.missing.join(', ')) || '—'} |`,
      );
    }
  out.push('');
  return out.join('\n');
}

// --- HTML -------------------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ul = (xs: readonly string[], empty = '<p class="muted">None.</p>'): string =>
  xs.length ? `<ul>${xs.map((x) => `<li>${x}</li>`).join('')}</ul>` : empty;
const ol = (xs: readonly string[]): string =>
  xs.length ? `<ol>${xs.map((x) => `<li>${x}</li>`).join('')}</ol>` : '';
const pill = (status: string, text: string): string =>
  `<span class="pill st-${esc(status)}">${esc(text)}</span>`;
const dl = (rows: Array<[string, string]>): string =>
  `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const code = (s: string): string => `<code>${esc(s)}</code>`;

function htmlScenario(s: ScenarioReport, base: string): string {
  const info = dl([
    ['Scenario ID', code(s.id)],
    [
      'Priority',
      esc(s.priority ? cap(s.priority) : 'unknown') +
        (s.critical ? ' <span class="tag">critical flow</span>' : ''),
    ],
    [
      'Execution status',
      pill(s.status, STATUS_LABEL[s.status]) +
        (s.statusReason ? ` <span class="muted">${esc(s.statusReason)}</span>` : ''),
    ],
    [
      'Page / feature',
      (s.page ? code(s.page) : 'unknown') +
        (s.feature ? ` / ${esc(s.feature)}` : '') +
        (s.category ? ` (${esc(s.category)})` : ''),
    ],
    ...(s.issueId
      ? ([['Consolidated issue', `<a href="#${issueAnchor(s.issueId)}">${esc(s.issueId)}</a>`]] as Array<
          [string, string]
        >)
      : []),
  ]);
  const head = `<h3>${esc(s.id)}: ${esc(s.title)}</h3>${info}<h4>Scenario objective</h4><p>${esc(s.objective)}</p>`;
  if (s.status === 'passed') {
    return `<details class="scenario" id="${anchor(s.id)}"><summary>${pill('passed', 'Passed')} <strong>${esc(s.id)}</strong> ${esc(s.title)}</summary>${head}<h4>Verified</h4>${ul(s.verified.map(esc))}<p class="muted">Ran on ${esc(s.executions.map((e) => e.project).join(', '))}.</p></details>`;
  }
  if (s.status === 'blocked' || s.status === 'skipped') {
    return `<section class="scenario" id="${anchor(s.id)}">${head}<h4>Execution details</h4><p>${esc(s.statusReason ?? '')}</p></section>`;
  }
  const a = s.analysis;
  const failing = s.executions.filter((e) => e.status !== 'passed' && e.status !== 'skipped');
  const execHtml = failing
    .map((e) => {
      const steps =
        e.steps === null
          ? '<p class="muted">Execution steps not recorded for this result.</p>'
          : e.steps.length === 0
            ? '<p class="muted">The test has no named steps.</p>'
            : `<ol class="steps">${e.steps.map((st) => `<li class="${st.status}"><span aria-hidden="true">${st.status === 'failed' ? '✗' : '✓'}</span> ${esc(st.title)} <span class="muted">${st.durationMs} ms</span>${st.error ? `<div class="err">${esc(st.error)}</div>` : ''}</li>`).join('')}</ol>${e.failedStep ? '<p class="muted">Steps after the failed step did not run.</p>' : ''}`;
      return `${s.executions.length > 1 ? `<h5>${esc(e.project)}: ${esc(e.result)}</h5>` : ''}${steps}${dl([
        [
          'Failed step',
          esc(
            e.failedStep
              ? `${e.failedStep.index + 1}. ${[e.failedStep.title, ...e.failedStep.path].join(' › ')}`
              : (e.failurePoint ?? 'none'),
          ),
        ],
        ['Attempts', String(e.attempts)],
      ])}${e.error ? `<details><summary>Execution error${e.error.location ? ` at ${esc(e.error.location)}` : ''}</summary><pre>${esc(e.error.message.slice(0, 3000))}</pre>${e.error.snippet ? `<pre>${esc(e.error.snippet)}</pre>` : ''}</details>` : ''}`;
    })
    .join('');
  const expected = a?.expected ?? s.observed?.expected ?? 'unknown';
  const actual = a?.actual ?? s.observed?.actual ?? 'unknown';
  const difference = a?.difference ?? s.observed?.difference ?? 'unknown';
  const evidence = failing.flatMap((e) =>
    e.evidence.items.map(
      (i) =>
        `${s.executions.length > 1 ? `[${esc(e.project)}] ` : ''}${esc(i.label)}${i.path ? `: <a href="${esc(linkTo(base, i.path))}">${esc(path.posix.basename(i.path))}</a>` : ''}${i.detail ? `<div class="muted pre">${esc(i.detail)}</div>` : ''}`,
    ),
  );
  const missing = [
    ...new Set([...failing.flatMap((e) => e.evidence.missing), ...(a?.rootCause.missingEvidence ?? [])]),
  ];
  const analysis = !a
    ? '<p class="note">Not analyzed. Root cause unconfirmed. Run <code>npx ai-qa-agent triage</code> to diagnose this failure.</p>'
    : dl([
        [
          'Failure category',
          `${esc(a.categoryLabel)} <span class="muted">(${esc(CLASSIFICATION_LABEL[a.classification]!)}${a.method === 'rule' ? ', deterministic rule' : ''})</span>`,
        ],
        ['Failure point', esc(a.failurePoint)],
        ['Origin', esc(a.layer)],
        ['Root cause', esc(a.rootCause.statement)],
        ['Confidence', esc(confidenceText(a))],
        ...(a.severity ? ([['Bug severity', esc(cap(a.severity))]] as Array<[string, string]>) : []),
        ...(a.timing
          ? ([
              [
                'Timing / async',
                `${a.timing.suspected ? 'possible' : 'unlikely'}: ${esc(a.timing.explanation)}`,
              ],
            ] as Array<[string, string]>)
          : []),
      ]) +
      (a.rootCause.facts.length ? `<h5>Verified facts</h5>${ul(a.rootCause.facts.map(esc))}` : '') +
      (a.rootCause.hypotheses.length
        ? `<h5>Hypotheses (not verified)</h5>${ul(a.rootCause.hypotheses.map(esc))}`
        : '') +
      `<h5>Supporting evidence</h5>${ul(evidence)}` +
      (missing.length ? `<h5>Missing evidence</h5>${ul(missing.map(esc))}` : '') +
      (a.rootCause.investigation.length
        ? `<h5>Further investigation</h5>${ol(a.rootCause.investigation.map(esc))}`
        : '') +
      (a.engineNotes.length ? `<h5>Engine checks of this analysis</h5>${ul(a.engineNotes.map(esc))}` : '') +
      (s.otherAnalyses.length
        ? ul(
            s.otherAnalyses.map(
              (o) =>
                `Also failed on ${esc(o.project)}: ${esc(CLASSIFICATION_LABEL[o.classification]!)}, ${esc(o.summary)}`,
            ),
          )
        : '');
  const f = a?.fix;
  const fix = !f
    ? `<p class="note">${a?.legacy ? 'Triaged by an older version without a fix plan.' : 'No fix plan: the root cause is not established.'}</p>`
    : dl([
        [
          'Change',
          esc(f.target === 'investigate' ? 'investigate first (cause unconfirmed)' : `the ${f.target}`),
        ],
        [
          'Affected files',
          a!.rootCause.locations.length
            ? ul(
                a!.rootCause.locations.map(
                  (l) => `${code(loc(l))} <span class="muted">${esc(l.role)}: ${esc(l.note)}</span>`,
                ),
              )
            : 'not identified in verified code',
        ],
        ['Recommended fix', esc(f.summary)],
        ['Side effects', esc(f.sideEffects || 'none named')],
        ['Expected result', esc(f.expectedAfterFix)],
      ]) +
      `<h5>Required changes</h5>${ul(f.requiredChanges.map(esc))}` +
      (f.implementationSteps.length
        ? `<h5>Implementation steps</h5>${ol(f.implementationSteps.map(esc))}`
        : '') +
      (f.alternatives.length ? `<h5>Alternatives</h5>${ul(f.alternatives.map(esc))}` : '') +
      (a!.rejectedLocations.length
        ? `<p class="muted">Not found in the project and left out: ${esc(a!.rejectedLocations.map((r) => `${r.file}${r.line !== null ? `:${r.line}` : ''} (${r.reason})`).join(', '))}</p>`
        : '');
  return `<section class="scenario failed" id="${anchor(s.id)}">${head}
<h4>Execution details</h4>${s.steps.length ? `<details><summary>Scenario steps</summary>${ol(s.steps.map(esc))}</details>` : ''}${execHtml}
<h4>Expected vs. actual behavior</h4><div class="cmp"><div class="exp"><b>Expected</b><p>${esc(expected)}</p></div><div class="act"><b>Actual</b><p>${esc(actual)}</p></div></div><p><b>Difference:</b> ${esc(difference)}</p>
<h4>Failure analysis</h4>${analysis}
<h4>Bug fix plan</h4>${fix}
<h4>Acceptance criteria</h4>${ul(s.acceptanceCriteria.map(esc))}
<h4>Verification and regression tests</h4>${ul(s.verificationSteps.map(esc))}${s.regression.scenarioIds.length || s.regression.areas.length ? `<h5>Regression</h5>${ul([...s.regression.scenarioIds.map((id) => `<a href="#${anchor(id)}">${esc(id)}</a>`), ...s.regression.areas.map(esc)])}` : ''}
</section>`;
}

export function renderHtml(r: QaReport, base: string): string {
  const s = r.summary;
  const stat = (label: string, value: string | number, cls = ''): string =>
    `<div class="stat ${cls}"><span>${esc(label)}</span><b>${esc(String(value))}</b></div>`;
  const issue = (i: ConsolidatedIssue): string =>
    `<section class="issue" id="${issueAnchor(i.id)}"><h3>${i.rank}. ${esc(i.id)}: ${esc(i.title)}</h3>${dl([
      ['Kind', `${esc(KIND_LABEL[i.kind])} · ${esc(i.categoryLabel)}`],
      ...(i.severity ? ([['Severity', esc(cap(i.severity))]] as Array<[string, string]>) : []),
      ['Scenarios', i.scenarioIds.map((id) => `<a href="#${anchor(id)}">${esc(id)}</a>`).join(', ')],
      [
        'Root cause',
        `${esc(i.rootCause)} <span class="muted">(${esc(ROOT_STATUS[i.rootCauseStatus]!.toLowerCase())})</span>`,
      ],
      ...(i.locations.length
        ? ([['Locations', i.locations.map((l) => code(loc(l))).join(', ')]] as Array<[string, string]>)
        : []),
      ...(i.groupReason ? ([['Why grouped', esc(i.groupReason)]] as Array<[string, string]>) : []),
      ['Fix', i.fix ? esc(i.fix.summary) + ul(i.fix.requiredChanges.map(esc), '') : 'not established yet'],
      ...(i.dependsOn.length
        ? ([
            ['Depends on', i.dependsOn.map((d) => `<a href="#${issueAnchor(d)}">${esc(d)}</a>`).join(', ')],
          ] as Array<[string, string]>)
        : []),
      ...i.related.map(
        (x) =>
          ['Related', `<a href="#${issueAnchor(x.id)}">${esc(x.id)}</a> ${esc(x.reason)}`] as [
            string,
            string,
          ],
      ),
      ['Priority', esc(i.rankReason)],
      ...(i.kind === 'application'
        ? ([
            [
              'Bug tracker',
              i.tracker
                ? i.tracker.url
                  ? `<a href="${esc(i.tracker.url)}">${esc(i.tracker.taskId)}</a>`
                  : esc(i.tracker.taskId)
                : esc(
                    i.fileable
                      ? 'confirmed for filing, not logged yet'
                      : `not filed: ${i.notFiledReason ?? 'below the filing gates'}`,
                  ),
            ],
          ] as Array<[string, string]>)
        : []),
    ])}</section>`;
  const rows = r.scenarios
    .map(
      (x) =>
        `<tr><td><a href="#${anchor(x.id)}">${esc(x.id)}</a></td><td>${esc(x.title)}</td><td>${esc(x.priority ? cap(x.priority) : '—')}</td><td>${pill(x.status, STATUS_LABEL[x.status])}</td><td>${esc(x.analysis?.categoryLabel ?? (x.status === 'failed' || x.status === 'error' ? 'not analyzed' : '—'))}</td><td>${x.issueId ? `<a href="#${issueAnchor(x.issueId)}">${esc(x.issueId)}</a>` : '—'}</td></tr>`,
    )
    .join('');
  const evidenceRows = r.scenarios
    .flatMap((x) =>
      x.executions.map(
        (e) =>
          `<tr><td><a href="#${anchor(x.id)}">${esc(x.id)}</a></td><td>${esc(e.project)}</td><td>${esc(e.result)}</td><td>${e.attempts}</td><td>${
            e.evidence.items
              .filter((i) => i.path)
              .map((i) => `<a href="${esc(linkTo(base, i.path!))}">${esc(i.label)}</a>`)
              .join(', ') || '—'
          }</td><td>${esc(e.evidence.missing.join(', ') || '—')}</td></tr>`,
      ),
    )
    .join('');
  const failedFirst = [...r.scenarios].sort(
    (a, b) => Number(a.status === 'passed') - Number(b.status === 'passed'),
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA report ${esc(r.runId)}</title>
<style>
:root{--bg:#fff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--soft:#f8fafc;--pass:#15803d;--pass-bg:#f0fdf4;--fail:#b91c1c;--fail-bg:#fef2f2;--warn:#a16207;--warn-bg:#fefce8;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--soft:#111827;--pass:#4ade80;--pass-bg:#052e16;--fail:#f87171;--fail-bg:#3b0a0a;--warn:#facc15;--warn-bg:#2d2305;--accent:#60a5fa}}
*{box-sizing:border-box}body{font:15px/1.55 system-ui,sans-serif;background:var(--bg);color:var(--fg);max-width:1100px;margin:0 auto;padding:24px 16px}
a{color:var(--accent)}h1{margin:0 0 4px}h2{margin-top:2.5rem;border-bottom:1px solid var(--line);padding-bottom:6px}h3{margin:0 0 8px}h4{margin:1.2rem 0 .4rem}h5{margin:.8rem 0 .3rem;font-size:14px}
.muted{color:var(--muted)}.pre{white-space:pre-wrap}code{background:var(--soft);border:1px solid var(--line);padding:0 4px;border-radius:4px;font-size:13px;word-break:break-word}
pre{background:var(--soft);border:1px solid var(--line);padding:10px;border-radius:6px;overflow:auto;font-size:12px;white-space:pre-wrap}
nav ol{columns:2;gap:24px}@media (max-width:640px){nav ol{columns:1}}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:12px 0}.stat{border:1px solid var(--line);border-radius:8px;padding:10px}.stat span{display:block;color:var(--muted);font-size:13px}.stat b{font-size:22px}
.stat.pass b{color:var(--pass)}.stat.fail b{color:var(--fail)}.stat.warn b{color:var(--warn)}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:.6rem 0}td,th{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--soft)}
.pill{display:inline-block;border-radius:999px;padding:1px 10px;font-size:12px;font-weight:600;border:1px solid currentColor}
.st-passed{color:var(--pass)}.st-failed,.st-error{color:var(--fail)}.st-blocked,.st-skipped,.st-not-run{color:var(--warn)}
.tag{font-size:12px;border:1px solid var(--line);border-radius:4px;padding:0 6px}
.scenario,.issue{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:14px 0}.scenario.failed{border-left:4px solid var(--fail)}
details.scenario>summary{cursor:pointer}details.scenario[open]>summary{margin-bottom:10px}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:6px 0}.facts dt{color:var(--muted)}.facts dd{margin:0}.facts ul{margin:0;padding-left:18px}
@media (max-width:640px){.facts{grid-template-columns:1fr}.facts dd{margin-bottom:6px}}
.cmp{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}.cmp>div{border-radius:8px;padding:8px 12px}.cmp p{margin:4px 0 0}.exp{background:var(--pass-bg)}.act{background:var(--fail-bg)}
.steps li.failed{color:var(--fail)}.err{font-size:13px}.note{background:var(--warn-bg);border-radius:8px;padding:8px 12px}
.finding{border-left:4px solid var(--fail);padding:4px 10px;margin:8px 0}
</style></head><body>
<header><h1>QA report — ${esc(r.project)}</h1><p class="muted">Run ${code(r.runId)} against ${esc(r.target)} · generated ${esc(r.generatedAt.slice(0, 16).replace('T', ' '))} · AI cost $${r.aiCostUsd.toFixed(2)}</p></header>
<nav aria-label="Sections"><ol><li><a href="#summary">Executive summary</a></li><li><a href="#stats">Test execution statistics</a></li><li><a href="#critical">Critical findings</a></li><li><a href="#scenarios">Individual scenario reports</a></li><li><a href="#plan">Consolidated bug fix plan</a></li><li><a href="#priorities">Recommended fix priorities</a></li><li><a href="#regression">Regression testing</a></li><li><a href="#artifacts">Evidence and artifacts</a></li></ol></nav>
<h2 id="summary">1. Executive summary</h2><p>${esc(s.headline)}</p>
${!r.triaged && r.scenarios.some((x) => x.status === 'failed') ? '<p class="note">The failures of this run have not been analyzed by the AI. Run <code>npx ai-qa-agent triage</code> for root causes and fix plans.</p>' : ''}
${
  r.issues.length
    ? `<ol>${r.issues
        .slice(0, 5)
        .map(
          (i) =>
            `<li><a href="#${issueAnchor(i.id)}">${esc(i.id)}</a> ${esc(i.title)} — ${esc(KIND_LABEL[i.kind])}${i.severity ? `, ${esc(i.severity)}` : ''}. ${esc(i.rankReason)}</li>`,
        )
        .join('')}</ol>`
    : ''
}
<p class="muted">Failed scenarios by cause: ${s.findings.applicationScenarios} application, ${s.findings.testIssues} test implementation, ${s.findings.environmentIssues} environment, ${s.findings.unconfirmed + s.findings.intermittent} unconfirmed, ${s.findings.notAnalyzed} not analyzed.</p>
<h2 id="stats">2. Test execution statistics</h2>
<div class="stats">${stat('Scenarios', s.scenarios.total)}${stat('Passed', s.scenarios.passed, 'pass')}${stat('Failed', s.scenarios.failed, 'fail')}${stat('Errors', s.scenarios.error, 'fail')}${stat('Blocked', s.scenarios.blocked, 'warn')}${stat('Skipped', s.scenarios.skipped, 'warn')}${stat('Pass rate', pctText(s.passRate))}${stat('Pass rate of executed', pctText(s.executedPassRate))}</div>
<p class="muted">Pass rate = passed ÷ all scenarios of the run; blocked, skipped and errored scenarios count as not passed. Results per browser and viewport: ${s.results.total} (${s.results.passed} passed, ${s.results.failed} failed, ${s.results.flaky} flaky, ${s.results.skipped} skipped).${s.scenarios.notRun || s.scenarios.drafts ? ` Not part of this run: ${s.scenarios.notRun} approved scenario(s), ${s.scenarios.drafts} draft(s).` : ''}</p>
<div class="stats">${stat('Confirmed application bugs', s.findings.applicationBugs, 'fail')}${stat('Test implementation issues', s.findings.testIssues, 'warn')}${stat('Environment issues', s.findings.environmentIssues, 'warn')}${stat('Unconfirmed cause', s.findings.unconfirmed)}${stat('Flaky', s.findings.intermittent)}${stat('Not analyzed', s.findings.notAnalyzed)}</div>
<h2 id="critical">3. Critical findings</h2>
${r.criticalFindings.length ? r.criticalFindings.map((f) => `<div class="finding"><b>${esc(cap(f.level))}</b> — ${f.issueId ? `<a href="#${issueAnchor(f.issueId)}">${esc(f.issueId)}</a> ` : ''}${esc(f.title)}${f.detail ? `<div class="muted">${esc(f.detail)}</div>` : ''}</div>`).join('') : '<p class="muted">No critical findings.</p>'}
<h2 id="scenarios">4. Individual test scenario reports</h2>
<div class="table"><table><thead><tr><th>ID</th><th>Scenario</th><th>Priority</th><th>Status</th><th>Failure category</th><th>Issue</th></tr></thead><tbody>${rows}</tbody></table></div>
${failedFirst.map((x) => htmlScenario(x, base)).join('\n')}
${r.notRun.length ? `<h3>Not part of this run</h3>${ul(r.notRun.map((n) => `${code(n.id)} ${esc(n.title)} <span class="muted">${esc(n.page)}</span>`))}` : ''}
<h2 id="plan">5. Consolidated bug fix plan</h2>
${r.issues.length ? '<p class="muted">Failures are grouped only where a shared cause is verified. Every scenario keeps its own report above.</p>' + r.issues.map(issue).join('') : '<p class="muted">Nothing to fix.</p>'}
<h2 id="priorities">6. Recommended fix priorities</h2>
${r.issues.length ? `<div class="table"><table><thead><tr><th>#</th><th>Issue</th><th>Kind</th><th>Severity</th><th>Scenarios</th><th>Why this order</th></tr></thead><tbody>${r.issues.map((i) => `<tr><td>${i.rank}</td><td><a href="#${issueAnchor(i.id)}">${esc(i.id)}</a> ${esc(i.title)}</td><td>${esc(KIND_LABEL[i.kind])}</td><td>${esc(i.severity ? cap(i.severity) : '—')}</td><td>${i.scenarioIds.length}</td><td>${esc(i.rankReason)}${i.dependsOn.length ? ` Depends on ${esc(i.dependsOn.join(', '))}.` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing to prioritize.</p>'}
<h2 id="regression">7. Regression testing recommendations</h2>
${r.regression.length ? `<div class="table"><table><thead><tr><th>Scenario</th><th>Why</th><th>After fixing</th></tr></thead><tbody>${r.regression.map((g) => `<tr><td>${code(g.scenarioId)} ${esc(g.title)}</td><td>${esc(g.reasons.join('; '))}</td><td>${esc(g.issueIds.join(', '))}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">${r.issues.length ? 'Re-run the failed scenarios; no other scenario shares their page, feature or code.' : 'None needed.'}</p>`}
<h2 id="artifacts">8. Evidence and execution artifacts</h2>
<p>Evidence directory: ${code(r.artifacts.runDir)}</p>${r.artifacts.files.length ? ul(r.artifacts.files.map((f) => `${esc(f.label)}: <a href="${esc(linkTo(base, f.path))}">${esc(path.posix.basename(f.path))}</a>`)) : ''}
<div class="table"><table><thead><tr><th>Scenario</th><th>Browser / viewport</th><th>Result</th><th>Attempts</th><th>Captured</th><th>Missing</th></tr></thead><tbody>${evidenceRows}</tbody></table></div>
</body></html>
`;
}

/** The scenario modal: result details and evidence, writing and running its test, deleting it. */
import type { ScenarioRun } from '../../runner/rerun.js';
import type { WrittenTest } from '../../generate/scenario-test.js';
import { getJson, postJson } from './api.js';
import { load } from './app.js';
import { $, act, fileUrl, link, toast } from './dom.js';
import {
  esc,
  failingOutcome,
  failureFor,
  human,
  isFailing,
  issueFor,
  mediaDeleteLabel,
  outcomesFor,
  statusOf,
  type MediaWhat,
  type ScenarioView,
} from './logic.js';
import { action, typeChip } from './render.js';
import { state } from './state.js';

const modal = (): HTMLDialogElement => $<HTMLDialogElement>('#modal');
export const closeButton = (): string =>
  '<button type="button" class="ml-auto size-[34px] shrink-0 cursor-pointer rounded-full border-0 bg-line text-lg leading-none text-ink hover:bg-line-strong" ' +
  act('close-modal') +
  ' aria-label="Close">×</button>';

/** Is the modal showing this scenario's details (not the editor, not another scenario)? */
const showing = (id: string): boolean =>
  modal().open && modal().dataset.mode === 'view' && modal().dataset.id === id;

export function openModal(id: string, notice?: string): void {
  const { data } = state;
  const sc = data.scenarios.find((x) => x.id === id);
  if (!sc) return;
  const status = statusOf(data, id);
  const outs = outcomesFor(data, id);
  const m = modal();
  m.dataset.id = id;
  m.dataset.mode = 'view';
  m.dataset.notice = notice || '';
  let left = '',
    right = '';
  const section = (title: string, body: string) =>
    '<section class="mb-[22px]">' +
    (title ? '<h3 class="section-title">' + title + '</h3>' : '') +
    body +
    '</section>';
  if (notice)
    left += section(
      '',
      '<p class="m-0 rounded-lg bg-accent-soft px-3 py-2.5 text-sm font-semibold text-accent" role="status">' +
        esc(notice) +
        '</p>',
    );
  if (outs.length === 0)
    left += section(
      '',
      '<p class="m-0 text-base font-semibold">This scenario was not part of the selected run.</p>',
    );
  for (const o of outs) {
    const f = failureFor(data, o.key),
      issue = issueFor(data, o.key);
    if (o.rerunAt)
      left += section(
        '',
        '<p class="m-0 text-[13px] text-muted">Run on its own at ' +
          esc(new Date(o.rerunAt).toLocaleString()) +
          (o.status === 'passed' ? '' : '; not analyzed by the AI yet') +
          '.</p>',
      );
    if (outs.length > 1) left += '<h3 class="section-title">' + esc(o.project) + '</h3>';
    if (o.status === 'passed')
      left += section(
        '',
        '<p class="m-0 text-base font-semibold text-pass">Passed' +
          (o.attempts > 1 ? ' after ' + o.attempts + ' attempts' : '') +
          '.</p>',
      );
    if (f || issue) {
      left += section(
        'What happened',
        '<p class="mb-2 mt-0 text-base font-semibold">' +
          esc(issue ? issue.bug.title : f!.summary) +
          '</p>' +
          (f
            ? '<p class="m-0 text-sm text-muted">' +
              esc(human(f.classification)) +
              ' · ' +
              Math.round(f.confidence * 100) +
              '% confidence' +
              (issue ? ' · ' + esc(issue.bug.severity) + ' severity' : '') +
              '</p>'
            : '') +
          (issue
            ? '<p class="mt-2 mb-0 text-sm text-muted">Root cause: <code class="font-mono text-[12.5px] text-ink">' +
              esc(issue.bug.suspectedRootCause) +
              '</code></p>'
            : f?.testProblem
              ? '<p class="mt-2 mb-0 text-sm text-muted">Test problem: ' + esc(f.testProblem) + '</p>'
              : ''),
      );
      if (issue)
        left += section(
          'Expected vs actual',
          '<p class="mb-1.5 mt-0"><b>Expected</b> ' +
            esc(issue.bug.expectedResult) +
            '</p><p class="m-0"><b>Actual</b> ' +
            esc(issue.bug.actualResult) +
            '</p>',
        );
    } else if (o.status !== 'passed') {
      left += section(
        '',
        '<p class="m-0 text-base font-semibold">Failed; not analyzed yet (run <code class="font-mono text-[13px]">ai-qa-agent triage</code>).</p>',
      );
    }
    if (o.error)
      left += section(
        '',
        '<details class="disclosure"><summary>Test error</summary><pre class="mt-2.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 font-mono text-xs">' +
          esc(o.error.message) +
          '</pre></details>',
      );
    const a = o.artifacts;
    const slot = String(outs.indexOf(o));
    const media = (what: MediaWhat, file = ''): string => mediaArea({ id, key: o.key, what, file }, slot);
    if (a.screenshots[0] || a.video) {
      right += section(
        'Evidence' + (outs.length > 1 ? ' · ' + esc(o.project) : ''),
        (a.screenshots[0]
          ? '<a href="' +
            fileUrl(a.screenshots[0]) +
            '" target="_blank" rel="noopener"><img class="block max-w-full rounded-[10px] border border-line" loading="lazy" src="' +
            fileUrl(a.screenshots[0]) +
            '" alt="Final screenshot of ' +
            esc(o.key) +
            '"></a>' +
            media('screenshot', a.screenshots[0])
          : '') +
          (a.video
            ? '<video class="mt-3 block w-full rounded-[10px] bg-black" controls preload="metadata" src="' +
              fileUrl(a.video) +
              '"></video>' +
              media('video', a.video)
            : '') +
          (a.screenshots.length + (a.video ? 1 : 0) > 1 ? media('all') : '') +
          '<div class="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">' +
          link(a.trace, 'Trace') +
          link(a.logs, 'Console & network', true) +
          link(a.errorContext, 'Page snapshot', true) +
          a.design
            .map((d) =>
              link(d, (d.split('_design-').pop() ?? d).replace('.png', '').replace(/-/g, ' '), true),
            )
            .join('') +
          '</div>',
      );
    }
  }
  left += section(
    '',
    '<details class="disclosure"><summary>Scenario steps and expected results</summary><ol class="mt-2 list-decimal pl-5 text-sm">' +
      sc.steps.map((x) => '<li class="my-0.5">' + esc(x) + '</li>').join('') +
      '</ol>' +
      '<h3 class="section-title mt-3">Expected</h3><ul class="mt-2 list-disc pl-5 text-sm">' +
      sc.expectedResults.map((x) => '<li class="my-0.5">' + esc(x) + '</li>').join('') +
      '</ul></details>',
  );

  let foot = '';
  if (isFailing(status)) {
    foot = action(sc, status);
    const o = failingOutcome(data, sc);
    if (foot && o && !issueFor(data, o.key))
      foot +=
        '<span class="text-[13px] text-muted">Not confirmed as a product bug by the analyzer — the ' +
        data.tracker.noun +
        ' will be labelled needs-verification.</span>';
  }
  m.innerHTML =
    '<div class="flex items-start gap-4 border-b border-line px-5 pb-4 pt-5 md:px-6 md:pt-[22px]"><div class="min-w-0">' +
    '<span class="pill pill-' +
    status +
    '">' +
    (status === 'none' ? 'not run' : status) +
    '</span> ' +
    typeChip(sc) +
    '<h2 id="m-title" class="mb-1 mt-1.5 text-xl font-extrabold tracking-tight">' +
    esc(sc.title) +
    '</h2>' +
    '<div class="text-[13px] text-muted"><span class="font-mono text-[12.5px]">' +
    esc(sc.id) +
    '</span> · ' +
    esc(sc.page) +
    ' · ' +
    esc(sc.viewport) +
    ' · ' +
    esc(sc.priority) +
    ' priority</div></div>' +
    closeButton() +
    '</div>' +
    '<div class="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-auto px-5 py-5 md:grid-cols-[minmax(300px,1fr)_minmax(300px,1.25fr)] md:px-6"><div>' +
    left +
    '</div><div>' +
    right +
    '</div></div>' +
    '<div class="flex flex-wrap items-center gap-3 border-t border-line bg-bg px-5 py-3.5 md:px-6">' +
    testArea(sc) +
    foot +
    deleteArea(sc.id) +
    '</div>';
  if (!m.open) m.showModal();
}

/* ---------- write / run one scenario's test ---------- */
function testArea(sc: ScenarioView): string {
  if (!sc.approved) return '';
  const t = state.data.testStates[sc.id];
  const label = t === 'missing' ? 'Create test' : 'Rewrite test';
  const hint =
    t === 'missing'
      ? 'This scenario has no test yet.'
      : t === 'outdated'
        ? 'The scenario changed after its test was written.'
        : '';
  const ran = statusOf(state.data, sc.id) !== 'none';
  const run =
    t === 'missing'
      ? ''
      : '<button id="run-btn" class="' +
        (t ? 'btn-quiet' : ran ? 'btn btn-ghost' : 'btn') +
        '" ' +
        act('run-test', { id: sc.id }) +
        ' title="Run only this test with Playwright and update its result in this run">' +
        (ran ? 'Run again' : 'Run test') +
        '</button>';
  return (
    '<div id="test-area" class="flex flex-wrap items-center gap-2">' +
    (t ? '' : run) +
    '<button id="test-btn" class="' +
    (t ? 'btn' : 'btn-quiet') +
    '" ' +
    act('write-test', { id: sc.id }) +
    ' title="The AI writes only this scenario&#39;s test; the other tests in the file are not changed">' +
    label +
    '</button>' +
    (t ? run : '') +
    '<span id="test-status" class="text-[13px] text-muted" aria-live="polite">' +
    hint +
    '</span></div>'
  );
}

export async function writeTest(id: string): Promise<void> {
  const btn = $<HTMLButtonElement>('#test-btn');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Writing test…';
  $('#test-status').textContent =
    'The AI is writing the test and Playwright is checking it. This can take a few minutes.';
  const { ok, out } = await postJson<WrittenTest>('/api/scenarios/test', { id });
  const stillHere = showing(id);
  if (!ok) {
    if (stillHere) {
      btn.disabled = false;
      btn.textContent = state.data.testStates[id] === 'missing' ? 'Create test' : 'Rewrite test';
      $('#test-status').innerHTML =
        '<span class="text-fail">Could not write the test: ' + esc(out.error || 'unknown error') + '</span>';
    } else toast('Could not write the test for ' + id + ': ' + (out.error || 'unknown error'));
    return;
  }
  const done =
    (out.action === 'generated'
      ? 'Generated ' + out.file + ' with the tests of every scenario on ' + out.page
      : (out.action === 'added' ? 'Added the test for ' : 'Rewrote the test for ') + id + ' in ' + out.file) +
    '. Run ai-qa-agent test to execute it.';
  await load(state.data.run?.id);
  if (stillHere) openModal(id, done);
  else toast(done);
}

export async function runTest(btn: HTMLButtonElement, id: string): Promise<void> {
  if (btn.disabled) return;
  const label = btn.textContent;
  const inModal = !!btn.closest('#modal');
  btn.disabled = true;
  btn.textContent = 'Running…';
  if (inModal) $('#test-status').textContent = 'Playwright is running this test. This can take a minute.';
  const { ok, out } = await postJson<ScenarioRun>('/api/scenarios/run', { id, runId: state.data.run?.id });
  const modalHere = showing(id);
  if (!ok) {
    const msg = 'Could not run ' + id + ': ' + (out.error || 'unknown error');
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = label;
    }
    if (modalHere && $('#test-status'))
      $('#test-status').innerHTML = '<span class="text-fail">' + esc(msg) + '</span>';
    else toast(msg);
    return;
  }
  const summary =
    id +
    ' ' +
    out.outcomes.map((o) => o.status + (out.outcomes.length > 1 ? ' (' + o.project + ')' : '')).join(', ') +
    (out.merged ? '. Its result in this run was updated.' : '. Started a new run with it.');
  await load(out.runId);
  if (modalHere) openModal(id, summary);
  else toast(summary);
}

export async function fileBug(btn: HTMLButtonElement, body: Record<string, string>): Promise<void> {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Creating…';
  const { ok, out } = await postJson<{ reason?: string }>('/api/file', {
    runId: state.data.run?.id,
    ...body,
  });
  if (!ok) {
    btn.disabled = false;
    btn.textContent = label;
    alert(
      'Could not create the ' + state.data.tracker.noun + ': ' + (out.error || out.reason || 'unknown error'),
    );
    return;
  }
  const open = modal().open ? modal().dataset.id : null;
  await load(state.data.run?.id);
  if (open) openModal(open);
}

/* ---------- delete scenario (inline confirm in the modal footer) ---------- */
function deleteArea(id: string): string {
  return (
    '<div id="del-area" class="ml-auto flex flex-wrap items-center justify-end gap-2">' +
    '<button class="btn-quiet" ' +
    act('open-editor', { id }) +
    '>Edit scenario</button>' +
    '<button class="btn-quiet btn-quiet-danger" ' +
    act('ask-delete', { id }) +
    '>Delete scenario</button></div>'
  );
}

export function askDelete(id: string): void {
  const area = $('#del-area');
  area.innerHTML =
    '<span class="text-[13px] text-muted">Delete <span class="font-mono text-[12.5px] text-ink">' +
    esc(id) +
    '</span> and its test?</span>' +
    '<input id="del-reason" class="field w-48 py-[5px]" placeholder="Reason (optional)" aria-label="Reason for deleting (optional)" maxlength="200">' +
    '<button class="btn-quiet" ' +
    act('cancel-delete', { id }) +
    '>Cancel</button>' +
    '<button id="del-confirm" class="btn btn-danger" ' +
    act('confirm-delete', { id }) +
    '>Delete</button>' +
    '<p id="del-error" class="m-0 w-full text-right text-[13px] text-fail" role="alert"></p>';
  const input = $<HTMLInputElement>('#del-reason');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void confirmDelete(id);
  });
  input.focus();
}

export function cancelDelete(id: string): void {
  $('#del-area').outerHTML = deleteArea(id);
}

export async function confirmDelete(id: string): Promise<void> {
  const btn = $<HTMLButtonElement>('#del-confirm');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  const reason = $<HTMLInputElement>('#del-reason').value.trim();
  const { ok, out } = await postJson<{ spec?: string }>('/api/scenarios/delete', {
    id,
    reason: reason || undefined,
  });
  if (!ok) {
    btn.disabled = false;
    btn.textContent = 'Delete';
    $('#del-error').textContent = 'Could not delete: ' + (out.error || 'unknown error');
    return;
  }
  modal().close();
  await load(state.data.run?.id);
  toast(
    id +
      ' deleted' +
      (out.spec === 'test-removed' ? ' and its test removed' : '') +
      '. Undo: ai-qa-agent scenarios restore ' +
      id,
  );
}

/* ---------- delete a result's screenshot / video (inline confirm next to it) ---------- */
export interface MediaTarget {
  /** The scenario the modal shows. */
  id: string;
  /** The result (outcome key) the media belongs to. */
  key: string;
  what: MediaWhat;
  /** Project-relative path of the file; empty for `all`. */
  file: string;
}

const mediaArgs = (t: MediaTarget): Record<string, string> => ({ ...t });

function mediaButton(t: MediaTarget): string {
  return (
    '<button type="button" class="btn-quiet btn-quiet-danger" data-testid="media-delete-' +
    t.what +
    '" aria-label="' +
    esc(mediaDeleteLabel(t.what, t.key)) +
    '" ' +
    act('ask-media-delete', mediaArgs(t)) +
    '>' +
    (t.what === 'all' ? 'Delete all media' : 'Delete ' + t.what) +
    '</button>'
  );
}

function mediaArea(t: MediaTarget, slot: string): string {
  return (
    '<div id="media-del-' +
    slot +
    '-' +
    t.what +
    '" class="mt-1.5 flex flex-wrap items-center gap-2">' +
    mediaButton(t) +
    '</div>'
  );
}

const mediaAreaOf = (el: HTMLElement): HTMLElement | null => el.closest<HTMLElement>('[id^="media-del-"]');

export function askMediaDelete(el: HTMLElement, t: MediaTarget): void {
  const area = mediaAreaOf(el);
  if (!area) return;
  area.innerHTML =
    '<span class="text-[13px] text-muted">Delete ' +
    (t.what === 'all' ? 'all screenshots and the video' : 'this ' + t.what) +
    '? This cannot be undone.</span>' +
    '<button type="button" class="btn-quiet" data-testid="media-delete-cancel" ' +
    act('cancel-media-delete', mediaArgs(t)) +
    '>Cancel</button>' +
    '<button type="button" class="btn btn-danger" data-testid="media-delete-confirm" aria-label="' +
    esc('Confirm: ' + mediaDeleteLabel(t.what, t.key)) +
    '" ' +
    act('confirm-media-delete', mediaArgs(t)) +
    '>Delete</button>' +
    '<p class="m-0 w-full text-[13px] text-fail" role="alert"></p>';
  $<HTMLButtonElement>('[data-action="cancel-media-delete"]', area).focus();
}

export function cancelMediaDelete(el: HTMLElement, t: MediaTarget): void {
  const area = mediaAreaOf(el);
  if (area) area.innerHTML = mediaButton(t);
}

export async function confirmMediaDelete(btn: HTMLButtonElement, t: MediaTarget): Promise<void> {
  const runId = state.data.run?.id;
  if (btn.disabled || !runId) return;
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  const { ok, out } = await postJson<{ removed: string[] }>('/api/media/delete', {
    runId,
    key: t.key,
    file: t.what === 'all' ? undefined : t.file,
  });
  if (!ok) {
    const msg = 'Could not delete: ' + (out.error || 'unknown error');
    const alertEl = btn.isConnected ? mediaAreaOf(btn)?.querySelector('[role="alert"]') : null;
    if (alertEl) {
      btn.disabled = false;
      btn.textContent = 'Delete';
      alertEl.textContent = msg;
    } else toast(msg);
    return;
  }
  const done =
    (t.what === 'all' ? 'Deleted ' + out.removed.length + ' media files' : 'Deleted the ' + t.what) +
    ' of ' +
    t.key +
    '.';
  const stillHere = showing(t.id);
  await load(runId);
  if (stillHere) openModal(t.id, done);
  else toast(done);
}

/* ---------- bug-fix plan viewer ---------- */
export async function viewPlan(): Promise<void> {
  const run = state.data.run;
  if (!run) return;
  const { ok, out } = await getJson<{ file: string; text: string }>(
    '/api/plan?run=' + encodeURIComponent(run.id),
  );
  if (!ok) {
    toast(out.error || 'Could not open the plan.');
    return;
  }
  const m = modal();
  m.dataset.id = '';
  m.dataset.mode = 'plan';
  m.innerHTML =
    '<div class="flex items-start gap-4 border-b border-line px-5 pb-4 pt-5 md:px-6 md:pt-[22px]"><div class="min-w-0">' +
    '<h2 id="m-title" class="m-0 text-xl font-extrabold tracking-tight">Bug-fix plan</h2>' +
    '<p class="m-0 mt-1 font-mono text-[12.5px] text-muted">' +
    esc(out.file) +
    '</p></div>' +
    closeButton() +
    '</div>' +
    '<pre class="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-5 py-5 font-mono text-[12.5px] leading-relaxed md:px-6">' +
    esc(out.text) +
    '</pre>';
  if (!m.open) m.showModal();
}

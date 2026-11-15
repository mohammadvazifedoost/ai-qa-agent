/**
 * What the buttons of a scenario's detail and a defect do: write and run one test, create the
 * tracker item, remove the scenario, delete a result's media. Each reloads the data when it is done
 * and says what happened in the detail it was started from (or in a toast if the user moved on).
 */
import type { ScenarioRun } from '../../runner/rerun.js';
import type { WrittenTest } from '../../generate/scenario-test.js';
import { postJson } from './api.js';
import { load } from './app.js';
import { $, act, toast } from './dom.js';
import { esc, mediaDeleteLabel } from './logic.js';
import { render } from './render.js';
import { deleteArea, mediaArgs, mediaButton, shownScenario, type MediaTarget } from './scenarios.js';
import { go, state } from './state.js';

/** Is this scenario's detail on screen? */
const showing = (id: string): boolean => shownScenario() === id;

/** Say what happened: in the scenario's detail while it is shown, else in a toast. */
function report(id: string, text: string, wasShowing: boolean): void {
  if (wasShowing && state.data.scenarios.some((s) => s.id === id)) {
    state.notice = { id, text };
    render();
  } else toast(text);
}

export async function writeTest(id: string): Promise<void> {
  const btn = $<HTMLButtonElement>('#test-btn');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Writing test…';
  $('#test-status').textContent =
    'The AI is writing the test and Playwright is checking it. This can take a few minutes.';
  const { ok, out } = await postJson<WrittenTest>('/api/scenarios/test', { id });
  const here = showing(id);
  if (!ok) {
    const msg = 'Could not write the test for ' + id + ': ' + (out.error || 'unknown error');
    if (here && btn.isConnected) {
      btn.disabled = false;
      btn.textContent = state.data.testStates[id] === 'missing' ? 'Create test' : 'Rewrite test';
      $('#test-status').innerHTML = '<span class="text-fail-ink">' + esc(msg) + '</span>';
    } else toast(msg);
    return;
  }
  const done =
    (out.action === 'generated'
      ? 'Generated ' + out.file + ' with the tests of every scenario on ' + out.page
      : (out.action === 'added' ? 'Added the test for ' : 'Rewrote the test for ') + id + ' in ' + out.file) +
    '. Select Run this test to execute it.';
  await load(state.data.run?.id);
  report(id, done, here);
}

export async function runTest(btn: HTMLButtonElement, id: string): Promise<void> {
  if (btn.disabled) return;
  const text = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Running…';
  const status = $('#test-status');
  if (status) status.textContent = 'Playwright is running this test. This can take a minute.';
  const { ok, out } = await postJson<ScenarioRun>('/api/scenarios/run', { id, runId: state.data.run?.id });
  const here = showing(id);
  if (!ok) {
    const msg = 'Could not run ' + id + ': ' + (out.error || 'unknown error');
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = text;
    }
    if (here && $('#test-status'))
      $('#test-status').innerHTML = '<span class="text-fail-ink">' + esc(msg) + '</span>';
    else toast(msg);
    return;
  }
  const summary =
    id +
    ' ' +
    out.outcomes.map((o) => o.status + (out.outcomes.length > 1 ? ' (' + o.project + ')' : '')).join(', ') +
    (out.merged ? '. Its result in this run was updated.' : '. Started a new run with it.');
  await load(out.runId);
  report(id, summary, here);
}

export async function fileBug(btn: HTMLButtonElement, body: Record<string, string>): Promise<void> {
  const text = btn.textContent;
  const { tracker } = state.data;
  btn.disabled = true;
  btn.textContent = 'Creating…';
  const { ok, out } = await postJson<{ reason?: string; taskId?: string }>('/api/file', {
    runId: state.data.run?.id,
    ...body,
  });
  if (!ok) {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = text;
    }
    toast('Could not create the ' + tracker.noun + ': ' + (out.error || out.reason || 'unknown error'));
    return;
  }
  await load(state.data.run?.id);
  toast('Created ' + tracker.noun + (out.taskId ? ' ' + out.taskId : '') + ' in ' + tracker.name + '.');
}

/* ---------- remove a scenario (inline confirm in its detail) ---------- */
export function askDelete(id: string): void {
  const area = $('#del-area');
  area.innerHTML =
    '<span class="basis-full text-ink-2">Remove <span class="font-mono text-[13px]">' +
    esc(id) +
    '</span> and its test?</span>' +
    '<input id="del-reason" class="field min-w-0 flex-[1_1_160px]" placeholder="Reason (optional)" aria-label="Reason for removing (optional)" maxlength="200">' +
    '<button type="button" class="btn" ' +
    act('cancel-delete', { id }) +
    '>Cancel</button>' +
    '<button type="button" id="del-confirm" class="btn btn-danger" ' +
    act('confirm-delete', { id }) +
    '>Remove</button>' +
    '<p id="del-error" class="m-0 basis-full text-[13px] text-fail-ink" role="alert"></p>';
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
  btn.textContent = 'Removing…';
  const reason = $<HTMLInputElement>('#del-reason').value.trim();
  const { ok, out } = await postJson<{ spec?: string }>('/api/scenarios/delete', {
    id,
    reason: reason || undefined,
  });
  if (!ok) {
    btn.disabled = false;
    btn.textContent = 'Remove';
    $('#del-error').textContent = 'Could not remove it: ' + (out.error || 'unknown error');
    return;
  }
  await load(state.data.run?.id);
  if (state.route.page === 'scenarios' && state.route.id === id) go('scenarios');
  toast(
    id +
      ' removed' +
      (out.spec === 'test-removed' ? ' with its test' : '') +
      '. Undo: ai-qa-agent scenarios restore ' +
      id,
  );
}

/* ---------- delete a result's screenshot / video (inline confirm next to it) ---------- */
const mediaAreaOf = (el: HTMLElement): HTMLElement | null => el.closest<HTMLElement>('[id^="media-del-"]');

export function askMediaDelete(el: HTMLElement, t: MediaTarget): void {
  const area = mediaAreaOf(el);
  if (!area) return;
  area.innerHTML =
    '<span class="text-ink-2">Delete ' +
    (t.what === 'all' ? 'all screenshots and videos' : 'this ' + t.what) +
    '? This cannot be undone.</span>' +
    '<button type="button" class="btn" data-testid="media-delete-cancel" ' +
    act('cancel-media-delete', mediaArgs(t)) +
    '>Cancel</button>' +
    '<button type="button" class="btn btn-danger" data-testid="media-delete-confirm" aria-label="' +
    esc('Confirm: ' + mediaDeleteLabel(t.what, t.key, t.page)) +
    '" ' +
    act('confirm-media-delete', mediaArgs(t)) +
    '>Delete</button>' +
    '<p class="m-0 basis-full text-[13px] text-fail-ink" role="alert"></p>';
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
  const here = showing(t.id);
  await load(runId);
  report(t.id, done, here);
}

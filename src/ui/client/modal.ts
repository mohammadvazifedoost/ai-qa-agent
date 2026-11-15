/** The dialog: its close button and the bug-fix plan viewer. The scenario form is in editor.ts. */
import { getJson, postJson } from './api.js';
import { $, act, toast } from './dom.js';
import { esc, formatBytes, plural, runCleanupChoices, runCounts, runLabel } from './logic.js';
import { state } from './state.js';

const modal = (): HTMLDialogElement => $<HTMLDialogElement>('#modal');

export const closeButton = (): string =>
  '<button type="button" class="btn btn-text ml-auto size-11 shrink-0 px-0 text-xl leading-none" ' +
  act('close-modal') +
  ' aria-label="Close">×</button>';

export const modalHeader = (title: string, sub: string): string =>
  '<div class="flex items-start gap-4 border-b border-line px-5 pb-4 pt-5 md:px-6"><div class="min-w-0">' +
  '<h2 id="m-title" class="m-0 font-display text-xl font-bold tracking-tight">' +
  title +
  '</h2><p class="m-0 mt-1 text-[13px] text-muted">' +
  sub +
  '</p></div>' +
  closeButton() +
  '</div>';

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
    modalHeader('Fix plan', '<span class="font-mono break-all">' + esc(out.file) + '</span>') +
    '<pre class="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-5 py-5 font-mono text-[13px] leading-relaxed md:px-6" tabindex="0">' +
    esc(out.text) +
    '</pre>';
  if (!m.open) m.showModal();
}

/** The dialog that deletes old runs: a checklist, newest first, the latest one kept by default. */
export function openRunCleanup(): void {
  const { data } = state;
  const busy = data.job?.status === 'running' ? (data.job.runId ?? null) : null;
  const choices = runCleanupChoices(data.runs, busy);
  const m = modal();
  m.dataset.id = '';
  m.dataset.mode = 'runs';
  const rows = choices
    .map((c) => {
      const r = data.runs.find((x) => x.id === c.id)!;
      return (
        '<li class="border-t border-divider"><label class="flex min-h-11 cursor-pointer items-center gap-3 px-5 py-2.5 md:px-6' +
        (c.locked ? ' cursor-not-allowed opacity-60' : '') +
        '"><input type="checkbox" class="size-4 shrink-0" name="run" value="' +
        esc(c.id) +
        '"' +
        (c.selected ? ' checked' : '') +
        (c.locked ? ' disabled' : '') +
        '><span class="flex min-w-0 flex-1 flex-col leading-snug"><span class="font-semibold">' +
        esc(runLabel(c.id)) +
        (c.latest ? '<span class="ml-2 text-xs font-semibold text-accent">Latest</span>' : '') +
        (c.id === data.run?.id
          ? '<span class="ml-2 text-xs font-semibold text-muted">Shown now</span>'
          : '') +
        '</span><span class="text-[13px] text-muted">' +
        esc(c.locked ? 'In use by the running job' : runCounts(r.stats)) +
        '</span></span></label></li>'
      );
    })
    .join('');
  m.innerHTML =
    modalHeader(
      'Delete old runs',
      'Removes each run’s results, screenshots, videos, traces and report. Scenarios, tests, fix plans and bug-tracker items are kept.',
    ) +
    '<form id="run-cleanup" class="flex min-h-0 flex-1 flex-col">' +
    '<ul class="m-0 min-h-0 flex-1 list-none overflow-auto p-0" aria-label="Runs">' +
    rows +
    '</ul><div id="run-cleanup-actions" class="flex flex-wrap items-center gap-3 border-t border-line px-5 py-4 md:px-6">' +
    runCleanupActions() +
    '</div></form>';
  if (!m.open) m.showModal();
}

const selectedRuns = (): string[] =>
  [...document.querySelectorAll<HTMLInputElement>('#run-cleanup input[name="run"]:checked')].map(
    (i) => i.value,
  );

function runCleanupActions(): string {
  return (
    '<button type="button" class="btn btn-text" ' +
    act('runs-select', { which: 'old' }) +
    '>Select all but the latest</button>' +
    '<button type="button" class="btn btn-text" ' +
    act('runs-select', { which: 'none' }) +
    '>Clear</button>' +
    '<button type="button" class="btn btn-danger ml-auto" ' +
    act('ask-runs-delete') +
    '>Delete selected runs</button>'
  );
}

export function selectRuns(which: string): void {
  const boxes = [...document.querySelectorAll<HTMLInputElement>('#run-cleanup input[name="run"]')];
  boxes.forEach((b, i) => {
    if (!b.disabled) b.checked = which === 'old' && i > 0;
  });
}

/** Second step: say exactly what goes, then delete. */
export function askRunsDelete(): void {
  const ids = selectedRuns();
  const area = $('#run-cleanup-actions');
  if (!ids.length) {
    toast('Select at least one run.');
    return;
  }
  area.innerHTML =
    '<p class="m-0 flex-1 font-semibold">Delete ' +
    plural(ids.length, 'run') +
    (ids.length === 1 ? ' and its evidence' : ' and all their evidence') +
    '? This cannot be undone.</p>' +
    '<button type="button" class="btn" ' +
    act('cancel-runs-delete') +
    '>Cancel</button>' +
    '<button type="button" class="btn btn-danger" ' +
    act('confirm-runs-delete') +
    '>Delete ' +
    plural(ids.length, 'run') +
    '</button>';
  $<HTMLButtonElement>('[data-action="cancel-runs-delete"]', area).focus();
}

export function cancelRunsDelete(): void {
  $('#run-cleanup-actions').innerHTML = runCleanupActions();
}

export async function confirmRunsDelete(
  btn: HTMLButtonElement,
  reload: (runId?: string) => Promise<void>,
): Promise<void> {
  if (btn.disabled) return;
  const ids = selectedRuns();
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  const { ok, out } = await postJson<{ deleted: string[]; freedBytes: number; error?: string }>(
    '/api/runs/delete',
    { ids },
  );
  if (!ok) {
    toast(out.error || 'Could not delete the runs.');
    cancelRunsDelete();
    return;
  }
  modal().close();
  const shown = state.data.run?.id;
  await reload(shown && !out.deleted.includes(shown) ? shown : undefined);
  toast('Deleted ' + plural(out.deleted.length, 'run') + ', freed ' + formatBytes(out.freedBytes) + '.');
}

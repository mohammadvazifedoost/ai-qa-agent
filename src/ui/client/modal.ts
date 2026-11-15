/** The dialog: its close button and the bug-fix plan viewer. The scenario form is in editor.ts. */
import { getJson } from './api.js';
import { $, act, toast } from './dom.js';
import { esc } from './logic.js';
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

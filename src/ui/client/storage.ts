/**
 * The Storage page: how much space the QA data takes, and freeing what is no longer needed —
 * Playwright's raw output, logs, leftover folders and, if asked, old runs. Scenarios, tests,
 * config, fix plans and bug-tracker records are never touched.
 */
import type { CleanupKind, StorageReport } from '../../runner/storage.js';
import { getJson, postJson } from './api.js';
import { load } from './app.js';
import { act, toast } from './dom.js';
import { cleanupBytes, esc, formatBytes, plural } from './logic.js';
import { render } from './render.js';
import { state } from './state.js';
import { pageHeading as h1 } from './ui.js';

const TEXT: Record<CleanupKind, [title: string, what: string]> = {
  'raw-output': [
    'Raw test output',
    'Playwright’s own output folder in each run. The screenshots, videos and traces you see here are copies taken from it, so nothing is lost.',
  ],
  logs: [
    'Logs and AI transcripts',
    'The agent’s log, the AI conversations and the app-server log. Only useful to debug the agent itself.',
  ],
  leftovers: [
    'Leftover folders',
    'Run and report folders that no run points at any more (an interrupted run, for example) and test output from runs started outside the agent.',
  ],
  'old-runs': [
    'Old runs',
    'Every run except the latest, with its results, screenshots, videos, traces and report. Their history disappears from the run picker.',
  ],
};

/** Safe to free without losing anything a page shows: ticked when the page opens. */
const SAFE: readonly CleanupKind[] = ['raw-output', 'logs', 'leftovers'];

export async function loadStorage(): Promise<void> {
  const { ok, out } = await getJson<StorageReport>('/api/storage');
  state.storage = ok ? out : null;
  state.storageError = ok
    ? ''
    : 'Could not measure the storage: ' + (out.error || 'no answer from the server') + '.';
  if (ok && !state.storagePick) state.storagePick = new Set(SAFE.filter((k) => size(k) > 0));
  if (state.route.page === 'storage') render();
}

const item = (kind: CleanupKind) => state.storage?.items.find((i) => i.kind === kind);
const size = (kind: CleanupKind): number => item(kind)?.bytes ?? 0;
const picked = (): Set<CleanupKind> => (state.storagePick ??= new Set());

export function toggleStorageKind(kind: string, on: boolean): void {
  if (!(kind in TEXT)) return;
  if (on) picked().add(kind as CleanupKind);
  else picked().delete(kind as CleanupKind);
  state.storageConfirm = false;
  render();
}

function row(kind: CleanupKind): string {
  const it = item(kind);
  const bytes = it?.bytes ?? 0;
  const empty = bytes === 0;
  const [title, what] = TEXT[kind];
  const extra =
    kind === 'old-runs' && it?.runs
      ? it.runs.length
        ? ' <span class="text-muted">(' + plural(it.runs.length, 'run') + ')</span>'
        : ' <span class="text-muted">(only the latest run is left)</span>'
      : '';
  return (
    '<li class="border-t border-divider first:border-t-0"><label class="flex cursor-pointer items-start gap-3 px-5 py-4' +
    (empty ? ' cursor-not-allowed opacity-60' : '') +
    '"><input type="checkbox" class="mt-1 size-4 shrink-0" data-storage-kind="' +
    kind +
    '"' +
    (picked().has(kind) && !empty ? ' checked' : '') +
    (empty ? ' disabled' : '') +
    '><span class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="font-semibold">' +
    title +
    extra +
    '</span><span class="text-[13px] text-muted">' +
    what +
    '</span></span><span class="shrink-0 font-semibold tabular-nums ' +
    (empty ? 'text-muted' : 'text-ink') +
    '">' +
    (empty ? 'Empty' : formatBytes(bytes)) +
    '</span></label></li>'
  );
}

function actions(report: StorageReport): string {
  const kinds = [...picked()].filter((k) => size(k) > 0);
  const bytes = cleanupBytes(report.items, new Set(kinds));
  if (report.busy) return '<p class="m-0 text-ink-2">A job is running. Clean up once it has finished.</p>';
  if (state.storageConfirm)
    return (
      '<p class="m-0 flex-1 font-semibold">Free ' +
      formatBytes(bytes) +
      (kinds.includes('old-runs')
        ? ', deleting ' + plural(item('old-runs')?.runs?.length ?? 0, 'old run')
        : '') +
      '? This cannot be undone.</p>' +
      '<button type="button" class="btn" ' +
      act('storage-cancel') +
      '>Cancel</button>' +
      '<button type="button" class="btn btn-danger" ' +
      act('storage-clean') +
      (state.storageBusy ? ' disabled' : '') +
      '>' +
      (state.storageBusy ? 'Cleaning…' : 'Free ' + formatBytes(bytes)) +
      '</button>'
    );
  return (
    '<p class="m-0 flex-1 text-ink-2">' +
    (kinds.length ? 'Selected: <strong>' + formatBytes(bytes) + '</strong>' : 'Nothing selected.') +
    '</p><button type="button" class="btn btn-danger" ' +
    act('storage-ask') +
    (kinds.length ? '' : ' disabled') +
    '>Free up space</button>'
  );
}

export function storagePage(banner: string): string {
  const report = state.storage;
  const heading = h1(
    'Storage',
    'What the QA data takes on this computer, and clearing what is no longer needed. Scenarios, tests, config, fix plans and bug-tracker items are always kept.',
  );
  const top = heading + (banner ? '<div class="max-w-[820px]">' + banner + '</div>' : '');
  if (!report)
    return (
      top +
      '<p class="m-0 ' +
      (state.storageError ? 'text-fail-ink' : 'text-muted') +
      '">' +
      esc(state.storageError || 'Measuring…') +
      '</p>'
    );
  const cleanable = cleanupBytes(report.items, new Set(report.items.map((i) => i.kind)));
  return (
    top +
    '<div class="flex max-w-[820px] flex-col gap-6">' +
    '<section aria-labelledby="usage-h" class="panel flex flex-wrap gap-x-10 gap-y-3 p-5">' +
    '<h2 id="usage-h" class="sr-only">Usage</h2>' +
    '<div class="flex flex-col"><span class="text-[13px] text-muted">QA data in <code>.qa/</code></span><span class="font-display text-[28px] font-bold tabular-nums">' +
    formatBytes(report.totalBytes) +
    '</span></div>' +
    '<div class="flex flex-col"><span class="text-[13px] text-muted">Can be freed</span><span class="font-display text-[28px] font-bold tabular-nums">' +
    formatBytes(cleanable) +
    '</span></div></section>' +
    '<section aria-labelledby="clean-h" class="panel flex flex-col">' +
    '<div class="flex flex-col gap-1 px-5 pt-5 pb-3"><h2 id="clean-h" class="h-section">Clear cache and unneeded data</h2>' +
    '<p class="m-0 text-[13px] text-muted">The first three never remove anything the dashboard shows. Old runs are only deleted if you tick them.</p></div>' +
    '<ul class="m-0 list-none border-t border-divider p-0">' +
    (['raw-output', 'logs', 'leftovers', 'old-runs'] as const).map(row).join('') +
    '</ul><div class="flex flex-wrap items-center gap-3 border-t border-line px-5 py-4">' +
    actions(report) +
    '</div></section></div>'
  );
}

export function askStorageClean(): void {
  state.storageConfirm = true;
  render();
}

export function cancelStorageClean(): void {
  state.storageConfirm = false;
  render();
}

export async function confirmStorageClean(): Promise<void> {
  if (state.storageBusy) return;
  const kinds = [...picked()].filter((k) => size(k) > 0);
  if (!kinds.length) return;
  state.storageBusy = true;
  render();
  const { ok, out } = await postJson<{
    freedBytes: number;
    deletedRuns: string[];
    storage: StorageReport;
  }>('/api/storage/clean', { kinds });
  state.storageBusy = false;
  state.storageConfirm = false;
  if (!ok) {
    toast(out.error || 'Could not clean up.');
    return render();
  }
  state.storage = out.storage;
  state.storagePick = new Set(SAFE.filter((k) => size(k) > 0));
  toast(
    'Freed ' +
      formatBytes(out.freedBytes) +
      (out.deletedRuns.length ? ', deleted ' + plural(out.deletedRuns.length, 'old run') : '') +
      '.',
  );
  // Deleted runs leave the run picker; the run shown may be one of them.
  if (out.deletedRuns.length) {
    const shown = state.data.run?.id;
    await load(shown && !out.deletedRuns.includes(shown) ? shown : undefined);
  } else render();
}

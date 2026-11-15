/**
 * Whole runs, the fix plan and the AI steps of the Project page run as background jobs on the
 * server; the page polls until they are done.
 */
import type { Job } from '../server.js';
import { getJson, postJson } from './api.js';
import { load, loadTrackers } from './app.js';
import { toast } from './dom.js';
import { render } from './render.js';
import { state } from './state.js';

let jobTimer: ReturnType<typeof setTimeout> | undefined;

export async function startJob(url: string, extra: Record<string, unknown> = {}): Promise<void> {
  const { ok, out } = await postJson<Job>(url, { runId: state.data.run?.id, ...extra });
  if (!ok) {
    toast(out.error || 'Could not start it.');
    return;
  }
  state.data.job = out;
  watchJob();
}

export function watchJob(): void {
  state.watched = state.data.job?.startedAt ?? null;
  render();
  clearTimeout(jobTimer);
  jobTimer = setTimeout(pollJob, 2000);
}

async function pollJob(): Promise<void> {
  // A failed request (server restarting) is simply tried again.
  const { ok, out } = await getJson<{ job: Job | null }>('/api/job');
  const j = ok ? out.job : null;
  if (j && j.status !== 'running') {
    // A finished full run is shown; other jobs updated the run being viewed (or started one).
    // After a cancel or failure nothing changed, so the current run stays.
    await load(
      j.status === 'done'
        ? j.kind === 'run-all' || j.kind === 'run-critical'
          ? j.runId
          : (j.runId ?? state.data.run?.id)
        : state.data.run?.id,
    );
    state.watched = j.startedAt;
    render();
    return;
  }
  // Still running: show what it is doing now (e.g. which page is being written).
  if (j && j.startedAt === state.watched && j.detail !== state.data.job?.detail) {
    state.data.job = j;
    render();
  }
  jobTimer = setTimeout(pollJob, 2000);
}

export async function cancelJob(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Cancelling…';
  const { ok, out } = await postJson<Job>('/api/job/cancel', {});
  // The next poll shows the outcome; only a refusal needs saying now.
  if (!ok) {
    btn.disabled = false;
    btn.textContent = 'Cancel';
    toast(out.error || 'Could not cancel.');
  }
}

export function createPlan(): void {
  const pl = state.data.plan;
  if (!pl) return;
  if (pl.exists && !confirm('Overwrite ' + pl.file + '? Any edits made to it will be lost.')) return;
  void startJob('/api/plan', { force: pl.exists });
}

export async function refreshAll(btn: HTMLButtonElement): Promise<void> {
  // The top bar is drawn again when the data arrives, which resets the button.
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.setAttribute('aria-label', 'Refreshing…');
  await load(state.data.run?.id);
  await loadTrackers(true);
}

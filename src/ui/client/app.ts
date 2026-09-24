/** Loading the overview and the follow-up requests that fill it in after the first paint. */
import type { TaskLink } from '../server.js';
import type { TrackerStatus } from '../../integrations/tracker.js';
import { getJson, getOverview } from './api.js';
import { $ } from './dom.js';
import { watchJob } from './jobs.js';
import { statusOf } from './logic.js';
import { openModal } from './modal.js';
import { action, render, renderTrackers } from './render.js';
import { state } from './state.js';

export async function load(runId?: string): Promise<void> {
  state.data = await getOverview(runId);
  render();
  void loadTrackers(false);
  if (state.data.job?.status === 'running') watchJob();
  // Tracker verification happens after the first paint so the page never waits for it.
  const run = state.data.run;
  if (run?.tasksPending) {
    const id = run.id;
    const { ok, out } = await getJson<{ tasks: Record<string, TaskLink> }>(
      '/api/tasks?run=' + encodeURIComponent(id),
    );
    const current = state.data.run;
    if (current && current.id === id) {
      current.tasks = ok ? out.tasks || {} : {};
      current.tasksPending = false;
      refreshActions();
    }
  }
}

/** Re-render only the action cells (and the open modal's footer) once the tracker answered. */
function refreshActions(): void {
  for (const cell of document.querySelectorAll<HTMLElement>('[data-action-for]')) {
    const sc = state.data.scenarios.find((x) => x.id === cell.dataset.actionFor);
    if (sc) cell.innerHTML = action(sc, statusOf(state.data, sc.id));
  }
  const modal = $<HTMLDialogElement>('#modal');
  if (modal.open && modal.dataset.mode === 'view') openModal(modal.dataset.id ?? '', modal.dataset.notice);
}

export async function loadTrackers(fresh: boolean): Promise<void> {
  const { ok, out } = await getJson<{ trackers: TrackerStatus[] }>(
    '/api/trackers' + (fresh ? '?fresh=1' : ''),
  );
  state.trackers = ok ? out.trackers : null;
  renderTrackers();
}

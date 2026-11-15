/** Loading the overview and the follow-up requests that fill it in after the first paint. */
import type { TaskLink } from '../server.js';
import type { TrackerStatus } from '../../integrations/tracker.js';
import type { TrackerSettings } from '../tracker-setup.js';
import { getJson, getOverview } from './api.js';
import type { Project } from './logic.js';
import { watchJob } from './jobs.js';
import { render } from './render.js';
import { state } from './state.js';
import { loadStorage } from './storage.js';

export async function load(runId?: string): Promise<void> {
  state.data = await getOverview(runId);
  render();
  void loadTrackers(false);
  void loadProject();
  void loadTrackerSettings();
  if (state.route.page === 'storage') void loadStorage();
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
      render();
    }
  }
}

/** What is analyzed and what is out of date (compares files; never calls the AI). */
export async function loadProject(): Promise<void> {
  const { ok, out } = await getJson<Project>('/api/project');
  if (ok) state.project = out;
  state.projectError = ok
    ? ''
    : 'Could not check the project: ' + (out.error || 'no answer from the server') + '.';
  render();
}

/** What the Bug tracker form starts from (never a token, only whether one is saved). */
export async function loadTrackerSettings(): Promise<void> {
  const { ok, out } = await getJson<TrackerSettings>('/api/tracker');
  if (!ok) return;
  // The form was drawn before the settings arrived: start it again from them.
  if (!state.trackerSettings) state.trackerDraft = null;
  state.trackerSettings = out;
  if (state.route.page === 'tracker') render();
}

export async function loadTrackers(fresh: boolean): Promise<void> {
  const { ok, out } = await getJson<{ trackers: TrackerStatus[] }>(
    '/api/trackers' + (fresh ? '?fresh=1' : ''),
  );
  state.trackers = ok ? out.trackers : null;
  // The menu badge and the Bug tracker page depend on it too.
  render();
}

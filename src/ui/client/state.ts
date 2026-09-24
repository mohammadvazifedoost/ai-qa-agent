/** Shared, mutable page state: the loaded overview, the list filters and what the rail shows. */
import type { TrackerStatus } from '../../integrations/tracker.js';
import type { Data, View } from './logic.js';

export const state = {
  /** The last /api/overview answer; set before the first render. */
  data: null as unknown as Data,
  view: { page: '', only: 'all', type: '', q: '' } as View,
  trackers: null as TrackerStatus[] | null,
  /** The job this page started or saw running; its outcome is shown until dismissed. */
  watched: null as string | null,
};

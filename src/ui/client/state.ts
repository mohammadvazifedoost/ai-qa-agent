/** Shared, mutable page state: the loaded overview, the page being shown and the list filters. */
import type { TrackerStatus } from '../../integrations/tracker.js';
import type { TrackerSettings } from '../tracker-setup.js';
import {
  parseRoute,
  routeHash,
  type Data,
  type Project,
  type Route,
  type TableView,
  type View,
} from './logic.js';

/** What the Bug tracker form holds while it is filled in. The token never leaves this page's memory. */
export interface TrackerDraft {
  kind: 'clickup' | 'jira';
  listId: string;
  status: string;
  baseUrl: string;
  projectKey: string;
  email: string;
  token: string;
}

export const state = {
  /** The last /api/overview answer; set before the first render. */
  data: null as unknown as Data,
  /** The page and the open item, from the address (`#/scenarios/HOME-001`). */
  route: parseRoute(location.hash) as Route,
  view: { page: '', only: 'all', type: '', q: '' } as View,
  /** Page of the scenario list (0-based). */
  pageNo: 0,
  trackers: null as TrackerStatus[] | null,
  /** The /api/project answer: what is analyzed and what is out of date. Null until it arrives. */
  project: null as Project | null,
  /** Why the project could not be checked, when the request failed. */
  projectError: '',
  /** The job this page started or saw running; its outcome is shown until dismissed. */
  watched: null as string | null,
  /** Search, filter and page of each long table, by table id. */
  tables: {} as Record<string, TableView>,
  /** The Bug tracker page: saved settings (from the server), the form, and the last test or save. */
  trackerSettings: null as TrackerSettings | null,
  trackerDraft: null as TrackerDraft | null,
  trackerResult: null as { ok: boolean; text: string } | null,
  trackerBusy: '' as '' | 'test' | 'save',
  /** What the last action on a scenario did; shown in that scenario's detail until another opens. */
  notice: null as { id: string; text: string } | null,
};

/** Open a page (and an item on it). The address changes, so Back returns to where the user was. */
export function go(page: Route['page'], id = ''): void {
  const hash = routeHash(page, id);
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

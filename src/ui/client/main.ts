/**
 * Dashboard entry point, loaded by index.html as an ES module. Pages are addresses
 * (`#/overview`, `#/defects/<id>`, `#/scenarios/<id>`), so links and the Back button work. Every
 * control carries a `data-action` (buttons) or `data-filter` (list filters) attribute; the
 * listeners below dispatch them, so the rendered HTML contains no inline JavaScript.
 */
import {
  askDelete,
  askMediaDelete,
  cancelDelete,
  cancelMediaDelete,
  confirmDelete,
  confirmMediaDelete,
  fileBug,
  runTest,
  writeTest,
} from './actions.js';
import { load } from './app.js';
import { $, sideBySide, toast } from './dom.js';
import { closeRail, initDrawer, openRail } from './drawer.js';
import { draftWithAi, openEditor, saveEditor } from './editor.js';
import { cancelJob, createPlan, refreshAll, startJob } from './jobs.js';
import { parseRoute, type StepKind, type View } from './logic.js';
import {
  askRunsDelete,
  cancelRunsDelete,
  confirmRunsDelete,
  openRunCleanup,
  selectRuns,
  viewPlan,
} from './modal.js';
import { askStep, startStep } from './project.js';
import { render } from './render.js';
import type { MediaTarget } from './scenarios.js';
import { state } from './state.js';
import {
  askStorageClean,
  cancelStorageClean,
  confirmStorageClean,
  loadStorage,
  toggleStorageKind,
} from './storage.js';
import { tableView } from './table.js';
import { toggleTheme, watchSystemTheme } from './theme.js';
import { setDraftField, submitTracker, toggleToken } from './tracker.js';

const modal = (): HTMLDialogElement => $<HTMLDialogElement>('#modal');

/** The media a delete control acts on, from its `data-*` attributes (see mediaButton in scenarios.ts). */
const mediaTarget = (el: HTMLElement): MediaTarget => ({
  id: el.dataset.id ?? '',
  key: el.dataset.key ?? '',
  what: (el.dataset.what ?? 'all') as MediaTarget['what'],
  file: el.dataset.file ?? '',
  page: el.dataset.page ? Number(el.dataset.page) : undefined,
});

/* ---------- the Run tests menu ---------- */
/* The two menus of the top bar: Run tests (`run-menu`) and the run picker (`run-picker`). Each
   is opened by the button with the same id plus `-btn`; only one is open at a time. */
const POPOVERS = ['run-menu', 'run-picker'] as const;
type Popover = (typeof POPOVERS)[number];

function setPopover(id: Popover, open: boolean): void {
  const menu = document.getElementById(id);
  const btn = document.getElementById(id + '-btn');
  if (!menu || !btn) return;
  if (open) for (const other of POPOVERS) if (other !== id) setPopover(other, false);
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  // On a phone the panel is pinned to the window edges, just under its button.
  menu.style.top = '';
  if (open && getComputedStyle(menu).position === 'fixed')
    menu.style.top = btn.getBoundingClientRect().bottom + 6 + 'px';
  if (open)
    (
      menu.querySelector<HTMLButtonElement>('[aria-current="true"]') ??
      menu.querySelector<HTMLButtonElement>('button')
    )?.focus();
}
const openPopover = (): Popover | undefined =>
  POPOVERS.find((id) => document.getElementById(id)?.hidden === false);
const setRunMenu = (open: boolean): void => setPopover('run-menu', open);
const runMenuOpen = (): boolean => openPopover() === 'run-menu';

function resetFilters(): void {
  state.view = { page: '', only: 'all', type: '', q: '' };
  state.pageNo = 0;
}

document.addEventListener('click', (e) => {
  const target = e.target as Element;
  const open = openPopover();
  if (open && !target.closest('#' + open + ', #' + open + '-btn')) setPopover(open, false);
  const el = target.closest<HTMLElement>('[data-action]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  const id = el.dataset.id ?? '';
  switch (el.dataset.action) {
    case 'open-rail':
      return openRail();
    case 'close-rail':
      return closeRail();
    case 'toggle-theme':
      toggleTheme();
      return render();
    case 'toggle-run-menu':
      return setRunMenu(!runMenuOpen());
    case 'toggle-run-picker':
      return setPopover('run-picker', openPopover() !== 'run-picker');
    case 'pick-run':
      setPopover('run-picker', false);
      document.getElementById('run-picker-btn')?.focus();
      return id === state.data.run?.id ? undefined : void load(id);
    case 'table-only': {
      const view = tableView(el.dataset.table ?? '');
      view.only = el.dataset.only === 'attention' ? 'attention' : 'all';
      view.pageNo = 0;
      return render();
    }
    case 'table-page':
      tableView(el.dataset.table ?? '').pageNo = Number(el.dataset.to ?? 0);
      render();
      return document
        .getElementById('tq-' + el.dataset.table)
        ?.closest('section')
        ?.scrollIntoView({ block: 'start' });
    case 'table-clear':
      Object.assign(tableView(el.dataset.table ?? ''), { q: '', only: 'all', pageNo: 0 });
      return render();
    case 'tracker-test':
      return void submitTracker(false);
    case 'toggle-token':
      return toggleToken();
    // On a link to the Scenarios page: the list opens filtered. The link itself changes the page.
    case 'view-page':
      resetFilters();
      state.view.page = el.dataset.page ?? '';
      return;
    case 'set-only':
      if (el.tagName === 'A') resetFilters();
      state.view.only = (el.dataset.only ?? 'all') as View['only'];
      state.pageNo = 0;
      return el.tagName === 'A' ? undefined : render();
    case 'clear-filters':
      resetFilters();
      return render();
    case 'page':
      state.pageNo = Number(el.dataset.to ?? 0);
      render();
      return window.scrollTo(0, 0);
    case 'copy':
      return void navigator.clipboard.writeText(el.dataset.text ?? '').then(
        () => toast('Copied.'),
        () => toast('Could not copy. Select the text and copy it.'),
      );
    case 'close-modal':
      return modal().close();
    case 'open-editor':
      return openEditor(id || undefined);
    case 'draft':
      return void draftWithAi();
    case 'run-test':
      return void runTest(el as HTMLButtonElement, id);
    case 'write-test':
      return void writeTest(id);
    case 'file-bug':
      return void fileBug(
        el as HTMLButtonElement,
        JSON.parse(el.dataset.body ?? '{}') as Record<string, string>,
      );
    case 'ask-delete':
      return askDelete(id);
    case 'cancel-delete':
      return cancelDelete(id);
    case 'confirm-delete':
      return void confirmDelete(id);
    case 'ask-media-delete':
      return askMediaDelete(el, mediaTarget(el));
    case 'cancel-media-delete':
      return cancelMediaDelete(el, mediaTarget(el));
    case 'confirm-media-delete':
      return void confirmMediaDelete(el as HTMLButtonElement, mediaTarget(el));
    case 'refresh':
      return void refreshAll(el as HTMLButtonElement);
    case 'start-job':
      setRunMenu(false);
      return void startJob(
        el.dataset.url ?? '',
        JSON.parse(el.dataset.extra ?? '{}') as Record<string, unknown>,
      );
    case 'ask-step':
      return askStep((el.dataset.step ?? 'analyze') as StepKind, {
        all: el.dataset.all === '1',
        page: el.dataset.page ?? '',
      });
    case 'start-step':
      return startStep();
    case 'cancel-job':
      return void cancelJob(el as HTMLButtonElement);
    case 'create-plan':
      return createPlan();
    case 'view-plan':
      return void viewPlan();
    case 'open-run-cleanup':
      setPopover('run-picker', false);
      return openRunCleanup();
    case 'runs-select':
      return selectRuns(el.dataset.which ?? '');
    case 'ask-runs-delete':
      return askRunsDelete();
    case 'cancel-runs-delete':
      return cancelRunsDelete();
    case 'confirm-runs-delete':
      return void confirmRunsDelete(el as HTMLButtonElement, load);
    case 'storage-ask':
      return askStorageClean();
    case 'storage-cancel':
      return cancelStorageClean();
    case 'storage-clean':
      return void confirmStorageClean();
    case 'dismiss-job':
      state.watched = null;
      return render();
  }
});

document.addEventListener('keydown', (e) => {
  const open = openPopover();
  if (!open) return;
  if (e.key === 'Escape') {
    setPopover(open, false);
    document.getElementById(open + '-btn')?.focus();
    return;
  }
  // Up and down move between the choices of the open menu.
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...document.querySelectorAll<HTMLButtonElement>('#' + open + ' button:not(:disabled)')];
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  items[at === -1 ? 0 : next]!.focus();
});

// List filters: every change starts again at the first page of the list.
document.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.tf && el.type !== 'radio') return setDraftField(el.dataset.tf, el.value);
  if (el.dataset.tableQ) {
    const view = tableView(el.dataset.tableQ);
    view.q = el.value;
    view.pageNo = 0;
    return render();
  }
  if (el.dataset.filter !== 'q') return;
  state.view.q = el.value;
  state.pageNo = 0;
  render();
});
document.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.tf === 'kind') return setDraftField('kind', el.value);
  if (el.dataset.storageKind) return toggleStorageKind(el.dataset.storageKind, el.checked);
  if (el.dataset.filter === 'type') state.view.type = el.value;
  else if (el.dataset.filter === 'page') state.view.page = el.value;
  else return;
  state.pageNo = 0;
  render();
});

document.addEventListener('submit', (e) => {
  const id = (e.target as HTMLElement).id;
  if (id === 'tracker-form') {
    e.preventDefault();
    return void submitTracker(true);
  }
  if (id !== 'f') return;
  e.preventDefault();
  void saveEditor();
});

// Clicking the dialog backdrop closes it.
modal().addEventListener('click', (e) => {
  if (e.target === e.currentTarget) modal().close();
});

// The address changed: another page, or another item of the same list.
window.addEventListener('hashchange', () => {
  const before = state.route;
  state.route = parseRoute(location.hash);
  if (state.notice && state.notice.id !== state.route.id) state.notice = null;
  closeRail();
  if (!state.data) return;
  render();
  if (before.page !== state.route.page) {
    // Measured again on every visit: runs and jobs change what there is to free.
    if (state.route.page === 'storage') void loadStorage();
    window.scrollTo(0, 0);
    document.getElementById('page-title')?.focus({ preventScroll: true });
  } else if (state.route.id && !sideBySide.matches) {
    // Below the xl breakpoint the detail replaced the list: start reading at its top.
    window.scrollTo(0, 0);
    document.getElementById('detail-title')?.focus({ preventScroll: true });
  }
});

const redraw = (): void => {
  if (state.data) render();
};
watchSystemTheme(redraw);
// Crossing the breakpoint changes whether a list preselects its first item.
sideBySide.addEventListener('change', redraw);
initDrawer();
void load();

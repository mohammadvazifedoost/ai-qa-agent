/**
 * Dashboard entry point, loaded by index.html as an ES module. Every control carries a
 * `data-action` (buttons) or `data-filter` (list filters) attribute; the listeners below dispatch
 * them, so the rendered HTML contains no inline JavaScript.
 */
import { load } from './app.js';
import { $ } from './dom.js';
import { closeRail, initDrawer, openRail } from './drawer.js';
import { draftWithAi, openEditor, saveEditor } from './editor.js';
import { cancelJob, createPlan, refreshAll, startJob } from './jobs.js';
import type { View } from './logic.js';
import {
  askDelete,
  cancelDelete,
  confirmDelete,
  fileBug,
  openModal,
  runTest,
  viewPlan,
  writeTest,
} from './modal.js';
import { render } from './render.js';
import { state } from './state.js';

const modal = (): HTMLDialogElement => $<HTMLDialogElement>('#modal');

document.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-action]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  const id = el.dataset.id ?? '';
  switch (el.dataset.action) {
    case 'open-rail':
      return openRail();
    case 'close-rail':
      return closeRail();
    case 'set-page':
      state.view.page = el.dataset.page ?? '';
      closeRail();
      return render();
    case 'set-only':
      state.view.only = (el.dataset.only ?? 'all') as View['only'];
      return render();
    case 'open-modal':
      return openModal(id);
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
    case 'refresh':
      return void refreshAll(el as HTMLButtonElement);
    case 'start-job':
      return void startJob(el.dataset.url ?? '');
    case 'cancel-job':
      return void cancelJob(el as HTMLButtonElement);
    case 'create-plan':
      return createPlan();
    case 'view-plan':
      return void viewPlan();
    case 'dismiss-job':
      state.watched = null;
      return render();
  }
});

// List filters: re-render on change; keep the search box focused while typing.
document.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.filter !== 'q') return;
  state.view.q = el.value;
  render();
  const search = $<HTMLInputElement>('#search');
  search.focus();
  search.setSelectionRange(search.value.length, search.value.length);
});
document.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === 'run') {
    closeRail();
    void load(el.value);
  } else if (el.dataset.filter === 'type') {
    state.view.type = el.value;
    render();
  }
});

document.addEventListener('submit', (e) => {
  if ((e.target as HTMLElement).id !== 'f') return;
  e.preventDefault();
  void saveEditor();
});

// Clicking the dialog backdrop closes it.
modal().addEventListener('click', (e) => {
  if (e.target === e.currentTarget) modal().close();
});

initDrawer();
void load();

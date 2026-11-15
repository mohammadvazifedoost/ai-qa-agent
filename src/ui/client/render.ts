/** Draws the whole page from the state: the frame (shell.ts) and the page the address names. */
import { $ } from './dom.js';
import { defectsPage } from './defects.js';
import { overviewPage } from './overview.js';
import { projectPage } from './project.js';
import { scenariosPage } from './scenarios.js';
import { jobBanner, renderShell } from './shell.js';
import { state } from './state.js';
import { trackerPage } from './tracker.js';

/** What the detail panel showed at the last render, to keep its scroll position while it stays. */
let lastDetail = '';

/**
 * Re-draw everything. The focused control (by id), the caret of a text box and the scroll position
 * of the detail panel survive, so typing in the search box or a result arriving does not move the user.
 */
export function render(): void {
  const { route } = state;
  const active = document.activeElement as HTMLElement | null;
  const focusId = active && active !== document.body && !active.closest('dialog') ? active.id : '';
  // Text boxes keep their caret; number fields have none (reading it would throw).
  let caret: number | null = null;
  try {
    if (active instanceof HTMLInputElement) caret = active.selectionStart;
  } catch {
    caret = null;
  }
  const detailKey = route.page + '/' + route.id;
  const scroll = detailKey === lastDetail ? ($('#detail')?.scrollTop ?? 0) : 0;
  lastDetail = detailKey;

  renderShell();
  const banner = jobBanner();
  $('#main').innerHTML =
    route.page === 'scenarios'
      ? scenariosPage(banner)
      : route.page === 'defects'
        ? defectsPage(banner)
        : route.page === 'project'
          ? projectPage(banner)
          : route.page === 'tracker'
            ? trackerPage(banner)
            : overviewPage(banner);

  const detail = $('#detail');
  if (detail && scroll) detail.scrollTop = scroll;
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      if (caret !== null && el instanceof HTMLInputElement) el.setSelectionRange(caret, caret);
    }
  }
}

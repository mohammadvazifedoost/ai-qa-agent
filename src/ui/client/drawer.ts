/** Mobile side drawer: below the lg breakpoint the rail slides in over the page. */
import { $ } from './dom.js';

const wide = window.matchMedia('(min-width: 1024px)');

export function syncRail(): void {
  const rail = $('#rail');
  const open = rail.dataset.open === 'true';
  // Closed on a small screen: out of view, so out of the tab order and the accessibility tree too.
  rail.inert = !wide.matches && !open;
  $('#rail-backdrop').classList.toggle('hidden', wide.matches || !open);
  $('#rail-open').setAttribute('aria-expanded', String(open && !wide.matches));
  document.body.classList.toggle('overflow-hidden', open && !wide.matches);
}

export function openRail(): void {
  $('#rail').dataset.open = 'true';
  syncRail();
  $('#rail-close').focus();
}

export function closeRail(): void {
  const rail = $('#rail');
  if (rail.dataset.open !== 'true') return;
  rail.dataset.open = 'false';
  syncRail();
  if (!wide.matches) $('#rail-open').focus();
}

export function initDrawer(): void {
  wide.addEventListener('change', syncRail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#rail').dataset.open === 'true' && !$<HTMLDialogElement>('#modal').open)
      closeRail();
  });
  syncRail();
}

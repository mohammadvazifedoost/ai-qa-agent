/** Small DOM helpers shared by the dashboard modules. */
import { esc } from './logic.js';

/** The element for a selector. Callers only ask for elements the page or current modal contains. */
export const $ = <T extends HTMLElement = HTMLElement>(s: string, el: ParentNode = document): T =>
  el.querySelector(s) as T;

/** URL of a file under the project (evidence), served by the dashboard under /files/. */
export const fileUrl = (p: string): string => '/files/' + p.split('/').map(encodeURIComponent).join('/');

export const link = (href: string | null | undefined, text: string, blank?: boolean): string =>
  href
    ? '<a class="text-accent underline-offset-2 hover:underline" href="' +
      fileUrl(href) +
      '"' +
      (blank ? ' target="_blank" rel="noopener"' : '') +
      '>' +
      esc(text) +
      '</a>'
    : '';

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string): void {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 8000);
}

/** Attributes for a `data-action` button: `act('run-test', { id })` → `data-action="run-test" data-id="…"`. */
export function act(action: string, args: Record<string, string> = {}): string {
  return (
    'data-action="' +
    action +
    '"' +
    Object.entries(args)
      .map(([k, v]) => ' data-' + k + '="' + esc(v) + '"')
      .join('')
  );
}

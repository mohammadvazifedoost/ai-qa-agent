/**
 * Long tables (pages of the analysis, scenarios per page, results by page): a search box, All /
 * Needs attention, and ten rows at a time. A short table shows none of this.
 */
import { act } from './dom.js';
import { esc, filterTable, paginate, type TableView } from './logic.js';
import { state } from './state.js';

export const TABLE_ROWS = 10;

export function tableView(id: string): TableView {
  return (state.tables[id] ??= { q: '', only: 'all', pageNo: 0 });
}

export interface TableOpts<T> {
  id: string;
  /** What one row is, for the counts: `page`. */
  noun: [string, string];
  placeholder: string;
  /** Name of the attention filter: `Needs attention`. */
  attentionLabel: string;
  text: (row: T) => string;
  needsAttention: (row: T) => boolean;
}

/**
 * The rows of one page of the table, the tools above it and the pager under it. Tools and pager
 * are empty strings while every row fits on one page and no filter is set.
 */
export function longTable<T>(rows: readonly T[], o: TableOpts<T>) {
  const view = tableView(o.id);
  const filtered = filterTable(rows, view, o.text, o.needsAttention);
  const page = paginate(filtered.rows, view.pageNo, TABLE_ROWS);
  view.pageNo = page.page;
  const long = rows.length > TABLE_ROWS || view.q !== '' || view.only !== 'all';
  const n = (count: number) => count + ' ' + (count === 1 ? o.noun[0] : o.noun[1]);
  const toggle = (only: TableView['only'], text: string, count: number) =>
    '<button type="button" class="tab" aria-pressed="' +
    (view.only === only) +
    '" ' +
    act('table-only', { table: o.id, only }) +
    '>' +
    text +
    ' <span class="' +
    (view.only === only ? '' : 'text-muted') +
    '">' +
    count +
    '</span></button>';
  const tools = long
    ? '<div class="flex flex-wrap items-center gap-2.5 border-t border-divider px-6 py-3">' +
      '<label class="flex min-h-11 min-w-0 flex-[1_1_240px] items-center gap-2 rounded-lg border border-control bg-surface px-3 text-muted has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">' +
      '<svg aria-hidden="true" class="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
      '<span class="sr-only">' +
      esc(o.placeholder) +
      '</span><input type="search" id="tq-' +
      o.id +
      '" data-table-q="' +
      o.id +
      '" value="' +
      esc(view.q) +
      '" placeholder="' +
      esc(o.placeholder) +
      '" class="h-10 min-w-0 flex-1 border-0 bg-transparent text-ink outline-none placeholder:text-muted"></label>' +
      '<div role="group" aria-label="Show" class="flex flex-wrap gap-2">' +
      toggle('all', 'All', filtered.total) +
      toggle('attention', esc(o.attentionLabel), filtered.attention) +
      '</div></div>'
    : '';
  const empty = !page.total
    ? '<div class="flex flex-wrap items-center gap-3 border-t border-divider px-6 py-6"><span class="font-semibold">No ' +
      o.noun[1] +
      ' match.</span><button type="button" class="btn" ' +
      act('table-clear', { table: o.id }) +
      '>Show all ' +
      o.noun[1] +
      '</button></div>'
    : '';
  const pager =
    long && page.total
      ? '<div class="flex flex-wrap items-center justify-between gap-2.5 border-t border-divider px-6 py-3"><span class="text-muted" role="status">' +
        page.from +
        ' to ' +
        page.to +
        ' of ' +
        (view.only === 'attention' || view.q
          ? n(page.total) + ' shown, ' + filtered.total + ' in all'
          : n(page.total)) +
        '</span>' +
        (page.pages > 1
          ? '<div class="flex gap-2"><button type="button" class="btn"' +
            (page.page === 0 ? ' disabled' : '') +
            ' ' +
            act('table-page', { table: o.id, to: String(page.page - 1) }) +
            '>Previous</button><button type="button" class="btn"' +
            (page.page >= page.pages - 1 ? ' disabled' : '') +
            ' ' +
            act('table-page', { table: o.id, to: String(page.page + 1) }) +
            '>Next</button></div>'
          : '') +
        '</div>'
      : '';
  return { rows: page.items, tools, empty, pager };
}

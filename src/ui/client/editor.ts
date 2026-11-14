/** Add / edit scenario form in the modal, with an optional AI draft. */
import type { Scenario } from '../../scenarios/schema.js';
import type { ScenarioDraft } from '../../scenarios/author.js';
import { postJson } from './api.js';
import { load } from './app.js';
import { $, act } from './dom.js';
import { esc, lines } from './logic.js';
import { closeButton, openModal } from './modal.js';
import { state } from './state.js';

const options = (list: readonly string[], selected: string | undefined): string =>
  list
    .map(
      (v) =>
        '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>',
    )
    .join('');

function field(id: string, label: string, control: string, hint?: string): string {
  return (
    '<div><label for="' +
    id +
    '" class="block text-sm font-semibold">' +
    label +
    (hint ? ' <span class="font-normal text-muted">' + hint + '</span>' : '') +
    '</label>' +
    control +
    '</div>'
  );
}

const textarea = (id: string, value: readonly string[] | undefined, rows: number): string =>
  '<textarea id="' +
  id +
  '" rows="' +
  rows +
  '" class="field mt-1 block w-full resize-y font-sans leading-snug">' +
  esc((value || []).join('\n')) +
  '</textarea>';

const value = (sel: string): string => $<HTMLInputElement>(sel).value;

export function openEditor(id?: string): void {
  const { data, view } = state;
  const sc = id ? data.scenarios.find((x) => x.id === id) : undefined;
  const a = data.authoring;
  const modal = $<HTMLDialogElement>('#modal');
  modal.dataset.id = id || '';
  modal.dataset.mode = 'edit';
  const pages = sc && !a.pages.includes(sc.page) ? [sc.page, ...a.pages] : a.pages;
  const page = sc ? sc.page : view.page && pages.includes(view.page) ? view.page : pages[0];
  const draft = sc
    ? ''
    : '<section class="mb-5 rounded-xl bg-accent-soft p-4">' +
      field(
        'f-desc',
        'Describe the test',
        '<textarea id="f-desc" rows="2" class="field mt-1 block w-full resize-y font-sans" placeholder="e.g. Applying the coupon SAVE10 takes 10% off the total"></textarea>',
        '(optional)',
      ) +
      '<div class="mt-2 flex flex-wrap items-center gap-3"><button type="button" id="f-draft" class="btn" ' +
      act('draft') +
      '>Draft with AI</button>' +
      '<span id="f-draft-status" class="text-[13px] text-muted" aria-live="polite">The AI fills in the fields below for you to review.</span></div></section>';
  modal.innerHTML =
    '<div class="flex items-start gap-4 border-b border-line px-5 pb-4 pt-5 md:px-6 md:pt-[22px]"><div class="min-w-0">' +
    '<h2 id="m-title" class="m-0 text-xl font-extrabold tracking-tight">' +
    (sc ? 'Edit scenario' : 'Add scenario') +
    '</h2>' +
    '<p class="m-0 mt-1 text-[13px] text-muted">' +
    (sc
      ? '<span class="font-mono text-[12.5px]">' + esc(sc.id) + '</span> · ' + esc(sc.page)
      : 'Scenarios you write are yours: the AI will not change or remove them.') +
    '</p></div>' +
    closeButton() +
    '</div>' +
    '<form id="f" class="min-h-0 flex-1 overflow-auto px-5 py-5 md:px-6">' +
    draft +
    '<div class="grid grid-cols-1 gap-4 md:grid-cols-2">' +
    '<div class="md:col-span-2">' +
    field(
      'f-title',
      'Title',
      '<input id="f-title" class="field mt-1 block w-full" required value="' + esc(sc?.title) + '">',
    ) +
    '</div>' +
    field(
      'f-page',
      'Page',
      '<select id="f-page" class="field mt-1 block w-full"' +
        (sc ? ' disabled' : '') +
        '>' +
        options(pages, page) +
        '</select>',
    ) +
    field(
      'f-viewport',
      'Viewport',
      '<select id="f-viewport" class="field mt-1 block w-full">' +
        options(a.viewports, sc?.viewport ?? a.viewports[0]) +
        '</select>',
    ) +
    field(
      'f-category',
      'Type',
      '<select id="f-category" class="field mt-1 block w-full">' +
        options(a.categories, sc?.category ?? 'functional') +
        '</select>',
    ) +
    field(
      'f-priority',
      'Priority',
      '<select id="f-priority" class="field mt-1 block w-full">' +
        options(['high', 'medium', 'low'], sc?.priority ?? 'medium') +
        '</select>',
    ) +
    '<div class="md:col-span-2">' +
    field('f-steps', 'Steps', textarea('f-steps', sc?.steps, 5), 'one per line') +
    '</div>' +
    '<div class="md:col-span-2">' +
    field(
      'f-expected',
      'Expected results',
      textarea('f-expected', sc?.expectedResults, 3),
      'one per line; the correct behaviour',
    ) +
    '</div>' +
    field('f-pre', 'Preconditions', textarea('f-pre', sc?.preconditions, 2), 'optional') +
    field('f-data', 'Test data', textarea('f-data', sc?.testData, 2), 'optional') +
    field(
      'f-feature',
      'Feature',
      '<input id="f-feature" class="field mt-1 block w-full" placeholder="e.g. checkout" value="' +
        esc(sc?.feature) +
        '">',
      'optional',
    ) +
    field(
      'f-why',
      'Why it matters',
      '<input id="f-why" class="field mt-1 block w-full" value="' + esc(sc?.rationale) + '">',
      'optional',
    ) +
    '</div>' +
    (sc && sc.origin !== 'person'
      ? '<p class="mb-0 mt-4 text-[13px] text-muted">The AI wrote this scenario. Saving your changes makes it yours, so the AI will no longer change or remove it.</p>'
      : '') +
    (sc?.design
      ? '<p class="mb-0 mt-2 text-[13px] text-muted">Its Figma design checks are kept as they are.</p>'
      : '') +
    '</form>' +
    '<div class="flex flex-wrap items-center gap-3 border-t border-line bg-bg px-5 py-3.5 md:px-6">' +
    '<p id="f-error" class="m-0 min-w-0 flex-1 text-[13px] text-fail" role="alert"></p>' +
    '<button type="button" class="btn-quiet" ' +
    (sc ? act('open-modal', { id: sc.id }) : act('close-modal')) +
    '>Cancel</button>' +
    '<button id="f-save" class="btn" type="submit" form="f">' +
    (sc ? 'Save changes' : 'Add scenario') +
    '</button></div>';
  if (!modal.open) modal.showModal();
  (sc ? $('#f-title') : $('#f-desc')).focus();
}

export async function draftWithAi(): Promise<void> {
  const description = value('#f-desc').trim();
  const status = $('#f-draft-status');
  if (!description) {
    status.textContent = 'Write a sentence first.';
    $('#f-desc').focus();
    return;
  }
  const btn = $<HTMLButtonElement>('#f-draft');
  btn.disabled = true;
  btn.textContent = 'Drafting…';
  status.textContent = 'The AI is reading the page; this can take a minute.';
  const { ok, out } = await postJson<ScenarioDraft & { concerns?: string[] }>('/api/scenarios/draft', {
    page: value('#f-page'),
    description,
  });
  if (!$('#f') || $('#f-draft') !== btn) return; // the form was closed or replaced meanwhile
  btn.disabled = false;
  btn.textContent = 'Draft with AI';
  if (!ok) {
    status.textContent = out.error || 'The AI could not draft it.';
    return;
  }
  const set = (sel: string, v: string | readonly string[] | undefined) => {
    if (v !== undefined) $<HTMLInputElement>(sel).value = Array.isArray(v) ? v.join('\n') : (v as string);
  };
  set('#f-title', out.title);
  set('#f-category', out.category);
  set('#f-priority', out.priority);
  if (state.data.authoring.viewports.includes(out.viewport)) set('#f-viewport', out.viewport);
  set('#f-steps', out.steps);
  set('#f-expected', out.expectedResults);
  set('#f-pre', out.preconditions);
  set('#f-data', out.testData);
  set('#f-feature', out.feature);
  set('#f-why', out.rationale);
  // What the AI could not confirm in the app is shown, so the person checks it before saving.
  status.textContent = out.concerns?.length
    ? `Drafted, with open points to check: ${out.concerns.join(' ')}`
    : 'Drafted. Review the fields, then add the scenario.';
}

export async function saveEditor(): Promise<void> {
  const id = $('#modal').dataset.id || undefined;
  const scenario = {
    page: value('#f-page'),
    title: value('#f-title'),
    viewport: value('#f-viewport'),
    category: value('#f-category'),
    priority: value('#f-priority'),
    steps: lines(value('#f-steps')),
    expectedResults: lines(value('#f-expected')),
    preconditions: lines(value('#f-pre')),
    testData: lines(value('#f-data')),
    feature: value('#f-feature'),
    rationale: value('#f-why'),
  };
  const err = $('#f-error');
  if (!scenario.steps.length) {
    err.textContent = 'Add at least one step.';
    $('#f-steps').focus();
    return;
  }
  if (!scenario.expectedResults.length) {
    err.textContent = 'Add at least one expected result.';
    $('#f-expected').focus();
    return;
  }
  const btn = $<HTMLButtonElement>('#f-save');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  err.textContent = '';
  const { ok, out } = await postJson<Scenario>('/api/scenarios/save', { id, scenario });
  if (!ok) {
    btn.disabled = false;
    btn.textContent = label;
    err.textContent = 'Could not save: ' + (out.error || 'unknown error');
    return;
  }
  // Saved scenarios are yours, so the list shows them even before they run.
  await load(state.data.run?.id);
  const t = state.data.testStates[out.id];
  openModal(
    out.id,
    (id ? 'Saved. ' : 'Added ' + out.id + '. ') +
      (t === 'missing'
        ? 'Create its test with the button below.'
        : t
          ? 'Rewrite its test with the button below to match your changes.'
          : ''),
  );
}

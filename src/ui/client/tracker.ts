/**
 * The Bug tracker page: where bugs are filed now, and a form that connects ClickUp or Jira. The
 * form is tested against the tracker before it is saved; the token is sent to the local server
 * only and kept in `.qa/.env.local`, never in `config.ts`.
 */
import type { TrackerSettings } from '../tracker-setup.js';
import { postJson } from './api.js';
import { load } from './app.js';
import { act } from './dom.js';
import { esc } from './logic.js';
import { render } from './render.js';
import { state, type TrackerDraft } from './state.js';
import { pageHeading as h1 } from './ui.js';
import type { TrackerStatus } from '../../integrations/tracker.js';

let showToken = false;

export function draftFrom(s: TrackerSettings | null): TrackerDraft {
  return {
    kind: s?.active ?? 'clickup',
    listId: s?.clickup?.listId ?? '',
    status: s?.clickup?.status ?? '',
    baseUrl: s?.jira?.baseUrl ?? '',
    projectKey: s?.jira?.projectKey ?? '',
    email: s?.jira?.email ?? '',
    token: '',
  };
}

function draft(): TrackerDraft {
  return (state.trackerDraft ??= draftFrom(state.trackerSettings));
}

/** Keep what is typed (the form is drawn again on every update of the page). */
export function setDraftField(field: string, value: string): void {
  const d = draft() as unknown as Record<string, string>;
  if (field in d) d[field] = value;
  if (field === 'kind') {
    state.trackerResult = null;
    render();
  }
}

export function toggleToken(): void {
  showToken = !showToken;
  render();
}

const field = (
  name: keyof TrackerDraft,
  title: string,
  help: string,
  attrs: { type?: string; placeholder?: string; mono?: boolean; optional?: boolean; auto?: string } = {},
): string =>
  '<div class="flex flex-col gap-1.5"><label for="tf-' +
  name +
  '" class="font-semibold">' +
  title +
  (attrs.optional ? ' <span class="font-normal text-muted">(optional)</span>' : '') +
  '</label><input id="tf-' +
  name +
  '" data-tf="' +
  name +
  '" type="' +
  (attrs.type ?? 'text') +
  '" class="field' +
  (attrs.mono ? ' font-mono text-sm' : '') +
  '" value="' +
  esc(draft()[name]) +
  '" autocomplete="' +
  (attrs.auto ?? 'off') +
  '" spellcheck="false"' +
  (attrs.placeholder ? ' placeholder="' + esc(attrs.placeholder) + '"' : '') +
  ' aria-describedby="tf-' +
  name +
  '-help"><span id="tf-' +
  name +
  '-help" class="text-[13px] text-muted">' +
  help +
  '</span></div>';

function tokenField(saved: boolean, help: string): string {
  return (
    '<div class="flex flex-col gap-1.5"><label for="tf-token" class="font-semibold">API token</label>' +
    '<div class="flex gap-2"><input id="tf-token" data-tf="token" type="' +
    (showToken ? 'text' : 'password') +
    '" class="field min-w-0 flex-1" value="' +
    esc(draft().token) +
    '" autocomplete="off" spellcheck="false"' +
    (saved ? ' placeholder="Saved on this computer. Leave empty to keep it."' : '') +
    ' aria-describedby="tf-token-help"><button type="button" class="btn" aria-pressed="' +
    showToken +
    '" ' +
    act('toggle-token') +
    '>' +
    (showToken ? 'Hide' : 'Show') +
    '</button></div><span id="tf-token-help" class="text-[13px] text-muted">' +
    help +
    '</span></div>'
  );
}

const code = (s: string): string => '<code>' + s + '</code>';

function form(): string {
  const d = draft();
  const s = state.trackerSettings;
  const choice = (kind: TrackerDraft['kind'], name: string, text: string) =>
    '<label class="flex cursor-pointer gap-3 rounded-xl border px-4 py-3.5 ' +
    (d.kind === kind
      ? 'border-2 border-accent bg-accent-soft'
      : 'border-control bg-surface hover:bg-subtle') +
    '"><input type="radio" name="tracker-kind" value="' +
    kind +
    '" data-tf="kind" class="mt-1 size-[18px] shrink-0 accent-accent-fill"' +
    (d.kind === kind ? ' checked' : '') +
    '><span class="flex flex-col"><span class="font-bold">' +
    name +
    '</span><span class="text-[13px] text-ink-2">' +
    text +
    '</span></span></label>';
  const fields =
    d.kind === 'clickup'
      ? field(
          'listId',
          'List ID',
          'Open the list in ClickUp. The ID is the number after ' + code('/li/') + ' in its address.',
          {
            mono: true,
            placeholder: '901234567890',
          },
        ) +
        tokenField(
          !!s?.clickup?.tokenSet,
          'In ClickUp: your avatar, Settings, Apps, then Generate under API token. It starts with ' +
            code('pk_') +
            '.',
        ) +
        field(
          'status',
          'Status of new tasks',
          'For example ' + code('to do') + '. Empty uses the list’s first status.',
          {
            optional: true,
          },
        )
      : field('baseUrl', 'Site address', 'The address you open Jira at.', {
          type: 'url',
          placeholder: 'https://yourco.atlassian.net',
          auto: 'url',
        }) +
        field(
          'projectKey',
          'Project key',
          'The short code in front of issue numbers: ' + code('SHOP') + ' in SHOP-12.',
          {
            mono: true,
            placeholder: 'SHOP',
          },
        ) +
        field('email', 'Account email', 'The email you sign in to Atlassian with.', {
          type: 'email',
          auto: 'email',
        }) +
        tokenField(
          !!s?.jira?.tokenSet,
          'Create one at id.atlassian.com, Security, API tokens. It works with the account email above.',
        );
  const r = state.trackerResult;
  const busy = state.trackerBusy;
  return (
    '<form id="tracker-form" class="panel min-w-0 flex-[999_1_520px] overflow-hidden" aria-labelledby="connect-h" novalidate>' +
    '<div class="flex flex-col gap-5 p-6"><h2 id="connect-h" class="m-0 text-[19px] font-bold">Connect a tracker</h2>' +
    '<fieldset class="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3 border-0 p-0"><legend class="sr-only">Tracker</legend>' +
    choice('clickup', 'ClickUp', 'A task per bug, in one list. Needs the list ID and a personal API token.') +
    choice(
      'jira',
      'Jira',
      'An issue per bug, in one project. Needs the site address, project key, your email and an API token.',
    ) +
    '</fieldset>' +
    fields +
    (r
      ? '<p role="' +
        (r.ok ? 'status' : 'alert') +
        '" class="m-0 flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3 font-semibold ' +
        (r.ok
          ? 'border-pass-line bg-pass-soft text-pass-ink'
          : 'border-fail-line bg-fail-soft text-fail-ink') +
        '">' +
        esc(r.text) +
        '</p>'
      : '') +
    '</div><div class="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-t border-divider px-6 py-4">' +
    '<button type="button" class="btn"' +
    (busy ? ' disabled' : '') +
    ' ' +
    act('tracker-test') +
    '>' +
    (busy === 'test' ? 'Testing…' : 'Test connection') +
    '</button><button type="submit" class="btn btn-primary"' +
    (busy ? ' disabled' : '') +
    '>' +
    (busy === 'save' ? 'Saving…' : 'Save and connect') +
    '</button><span class="min-w-0 flex-[1_1_220px] text-muted">Testing checks the token and the ' +
    (d.kind === 'clickup' ? 'list' : 'project') +
    ' without saving anything.</span></div></form>'
  );
}

const STATE_TEXT: Record<TrackerStatus['state'], [string, string]> = {
  connected: ['pill-passed', 'Connected'],
  'missing-credentials': ['chip-warn', 'Token missing'],
  error: ['sev-critical', 'Cannot connect'],
  'not-configured': ['chip-neutral', 'Not set up'],
};

function now(): string {
  const active = state.trackers?.find((t) => t.active);
  let body: string;
  if (!state.trackers) body = '<p class="m-0 text-muted">Checking…</p>';
  else if (!active)
    body =
      '<p class="m-0 text-ink-2">No tracker is connected. Defects are listed here and in the reports, and can be filed once a tracker is connected.</p>';
  else {
    const [cls, word] = STATE_TEXT[active.state];
    const what =
      active.state === 'connected'
        ? 'New bugs go to ' + esc(active.detail ?? active.target ?? '') + '.'
        : active.state === 'missing-credentials'
          ? esc(
              active.target
                ? active.target.charAt(0).toUpperCase() + active.target.slice(1)
                : 'The destination',
            ) +
            ' is set, but ' +
            (active.missingEnv.some((v) => /EMAIL/.test(v)) ? 'the email or token is' : 'the token is') +
            ' not on this computer, so bugs cannot be filed yet.'
          : esc(
              String(active.detail ?? '')
                .split('\n')[0]!
                .slice(0, 200),
            );
    body =
      '<div class="flex flex-wrap items-center gap-2.5"><span class="font-semibold">' +
      esc(active.name) +
      '</span><span class="chip ' +
      cls +
      '">' +
      word +
      '</span></div><p class="m-0 text-ink-2">' +
      what +
      '</p>';
  }
  return (
    '<section aria-labelledby="now-h" class="panel flex flex-col gap-2.5 p-5"><h2 id="now-h" class="h-section">Now</h2>' +
    body +
    '</section>'
  );
}

function where(): string {
  const file = esc(state.trackerSettings?.secretsFile ?? '.qa/.env.local');
  return (
    '<section aria-labelledby="where-h" class="panel flex flex-col gap-2.5 p-5"><h2 id="where-h" class="h-section">Where this is saved</h2>' +
    '<ul class="m-0 flex list-disc flex-col gap-1.5 pl-5 text-ink-2">' +
    '<li>The list, or the Jira site and project, go into <code>.qa/config.ts</code>, which you commit.</li>' +
    '<li>The token, and for Jira your email, stay on this computer in <code>' +
    file +
    '</code>. Git ignores that file.</li>' +
    '<li>A variable set in the shell that started the dashboard is used instead, if there is one.</li></ul></section>'
  );
}

export function trackerPage(banner: string): string {
  return (
    h1(
      'Bug tracker',
      'Where the agent files the bugs it finds, with the steps, screenshots and the test that caught them. Connect ClickUp or Jira; you can switch later.',
    ) +
    (banner ? '<div class="max-w-[1080px]">' + banner + '</div>' : '') +
    '<div class="flex max-w-[1080px] flex-wrap items-start gap-6">' +
    form() +
    '<div class="flex min-w-0 flex-[1_1_300px] flex-col gap-4">' +
    now() +
    where() +
    '</div></div>'
  );
}

/** The form as the server expects it; an empty token keeps the saved one. */
function body(): Record<string, string> {
  const d = draft();
  const token: Record<string, string> = d.token.trim() ? { token: d.token.trim() } : {};
  return d.kind === 'clickup'
    ? { kind: 'clickup', listId: d.listId, status: d.status, ...token }
    : { kind: 'jira', baseUrl: d.baseUrl, projectKey: d.projectKey, email: d.email, ...token };
}

export async function submitTracker(save: boolean): Promise<void> {
  if (state.trackerBusy) return;
  state.trackerBusy = save ? 'save' : 'test';
  state.trackerResult = null;
  render();
  const { ok, out } = await postJson<{
    target: string;
    settings: TrackerSettings;
    trackers?: TrackerStatus[];
  }>(save ? '/api/tracker/save' : '/api/tracker/test', body());
  state.trackerBusy = '';
  if (!ok) {
    state.trackerResult = { ok: false, text: out.error || 'No answer from the dashboard server.' };
    render();
    return;
  }
  state.trackerSettings = out.settings;
  if (save) {
    state.trackerDraft = { ...draft(), token: '' };
    if (out.trackers) state.trackers = out.trackers;
    state.trackerResult = { ok: true, text: 'Connected. New bugs go to ' + out.target + '.' };
    // The defect pages read from the overview whether bugs can be filed now.
    await load(state.data.run?.id);
  } else {
    state.trackerResult = {
      ok: true,
      text: 'The connection works: ' + out.target + '. Save to start filing bugs there.',
    };
    render();
  }
}

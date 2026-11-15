/** Fetch helpers for the dashboard server's JSON API. */
import type { Data } from './logic.js';

export interface Answer<T> {
  ok: boolean;
  /** The JSON body, or `{ error }` when the request itself failed. */
  out: T & { error?: string };
}

/**
 * Server paths are written as `/api/...`, but requested relative to the page, so the dashboard also
 * works behind a reverse proxy that serves it under a path (`ai-qa-agent ui --base-path`). The page
 * then carries a `<base href>` naming that path.
 */
export const appUrl = (url: string): string => url.replace(/^\/+/, '');

async function send<T>(url: string, init?: RequestInit): Promise<Answer<T>> {
  try {
    const res = await fetch(appUrl(url), init);
    return { ok: res.ok, out: (await res.json()) as T & { error?: string } };
  } catch (err) {
    return { ok: false, out: { error: String(err) } as T & { error?: string } };
  }
}

export const getJson = <T>(url: string): Promise<Answer<T>> => send<T>(url);

export const postJson = <T>(url: string, body: unknown): Promise<Answer<T>> =>
  send<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export async function getOverview(runId?: string): Promise<Data> {
  const res = await fetch(appUrl('/api/overview' + (runId ? '?run=' + encodeURIComponent(runId) : '')));
  return (await res.json()) as Data;
}

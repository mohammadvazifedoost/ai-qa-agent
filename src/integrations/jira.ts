import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../core/logger.js';
import { markdownToAdf, textToAdf } from './adf.js';
import type { Fetch } from './clickup.js';

const log = logger('jira');

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const CreatedIssue = z.looseObject({ id: z.string(), key: z.string(), self: z.string().optional() });
const Project = z.looseObject({ id: z.string(), key: z.string(), name: z.string() });
const IssueStatus = z.looseObject({
  key: z.string(),
  fields: z.looseObject({ status: z.looseObject({ name: z.string() }).optional() }).optional(),
});

export interface NewJiraIssue {
  summary: string;
  markdown: string;
  labels: string[];
  issueType: string;
  /** Jira priority name, e.g. "High". Dropped automatically if the project does not use priorities. */
  priority?: string;
}

/**
 * Minimal client for the official Jira Cloud REST API v3, authenticated with an Atlassian account
 * email + API token (HTTP basic). Every response is validated; failures throw JiraError.
 */
export class JiraClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(
    baseUrl: string,
    email: string,
    token: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    if (!email || !token) throw new JiraError('Jira email and API token are required');
    this.base = baseUrl.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  }

  /** Browser URL of an issue. */
  browseUrl(key: string): string {
    return `${this.base}/browse/${encodeURIComponent(key)}`;
  }

  private async request<T extends z.ZodType>(
    method: string,
    url: string,
    schema: T,
    body?: BodyInit,
    extraHeaders: Record<string, string> = {},
  ): Promise<z.output<T>> {
    const headers: Record<string, string> = {
      Authorization: this.auth,
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(`${this.base}${url}`, { method, headers, body });
    const text = await res.text();
    if (!res.ok) {
      throw new JiraError(
        `Jira ${method} ${url} failed: HTTP ${res.status} ${summarizeError(text)}`,
        res.status,
      );
    }
    const parsed = schema.safeParse(text ? JSON.parse(text) : {});
    if (!parsed.success)
      throw new JiraError(`Unexpected Jira response for ${method} ${url}: ${parsed.error.message}`);
    return parsed.data;
  }

  /** Cheap authenticated call used to verify credentials + project access. */
  getProject(key: string): Promise<z.infer<typeof Project>> {
    return this.request('GET', `/rest/api/3/project/${encodeURIComponent(key)}`, Project);
  }

  async createIssue(
    projectKey: string,
    issue: NewJiraIssue,
  ): Promise<{ id: string; key: string; url: string }> {
    const fields = (withPriority: boolean): Record<string, unknown> => ({
      project: { key: projectKey },
      summary: issue.summary.slice(0, 254),
      issuetype: { name: issue.issueType },
      description: markdownToAdf(issue.markdown),
      labels: issue.labels.map((l) => l.replace(/\s+/g, '-')),
      ...(withPriority && issue.priority ? { priority: { name: issue.priority } } : {}),
    });
    let created;
    try {
      created = await this.request(
        'POST',
        '/rest/api/3/issue',
        CreatedIssue,
        JSON.stringify({ fields: fields(true) }),
      );
    } catch (err) {
      // Projects without the priority field (or with other priority names) reject it; the bug is
      // still worth filing, so retry once without it.
      if (
        !(err instanceof JiraError) ||
        err.status !== 400 ||
        !/priority/i.test(err.message) ||
        !issue.priority
      )
        throw err;
      log.warn(`Jira rejected priority "${issue.priority}"; creating the issue without a priority`);
      created = await this.request(
        'POST',
        '/rest/api/3/issue',
        CreatedIssue,
        JSON.stringify({ fields: fields(false) }),
      );
    }
    return { id: created.id, key: created.key, url: this.browseUrl(created.key) };
  }

  addComment(key: string, text: string): Promise<unknown> {
    return this.request(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      z.unknown(),
      JSON.stringify({ body: textToAdf(text) }),
    );
  }

  async uploadAttachment(key: string, file: string): Promise<unknown> {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
    return this.request(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`,
      z.unknown(),
      form,
      {
        'X-Atlassian-Token': 'no-check',
      },
    );
  }

  async issueExists(key: string): Promise<{ exists: boolean; url?: string; status?: string }> {
    try {
      const i = await this.request(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`,
        IssueStatus,
      );
      return { exists: true, url: this.browseUrl(i.key), status: i.fields?.status?.name };
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return { exists: false };
      throw err;
    }
  }
}

/** Jira error bodies look like {"errorMessages":[...],"errors":{"field":"message"}}. */
function summarizeError(text: string): string {
  try {
    const j = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
    const parts = [
      ...(j.errorMessages ?? []),
      ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`),
    ];
    if (parts.length) return parts.join('; ');
  } catch {
    // not JSON
  }
  return text.slice(0, 300);
}

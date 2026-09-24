import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../core/logger.js';

const log = logger('clickup');
const API = 'https://api.clickup.com/api/v2';

export class ClickUpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const TaskResponse = z.looseObject({ id: z.string(), url: z.string().optional(), name: z.string() });
const AttachmentResponse = z.looseObject({
  id: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
});
const ListResponse = z.looseObject({ id: z.string(), name: z.string() });

export type Fetch = typeof fetch;

/** ClickUp priorities: 1 urgent, 2 high, 3 normal, 4 low. */
export const PRIORITY: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
};

export interface NewTask {
  name: string;
  markdown: string;
  tags: string[];
  priority: number;
}

/**
 * Minimal client for ClickUp's official REST API v2, authenticated with a personal API token.
 * Every response is validated; failures throw ClickUpError with the HTTP status.
 */
export class ClickUpClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    if (!token) throw new ClickUpError('ClickUp API token is empty');
  }

  private async request<T extends z.ZodType>(
    method: string,
    url: string,
    schema: T,
    body?: BodyInit,
    json = true,
  ): Promise<z.output<T>> {
    const headers: Record<string, string> = { Authorization: this.token };
    if (json && body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(`${API}${url}`, { method, headers, body });
    const text = await res.text();
    if (!res.ok) {
      throw new ClickUpError(
        `ClickUp ${method} ${url} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
        res.status,
      );
    }
    const parsed = schema.safeParse(text ? JSON.parse(text) : {});
    if (!parsed.success)
      throw new ClickUpError(`Unexpected ClickUp response for ${method} ${url}: ${parsed.error.message}`);
    return parsed.data;
  }

  /** Cheap authenticated call used to verify token + list access before filing anything. */
  getList(listId: string): Promise<z.infer<typeof ListResponse>> {
    return this.request('GET', `/list/${encodeURIComponent(listId)}`, ListResponse);
  }

  createTask(listId: string, task: NewTask): Promise<z.infer<typeof TaskResponse>> {
    return this.request(
      'POST',
      `/list/${encodeURIComponent(listId)}/task`,
      TaskResponse,
      JSON.stringify({
        name: task.name,
        markdown_content: task.markdown,
        tags: task.tags,
        priority: task.priority,
      }),
    );
  }

  addComment(taskId: string, text: string): Promise<unknown> {
    return this.request(
      'POST',
      `/task/${encodeURIComponent(taskId)}/comment`,
      z.unknown(),
      JSON.stringify({ comment_text: text, notify_all: false }),
    );
  }

  async uploadAttachment(taskId: string, file: string): Promise<z.infer<typeof AttachmentResponse>> {
    const form = new FormData();
    form.append('attachment', new Blob([fs.readFileSync(file)]), path.basename(file));
    log.debug(`uploading ${path.basename(file)} to task ${taskId}`);
    return this.request(
      'POST',
      `/task/${encodeURIComponent(taskId)}/attachment`,
      AttachmentResponse,
      form,
      false,
    );
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClickUpClient, ClickUpError, PRIORITY } from '../src/integrations/clickup.js';
import { renderBugMarkdown } from '../src/bugs/report.js';
import type { Issue } from '../src/triage/schema.js';
import { makeProject } from './helpers.js';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe('ClickUpClient', () => {
  it('creates a task with markdown, tags and priority using the token header', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { id: '86abc', name: 'x', url: 'https://app.clickup.com/t/86abc' },
    }));
    const client = new ClickUpClient('pk_test', fetch);
    const task = await client.createTask('123', {
      name: 'Bug',
      markdown: '# md',
      tags: ['ai-qa-agent'],
      priority: PRIORITY.high,
      status: 'to do',
    });
    expect(task.url).toBe('https://app.clickup.com/t/86abc');
    expect(calls[0]!.url).toBe('https://api.clickup.com/api/v2/list/123/task');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('pk_test');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      name: 'Bug',
      markdown_content: '# md',
      tags: ['ai-qa-agent'],
      priority: 2,
      status: 'to do',
    });
  });

  it('omits status when not configured so the list default applies', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { id: '1', name: 'x' } }));
    await new ClickUpClient('pk', fetch).createTask('123', {
      name: 'B',
      markdown: '',
      tags: [],
      priority: 3,
    });
    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty('status');
  });

  it('uploads attachments as multipart form data', async () => {
    const root = makeProject({ 'shot.png': 'png-bytes' });
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { id: 'att1', url: 'https://x/att1.png' },
    }));
    const client = new ClickUpClient('pk_test', fetch);
    await client.uploadAttachment('86abc', path.join(root, 'shot.png'));
    const body = calls[0]!.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const file = body.get('attachment') as File;
    expect(file.name).toBe('shot.png');
    expect(await file.text()).toBe(fs.readFileSync(path.join(root, 'shot.png'), 'utf8'));
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('throws ClickUpError with the HTTP status on failure', async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: { err: 'Token invalid', ECODE: 'OAUTH_017' } }));
    const client = new ClickUpClient('bad', fetch);
    await expect(client.getList('1')).rejects.toMatchObject({ status: 401 } satisfies Partial<ClickUpError>);
  });

  it('rejects responses that do not match the expected shape', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { nope: true } }));
    await expect(new ClickUpClient('pk', fetch).getList('1')).rejects.toBeInstanceOf(ClickUpError);
  });
});

describe('renderBugMarkdown', () => {
  it('renders every required section', () => {
    const issue: Issue = {
      id: 'BUG-001',
      fingerprint: 'abc',
      classification: 'PRODUCT_BUG',
      bug: {
        title: 'Coupon not applied',
        severity: 'high',
        category: 'functional',
        affectedPage: '/checkout',
        stepsToReproduce: ['Open checkout', 'Apply SAVE10'],
        expectedResult: 'Total is discounted',
        actualResult: 'Total unchanged',
        suspectedRootCause: 'CheckoutPage.tsx:29',
      },
      failureKeys: ['CHECKOUT-002@chromium-desktop'],
      scenarioIds: ['CHECKOUT-002'],
      confidence: 0.95,
      fileable: true,
      notFiledReason: null,
    };
    const md = renderBugMarkdown(
      issue,
      {
        baseUrl: 'http://localhost:5173',
        browsers: ['chromium'],
        os: 'Windows',
        node: 'v26',
        commit: 'abc123',
        runId: 'r1',
      },
      [
        {
          key: 'CHECKOUT-002@chromium-desktop',
          project: 'chromium-desktop',
          screenshot: 's.png',
          video: 'v.webm',
          trace: 't.zip',
          design: [],
          errorContext: null,
        },
      ],
    );
    for (const section of [
      'Severity:** High',
      '## Steps to reproduce',
      '1. Open checkout',
      '## Expected result',
      '## Actual result',
      '## Suspected root cause',
      '## Environment',
      'Commit: abc123',
      '## Evidence',
      'v.webm',
      't.zip',
      '`CHECKOUT-002`',
    ]) {
      expect(md).toContain(section);
    }
  });
});

describe('ClickUpClient.taskExists', () => {
  it('reports existing, deleted and missing tasks', async () => {
    const existing = fakeFetch(() => ({
      status: 200,
      body: { id: 'a', url: 'https://app.clickup.com/t/a', status: { status: 'to do' } },
    }));
    expect(await new ClickUpClient('pk', existing.fetch).taskExists('a')).toEqual({
      exists: true,
      url: 'https://app.clickup.com/t/a',
      status: 'to do',
    });
    const deleted = fakeFetch(() => ({ status: 200, body: { id: 'b', deleted: true } }));
    expect((await new ClickUpClient('pk', deleted.fetch).taskExists('b')).exists).toBe(false);
    const missing = fakeFetch(() => ({ status: 404, body: { err: 'Task not found', ECODE: 'ITEM_013' } }));
    expect(await new ClickUpClient('pk', missing.fetch).taskExists('c')).toEqual({ exists: false });
  });
});

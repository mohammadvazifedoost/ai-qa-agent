import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QaConfigSchema, type QaConfigInput } from '../src/config/schema.js';
import { markdownToAdf } from '../src/integrations/adf.js';
import { JiraClient, JiraError } from '../src/integrations/jira.js';
import { createTracker, FilingUnavailable, trackerInfo, trackerKind } from '../src/integrations/tracker.js';
import { makeProject } from './helpers.js';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (call: Call, n: number) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const { status, body } = handler(call, calls.length);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const headers = (c: Call): Record<string, string> => c.init.headers as Record<string, string>;

describe('markdownToAdf', () => {
  it('converts headings, nested lists, paragraphs with hard breaks and inline marks', () => {
    const doc = markdownToAdf(
      [
        '**Severity:** High  ',
        '**Category:** functional',
        '',
        '## Steps to reproduce',
        '1. Open `/checkout`',
        '2. Apply **SAVE10**',
        '',
        '## Evidence',
        '- **CHECKOUT-002@chromium-desktop**',
        '  - Video: `run/videos/a.webm`',
        '',
        '_Reported by AI QA Agent._ See [docs](https://example.com).',
      ].join('\n'),
    );
    expect(doc.type).toBe('doc');
    expect(doc.version).toBe(1);
    const [p1, h1, ol, h2, ul, p2] = doc.content;
    expect(p1).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Severity:', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' High' },
        { type: 'hardBreak' },
        { type: 'text', text: 'Category:', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' functional' },
      ],
    });
    expect(h1).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Steps to reproduce' }],
    });
    expect(ol!.type).toBe('orderedList');
    expect(ol!.content).toHaveLength(2);
    expect(ol!.content![0]!.content![0]!.content).toEqual([
      { type: 'text', text: 'Open ' },
      { type: 'text', text: '/checkout', marks: [{ type: 'code' }] },
    ]);
    expect(h2!.type).toBe('heading');
    expect(ul!.type).toBe('bulletList');
    const nested = ul!.content![0]!.content![1]!;
    expect(nested.type).toBe('bulletList');
    expect(nested.content![0]!.content![0]!.content![1]).toEqual({
      type: 'text',
      text: 'run/videos/a.webm',
      marks: [{ type: 'code' }],
    });
    expect(p2!.content).toEqual([
      { type: 'text', text: 'Reported by AI QA Agent.', marks: [{ type: 'em' }] },
      { type: 'text', text: ' See ' },
      { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
      { type: 'text', text: '.' },
    ]);
  });
});

describe('JiraClient', () => {
  const client = (fetchImpl: typeof fetch): JiraClient =>
    new JiraClient('https://acme.atlassian.net/', 'qa@acme.io', 'tok', fetchImpl);

  it('creates an issue with ADF description, labels, priority and basic auth', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 201,
      body: { id: '10001', key: 'SHOP-7', self: 'x' },
    }));
    const r = await client(fetch).createIssue('SHOP', {
      summary: 'Coupon not applied',
      markdown: '## Expected\nTotal is discounted',
      labels: ['ai-qa-agent', 'needs verification'],
      issueType: 'Bug',
      priority: 'High',
    });
    expect(r).toEqual({ id: '10001', key: 'SHOP-7', url: 'https://acme.atlassian.net/browse/SHOP-7' });
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/issue');
    expect(headers(calls[0]!).Authorization).toBe(
      `Basic ${Buffer.from('qa@acme.io:tok').toString('base64')}`,
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.fields).toMatchObject({
      project: { key: 'SHOP' },
      summary: 'Coupon not applied',
      issuetype: { name: 'Bug' },
      labels: ['ai-qa-agent', 'needs-verification'],
      priority: { name: 'High' },
    });
    expect(body.fields.description.type).toBe('doc');
  });

  it('retries without priority when the project rejects it', async () => {
    const { fetch, calls } = fakeFetch((_c, n) =>
      n === 1
        ? { status: 400, body: { errorMessages: [], errors: { priority: 'Field cannot be set.' } } }
        : { status: 201, body: { id: '1', key: 'SHOP-8' } },
    );
    const r = await client(fetch).createIssue('SHOP', {
      summary: 's',
      markdown: 'm',
      labels: [],
      issueType: 'Bug',
      priority: 'High',
    });
    expect(r.key).toBe('SHOP-8');
    expect(JSON.parse(calls[1]!.init.body as string).fields.priority).toBeUndefined();
  });

  it('surfaces Jira error messages', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 400,
      body: { errorMessages: ['Issue type is invalid'], errors: { issuetype: 'Specify a valid issue type' } },
    }));
    await expect(
      client(fetch).createIssue('SHOP', { summary: 's', markdown: 'm', labels: [], issueType: 'Bogus' }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Issue type is invalid; issuetype: Specify a valid issue type'),
    });
  });

  it('uploads attachments with the XSRF header and a "file" form field', async () => {
    const root = makeProject({ 'shot.png': 'png-bytes' });
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: [{ id: '1' }] }));
    await client(fetch).uploadAttachment('SHOP-7', path.join(root, 'shot.png'));
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/issue/SHOP-7/attachments');
    expect(headers(calls[0]!)['X-Atlassian-Token']).toBe('no-check');
    expect(headers(calls[0]!)['Content-Type']).toBeUndefined();
    const file = (calls[0]!.init.body as FormData).get('file') as File;
    expect(file.name).toBe('shot.png');
    expect(await file.text()).toBe(fs.readFileSync(path.join(root, 'shot.png'), 'utf8'));
  });

  it('checks existence (404 = gone) and adds ADF comments', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.includes('SHOP-1?')
        ? { status: 200, body: { key: 'SHOP-1', fields: { status: { name: 'To Do' } } } }
        : c.url.includes('SHOP-2?')
          ? { status: 404, body: { errorMessages: ['Issue does not exist'] } }
          : { status: 201, body: { id: 'c1' } },
    );
    const c = client(fetch);
    expect(await c.issueExists('SHOP-1')).toEqual({
      exists: true,
      url: 'https://acme.atlassian.net/browse/SHOP-1',
      status: 'To Do',
    });
    expect(await c.issueExists('SHOP-2')).toEqual({ exists: false });
    await c.addComment('SHOP-1', 'still failing');
    expect(JSON.parse(calls[2]!.init.body as string).body.content[0].content[0].text).toBe('still failing');
  });

  it('requires credentials', () => {
    expect(() => new JiraClient('https://a.atlassian.net', '', 'tok')).toThrow(JiraError);
  });
});

describe('tracker selection', () => {
  const base: QaConfigInput = {
    project: { name: 'x' },
    app: { baseUrl: 'http://localhost:3000' },
    source: { include: ['src'] },
  };
  const jira = { baseUrl: 'https://acme.atlassian.net', projectKey: 'SHOP' };

  it('uses the only configured tracker and rejects ambiguous configs', () => {
    expect(trackerKind(QaConfigSchema.parse({ ...base, jira }))).toBe('jira');
    expect(trackerKind(QaConfigSchema.parse({ ...base, clickup: { listId: '1' } }))).toBe('clickup');
    expect(trackerKind(QaConfigSchema.parse(base))).toBeNull();
    expect(QaConfigSchema.safeParse({ ...base, jira, clickup: { listId: '1' } }).success).toBe(false);
    expect(
      trackerKind(QaConfigSchema.parse({ ...base, jira, clickup: { listId: '1' }, tracker: 'jira' })),
    ).toBe('jira');
    expect(QaConfigSchema.safeParse({ ...base, tracker: 'jira' }).success).toBe(false);
    expect(QaConfigSchema.safeParse({ ...base, jira: { ...jira, projectKey: 'shop' } }).success).toBe(false);
  });

  it('reports missing Jira credentials without touching the network', () => {
    const config = QaConfigSchema.parse({ ...base, jira });
    expect(trackerInfo(config, {})).toMatchObject({
      kind: 'jira',
      name: 'Jira',
      noun: 'issue',
      credentialsPresent: false,
      target: 'project SHOP',
    });
    expect(trackerInfo(config, { JIRA_API_TOKEN: 't', JIRA_EMAIL: 'a@b.c' }).credentialsPresent).toBe(true);
    expect(() => createTracker(config, {})).toThrow(FilingUnavailable);
    expect(() => createTracker(config, { JIRA_API_TOKEN: 't' })).toThrow(/JIRA_EMAIL/);
    expect(createTracker(config, { JIRA_API_TOKEN: 't', JIRA_EMAIL: 'a@b.c' }).noun).toBe('issue');
  });

  it('files through the Jira tracker with configured labels and priority mapping', async () => {
    const config = QaConfigSchema.parse({ ...base, jira: { ...jira, labels: ['qa'] } });
    const { fetch, calls } = fakeFetch(() => ({ status: 201, body: { id: '1', key: 'SHOP-3' } }));
    const t = createTracker(config, { JIRA_API_TOKEN: 't', JIRA_EMAIL: 'a@b.c' }, fetch);
    expect(await t.create({ title: 'T', markdown: 'M', labels: ['bug'], severity: 'critical' })).toEqual({
      id: 'SHOP-3',
      url: 'https://acme.atlassian.net/browse/SHOP-3',
    });
    const fields = JSON.parse(calls[0]!.init.body as string).fields;
    expect(fields.labels).toEqual(['qa', 'bug']);
    expect(fields.priority).toEqual({ name: 'Highest' });
  });
});

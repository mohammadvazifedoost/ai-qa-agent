import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { appUrl } from '../src/ui/client/api.js';
import { fileUrl } from '../src/ui/client/logic.js';
import { appPath, normalizeBasePath, startUi, withBaseHref } from '../src/ui/server.js';
import type { QaContext } from '../src/pipeline/context.js';

describe('dashboard base path', () => {
  it('normalizes the base path and refuses anything but plain path segments', () => {
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('/blog/admin/qa/')).toBe('/blog/admin/qa');
    expect(normalizeBasePath('qa')).toBe('/qa');
    expect(normalizeBasePath('C:/Program Files/Git/blog/admin/qa')).toBe('/blog/admin/qa');
    for (const bad of ['/qa"><script>', '/a/../b', '/a b', '/a?b', 'https://x/qa']) {
      expect(() => normalizeBasePath(bad)).toThrow(/--base-path/);
    }
  });

  it('maps proxied paths back to the dashboard routes', () => {
    expect(appPath('/api/job', '')).toBe('/api/job');
    expect(appPath('/blog/admin/qa', '/blog/admin/qa')).toBe('/');
    expect(appPath('/blog/admin/qa/', '/blog/admin/qa')).toBe('/');
    expect(appPath('/blog/admin/qa/api/job', '/blog/admin/qa')).toBe('/api/job');
    // A proxy that already removed the prefix.
    expect(appPath('/api/job', '/blog/admin/qa')).toBe('/api/job');
    expect(appPath('/blog/admin/qax/api', '/blog/admin/qa')).toBe('/blog/admin/qax/api');
  });

  it('adds a <base href> to the page only when a base path is set', () => {
    const html = '<html><head><title>x</title></head></html>';
    expect(withBaseHref(html, '')).toBe(html);
    expect(withBaseHref(html, '/qa')).toContain('<head>\n    <base href="/qa/" />');
  });

  it('requests the API and evidence relative to the page', () => {
    expect(appUrl('/api/overview?run=1')).toBe('api/overview?run=1');
    expect(fileUrl('.qa/artifacts/runs/a b/v.webm')).toBe('files/.qa/artifacts/runs/a%20b/v.webm');
  });
});

describe('startUi with a base path', () => {
  let server: http.Server | undefined;
  afterEach(() => server?.close());

  const get = (port: number, p: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: p }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });

  it('answers the API under the base path and without it', async () => {
    // The job route reads no project state.
    server = await startUi({} as QaContext, { port: 0, host: '127.0.0.1', basePath: '/blog/admin/qa' });
    const { port } = server.address() as AddressInfo;
    expect((await get(port, '/blog/admin/qa/api/job')).body).toBe('{"job":null}');
    expect((await get(port, '/api/job')).body).toBe('{"job":null}');
    expect((await get(port, '/blog/admin/qa/nothing')).status).toBe(404);
  });
});

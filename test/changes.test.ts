import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fileHashes,
  globalFilesOf,
  pageHash,
  type AppModelFile,
  type PageModel,
} from '../src/analyze/app.js';
import { describeChanges, detectCodeChanges, pageStructureHashes } from '../src/changes/detect.js';
import type { QaContext } from '../src/pipeline/context.js';
import { qaPaths } from '../src/core/paths.js';
import { makeProject } from './helpers.js';

function page(route: string, files: string[]): PageModel {
  return {
    route,
    name: route,
    purpose: '',
    importance: 'secondary',
    access: 'public',
    navigatesTo: [],
    files,
    headings: [],
    interactiveElements: [],
    forms: [],
    states: { loading: null, empty: null, error: null },
    dataDependencies: [],
    preconditions: [],
    responsiveBehavior: [],
    businessRules: [],
  };
}

function project(): { root: string; ctx: QaContext } {
  const root = makeProject({
    'package.json': {
      name: 'app',
      dependencies: { react: '19', 'react-router-dom': '7' },
      devDependencies: { vite: '6' },
    },
    'src/main.tsx': `createBrowserRouter([{ path: '/', element: <Home/> }, { path: '/login', element: <Login/> }]);`,
    'src/Layout.tsx': 'layout v1',
    'src/pages/Home.tsx': 'home v1',
    'src/pages/Login.tsx': 'login v1',
  });
  fs.mkdirSync(path.join(root, '.qa'));
  const ctx = { root, paths: qaPaths(root) } as QaContext;
  return { root, ctx };
}

function model(root: string, pages: PageModel[]): AppModelFile {
  const globalFiles = globalFilesOf(pages);
  return {
    summary: '',
    pages,
    flows: [],
    auth: null,
    stateManagement: '',
    integrations: [],
    modelVersion: 2,
    testData: [],
    styling: { approach: '', tokens: {} },
    unknowns: [],
    analyzedAt: '',
    pageHashes: Object.fromEntries(pages.map((p) => [p.route, pageHash(root, p, globalFiles)])),
    globalFileHashes: fileHashes(root, globalFiles),
  };
}

describe('detectCodeChanges', () => {
  it('treats files shared by every page as global', () => {
    const pages = [
      page('/', ['src/main.tsx', 'src/Layout.tsx', 'src/pages/Home.tsx']),
      page('/login', ['src/main.tsx', 'src/Layout.tsx', 'src/pages/Login.tsx']),
    ];
    expect(globalFilesOf(pages)).toEqual(['src/Layout.tsx', 'src/main.tsx']);
  });

  it('reports nothing when nothing changed', () => {
    const { root, ctx } = project();
    const pages = [
      page('/', ['src/main.tsx', 'src/Layout.tsx', 'src/pages/Home.tsx']),
      page('/login', ['src/main.tsx', 'src/Layout.tsx', 'src/pages/Login.tsx']),
    ];
    const c = detectCodeChanges(ctx, model(root, pages));
    expect(c).toMatchObject({
      newPages: [],
      changedPages: [],
      removedPages: [],
      changedGlobalFiles: [],
      hasModel: true,
    });
    expect(describeChanges(c)).toEqual(['code: no changes since the last analysis']);
  });

  it('detects a new route, a changed page and a changed global file independently', () => {
    const { root, ctx } = project();
    const pages = [
      page('/', ['src/main.tsx', 'src/Layout.tsx', 'src/pages/Home.tsx']),
      page('/login', ['src/main.tsx', 'src/Layout.tsx', 'src/pages/Login.tsx']),
    ];
    const m = model(root, pages);
    // Register a new route (touches the global router file) and edit one page.
    fs.writeFileSync(
      path.join(root, 'src/main.tsx'),
      `createBrowserRouter([{ path: '/' }, { path: '/login' }, { path: '/contact' }]);`,
    );
    fs.writeFileSync(path.join(root, 'src/pages/Login.tsx'), 'login v2');
    const c = detectCodeChanges(ctx, m);
    expect(c.newPages).toEqual([{ route: '/contact', file: 'src/main.tsx' }]);
    expect(c.changedPages).toEqual(['/login']);
    expect(c.unchangedPages).toEqual(['/']);
    expect(c.changedGlobalFiles).toEqual(['src/main.tsx']);
    expect(describeChanges(c).join('\n')).toContain('changed shared file  src/main.tsx');
  });

  it('detects removed pages', () => {
    const { root, ctx } = project();
    const pages = [
      page('/', ['src/main.tsx', 'src/pages/Home.tsx']),
      page('/login', ['src/main.tsx', 'src/pages/Login.tsx']),
    ];
    const m = model(root, pages);
    fs.rmSync(path.join(root, 'src/pages/Login.tsx'));
    expect(detectCodeChanges(ctx, m).removedPages).toEqual(['/login']);
  });

  it('reports everything as new without a model', () => {
    const { ctx } = project();
    const c = detectCodeChanges(ctx, undefined);
    expect(c.hasModel).toBe(false);
    expect(c.newPages.map((p) => p.route).sort()).toEqual(['/', '/login']);
  });
});

describe('pageStructureHashes', () => {
  it('hashes get_metadata page results by node id and ignores errors', () => {
    const calls = [
      {
        name: 'mcp__figma__get_metadata',
        input: { nodeId: '0:1' },
        text: '<canvas id="0:1"><frame id="2:2" /></canvas>',
        isError: false,
      },
      { name: 'mcp__figma__get_metadata', input: { nodeId: '1:33' }, text: 'quota exceeded', isError: true },
      { name: 'mcp__figma__get_metadata', input: {}, text: 'pages: ...', isError: false },
    ];
    const h = pageStructureHashes(calls);
    expect(Object.keys(h)).toEqual(['0:1']);
    const same = pageStructureHashes([
      { ...calls[0]!, text: '<canvas id="0:1">  <frame id="2:2" />\n</canvas>' },
    ]);
    expect(same['0:1']).toBe(h['0:1']);
  });
});

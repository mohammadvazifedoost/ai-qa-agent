import { describe, expect, it } from 'vitest';
import { detectProject } from '../src/discovery/detect.js';
import { makeProject } from './helpers.js';

describe('detectProject', () => {
  it('detects a Next.js app-router project with pnpm, tailwind and shadcn', () => {
    const root = makeProject({
      'package.json': {
        name: 'web',
        scripts: { dev: 'next dev --port 4000', build: 'next build' },
        dependencies: { next: '15', react: '19' },
        devDependencies: { typescript: '5', tailwindcss: '4', '@playwright/test': '1' },
      },
      'pnpm-lock.yaml': '',
      'components.json': '{}',
      'playwright.config.ts': '',
      'app/page.tsx': '',
      'app/(shop)/checkout/page.tsx': '',
      'app/products/[id]/page.tsx': '',
      'app/api/health/route.ts': '',
      'components/ui/button.tsx': '',
      'e2e/home.spec.ts': '',
    });
    const info = detectProject(root);
    expect(info.framework).toBe('next');
    expect(info.packageManager).toBe('pnpm');
    expect(info.typescript).toBe(true);
    expect(info.devCommand).toBe('pnpm dev');
    expect(info.devPort).toBe(4000);
    expect(info.styling).toEqual(['tailwind']);
    expect(info.designSystem).toContain('shadcn/ui');
    expect(info.routingStyle).toBe('next-app');
    expect(info.routes.map((r) => r.path)).toEqual(['/', '/checkout', '/products/:id']);
    expect(info.playwright).toEqual({ installed: true, configFile: 'playwright.config.ts' });
    expect(info.existingTests).toEqual(['e2e/home.spec.ts']);
    expect(info.componentDirs).toContain('components/ui');
  });

  it('detects Nuxt file-based pages', () => {
    const root = makeProject({
      'package.json': { dependencies: { nuxt: '3', vue: '3' }, scripts: { dev: 'nuxt dev' } },
      'pages/index.vue': '',
      'pages/login.vue': '',
      'pages/blog/[slug].vue': '',
    });
    const info = detectProject(root);
    expect(info.framework).toBe('nuxt');
    expect(info.uiLibrary).toBe('vue');
    expect(info.devPort).toBe(3000);
    expect(info.routes.map((r) => r.path)).toEqual(['/', '/blog/:slug', '/login']);
  });

  it('detects SvelteKit routes', () => {
    const root = makeProject({
      'package.json': { devDependencies: { '@sveltejs/kit': '2', svelte: '5', vite: '6' } },
      'src/routes/+page.svelte': '',
      'src/routes/about/+page.svelte': '',
    });
    const info = detectProject(root);
    expect(info.framework).toBe('sveltekit');
    expect(info.routes.map((r) => r.path)).toEqual(['/', '/about']);
  });

  it('falls back to code-defined routes for a Vite + React Router app', () => {
    const root = makeProject({
      'package.json': {
        dependencies: { react: '19', 'react-router-dom': '7' },
        devDependencies: { vite: '6' },
        scripts: { dev: 'vite' },
      },
      'yarn.lock': '',
      'src/main.tsx': `createBrowserRouter([{ path: '/', element: <A/> }, { path: '/cart', element: <B/> }]);`,
      'src/App.tsx': `<Routes><Route path="/about" element={<C/>} /></Routes>`,
    });
    const info = detectProject(root);
    expect(info.framework).toBe('vite');
    expect(info.packageManager).toBe('yarn');
    expect(info.devCommand).toBe('yarn dev');
    expect(info.routingStyle).toBe('code-router');
    expect(info.routes.map((r) => r.path).sort()).toEqual(['/', '/about', '/cart']);
  });

  it('throws a helpful error without package.json', () => {
    const root = makeProject({ 'index.html': '' });
    expect(() => detectProject(root)).toThrow(/No package.json/);
  });
});

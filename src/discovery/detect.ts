import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { listFiles } from '../core/fs.js';
import { rel } from '../core/paths.js';

/**
 * Deterministic, file-system based project discovery. Nothing here guesses with an LLM:
 * every field is derived from files that actually exist, so `init` is fast, free and
 * reproducible. The AI analysis stage builds on top of this snapshot.
 */
export const ProjectInfoSchema = z.object({
  name: z.string(),
  packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']),
  typescript: z.boolean(),
  framework: z.string(),
  uiLibrary: z.string().nullable(),
  styling: z.array(z.string()),
  designSystem: z.array(z.string()),
  scripts: z.record(z.string(), z.string()),
  devCommand: z.string().nullable(),
  buildCommand: z.string().nullable(),
  devPort: z.number().nullable(),
  devHost: z.string().nullable(),
  sourceDirs: z.array(z.string()),
  componentDirs: z.array(z.string()),
  routes: z.array(z.object({ path: z.string(), file: z.string() })),
  routingStyle: z.string(),
  playwright: z.object({ installed: z.boolean(), configFile: z.string().nullable() }),
  existingTests: z.array(z.string()),
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

const PackageJson = z.looseObject({
  name: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

const EXCLUDE = ['node_modules', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage', '.qa', 'out'];

function detectPackageManager(root: string): ProjectInfo['packageManager'] {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** Ordered: meta-frameworks first because they also depend on their base library. */
const FRAMEWORKS: Array<[dep: string, name: string, port: number]> = [
  ['next', 'next', 3000],
  ['nuxt', 'nuxt', 3000],
  ['@remix-run/react', 'remix', 5173],
  ['@react-router/dev', 'react-router', 5173],
  ['@sveltejs/kit', 'sveltekit', 5173],
  ['astro', 'astro', 4321],
  ['@angular/core', 'angular', 4200],
  ['gatsby', 'gatsby', 8000],
  ['react-scripts', 'create-react-app', 3000],
  ['vite', 'vite', 5173],
];

const UI_LIBS = ['react', 'vue', 'svelte', 'solid-js', 'preact', '@angular/core', 'lit'];

const DESIGN_SYSTEM_DEPS: Record<string, string> = {
  '@mui/material': 'MUI',
  '@chakra-ui/react': 'Chakra UI',
  antd: 'Ant Design',
  '@mantine/core': 'Mantine',
  'react-bootstrap': 'React Bootstrap',
  vuetify: 'Vuetify',
  'element-plus': 'Element Plus',
  '@radix-ui/react-slot': 'Radix UI',
  '@headlessui/react': 'Headless UI',
  primevue: 'PrimeVue',
  '@nextui-org/react': 'NextUI',
};

const STYLING_DEPS: Record<string, string> = {
  tailwindcss: 'tailwind',
  '@tailwindcss/vite': 'tailwind',
  'styled-components': 'styled-components',
  '@emotion/react': 'emotion',
  sass: 'sass',
  '@vanilla-extract/css': 'vanilla-extract',
};

function portFromScript(script: string | undefined): number | null {
  const m = script?.match(/(?:--port[= ]|-p\s+|PORT=)(\d{2,5})/);
  return m ? Number(m[1]) : null;
}

/** Explicit bind host from the dev script (e.g. `--host 127.0.0.1`), or null. */
function hostFromScript(script: string | undefined): string | null {
  const m = script?.match(/(?:--host[= ]|-H\s+|HOST=)([\w.:[\]-]+)/);
  if (!m) return null;
  const host = m[1]!;
  return host === '0.0.0.0' || host === '::' || host === 'true' ? null : host;
}

function routeFromFile(relFile: string, base: string, style: string): string {
  let r = relFile.slice(base.length).replace(/\.[a-z]+$/i, '');
  if (style === 'next-app') r = r.replace(/\/page$/, '');
  else if (style === 'sveltekit') r = r.replace(/\/\+page(\.[a-z]+)?$/, '');
  else if (style === 'remix')
    r = r
      .replace(/\./g, '/')
      .replace(/^\/?_index$/, '')
      .replace(/\/_index$/, '');
  r = r.replace(/\/index$/, '').replace(/\/\([^)]+\)/g, ''); // route groups like (marketing)
  r = r
    .replace(/\[\.\.\.([^\]]+)\]/g, ':$1*')
    .replace(/\[([^\]]+)\]/g, ':$1')
    .replace(/\$([a-zA-Z]+)/g, ':$1');
  return r === '' ? '/' : r.startsWith('/') ? r : '/' + r;
}

function detectRoutes(root: string, framework: string): { style: string; routes: ProjectInfo['routes'] } {
  const candidates: Array<{ dir: string; style: string; match: RegExp }> = [
    { dir: 'app', style: 'next-app', match: /\/page\.(tsx|jsx|ts|js|mdx)$/ },
    { dir: 'src/app', style: 'next-app', match: /\/page\.(tsx|jsx|ts|js|mdx)$/ },
    { dir: 'pages', style: 'file-pages', match: /\.(tsx|jsx|ts|js|vue|astro|md|mdx)$/ },
    { dir: 'src/pages', style: 'file-pages', match: /\.(tsx|jsx|ts|js|vue|astro|md|mdx)$/ },
    { dir: 'src/routes', style: 'sveltekit', match: /\/\+page\.(svelte|ts|js)$/ },
    { dir: 'app/routes', style: 'remix', match: /\.(tsx|jsx|ts|js)$/ },
  ];
  for (const c of candidates) {
    if (framework !== 'next' && c.style === 'next-app') continue;
    if (!['sveltekit'].includes(framework) && c.style === 'sveltekit') continue;
    if (!['remix', 'react-router'].includes(framework) && c.style === 'remix') continue;
    if (c.style === 'file-pages' && !['next', 'nuxt', 'astro', 'gatsby'].includes(framework)) continue;
    const dir = path.join(root, c.dir);
    if (!fs.existsSync(dir)) continue;
    const files = listFiles(dir, EXCLUDE)
      .map((f) => '/' + rel(dir, f))
      .filter((f) => c.match.test(f))
      .filter((f) => !/\/(_app|_document|_error|api\/)/.test(f) && !f.startsWith('/api/'));
    if (files.length === 0) continue;
    const routes = files
      .map((f) => ({ path: routeFromFile(f, '', c.style), file: `${c.dir}${f}` }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { style: c.style, routes };
  }
  return detectCodeRoutes(root);
}

/** Config-based routers (React Router, Vue Router, ...): find `path: '/x'` / `<Route path="/x">`. */
function detectCodeRoutes(root: string): { style: string; routes: ProjectInfo['routes'] } {
  const src = path.join(root, 'src');
  const files = listFiles(fs.existsSync(src) ? src : root, EXCLUDE).filter((f) =>
    /\.(tsx|jsx|ts|js|vue)$/.test(f),
  );
  const routes: ProjectInfo['routes'] = [];
  const seen = new Set<string>();
  const re = /(?:<Route[^>]*\bpath=|\bpath:\s*)["'`](\/[^"'`]*)["'`]/g;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (!/Route|createBrowserRouter|createRouter|routes/.test(text)) continue;
    for (const m of text.matchAll(re)) {
      const p = m[1]!;
      if (seen.has(p)) continue;
      seen.add(p);
      routes.push({ path: p, file: rel(root, f) });
    }
  }
  return { style: routes.length ? 'code-router' : 'unknown', routes };
}

function detectExistingTests(root: string): string[] {
  return listFiles(root, EXCLUDE)
    .map((f) => rel(root, f))
    .filter((f) => /\.(spec|test|e2e)\.(t|j)sx?$/.test(f) || /^cypress\//.test(f))
    .slice(0, 200);
}

export function detectProject(root: string): ProjectInfo {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`No package.json found in ${root}. Run AI QA Agent inside a web project.`);
  }
  const pkg = PackageJson.parse(JSON.parse(fs.readFileSync(pkgPath, 'utf8')));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (d: string): boolean => d in deps;
  const scripts = pkg.scripts ?? {};
  const pm = detectPackageManager(root);
  const runPrefix = pm === 'npm' ? 'npm run' : pm;

  const fw = FRAMEWORKS.find(([dep]) => has(dep));
  const framework = fw?.[1] ?? 'unknown';
  const devScript = ['dev', 'start', 'serve', 'develop'].find((s) => scripts[s]);
  const devPort = portFromScript(devScript ? scripts[devScript] : undefined) ?? fw?.[2] ?? null;

  const sourceDirs = [
    'src',
    'app',
    'pages',
    'components',
    'lib',
    'layouts',
    'routes',
    'views',
    'composables',
    'hooks',
    'styles',
  ].filter((d) => fs.existsSync(path.join(root, d)));
  const componentDirs = listFiles(root, EXCLUDE)
    .map((f) => rel(root, path.dirname(f)))
    .filter((d, i, all) => /(^|\/)(components|ui)$/.test(d) && all.indexOf(d) === i);

  const designSystem = Object.entries(DESIGN_SYSTEM_DEPS)
    .filter(([dep]) => has(dep))
    .map(([, name]) => name);
  if (fs.existsSync(path.join(root, 'components.json'))) designSystem.push('shadcn/ui');

  const styling = [
    ...new Set(
      Object.entries(STYLING_DEPS)
        .filter(([dep]) => has(dep))
        .map(([, n]) => n),
    ),
  ];
  if (styling.length === 0) styling.push('css');

  const pwConfig = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].find((f) =>
    fs.existsSync(path.join(root, f)),
  );
  const { style, routes } = detectRoutes(root, framework);

  return {
    name: pkg.name ?? path.basename(root),
    packageManager: pm,
    typescript: has('typescript') || fs.existsSync(path.join(root, 'tsconfig.json')),
    framework,
    uiLibrary: UI_LIBS.find(has) ?? null,
    styling,
    designSystem,
    scripts,
    devCommand: devScript ? `${runPrefix} ${devScript}` : null,
    buildCommand: scripts.build ? `${runPrefix} build` : null,
    devPort,
    devHost: hostFromScript(devScript ? scripts[devScript] : undefined),
    sourceDirs,
    componentDirs,
    routes,
    routingStyle: style,
    playwright: { installed: has('@playwright/test'), configFile: pwConfig ?? null },
    existingTests: detectExistingTests(root),
  };
}

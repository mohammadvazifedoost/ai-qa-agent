import path from 'node:path';

/** All well-known locations inside a target project's `.qa/` directory. */
export interface QaPaths {
  root: string;
  qaDir: string;
  config: string;
  rules: string;
  state: string;
  appModel: string;
  designSystem: string;
  designRefsDir: string;
  scenariosDir: string;
  testsDir: string;
  playwrightConfig: string;
  artifactsDir: string;
  reportsDir: string;
  logsDir: string;
}

export function qaPaths(root: string): QaPaths {
  const qaDir = path.join(root, '.qa');
  const artifactsDir = path.join(qaDir, 'artifacts');
  return {
    root,
    qaDir,
    config: path.join(qaDir, 'config.ts'),
    rules: path.join(qaDir, 'rules.md'),
    state: path.join(qaDir, 'state.json'),
    appModel: path.join(qaDir, 'app-model.json'),
    designSystem: path.join(qaDir, 'design-system.json'),
    designRefsDir: path.join(qaDir, 'design', 'refs'),
    scenariosDir: path.join(qaDir, 'scenarios'),
    testsDir: path.join(qaDir, 'tests'),
    playwrightConfig: path.join(qaDir, 'playwright.config.ts'),
    artifactsDir,
    reportsDir: path.join(qaDir, 'reports'),
    logsDir: path.join(artifactsDir, 'logs'),
  };
}

/** Directory for one pipeline run's artifacts. */
export function runDir(paths: QaPaths, runId: string): string {
  return path.join(paths.artifactsDir, 'runs', runId);
}

/** Forward-slash relative path, stable across OSes (used in reports and state). */
export function rel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

/** True when `abs` is `dir` itself or a path below it (both absolute and resolved). */
export function isInside(dir: string, abs: string): boolean {
  return abs === dir || abs.startsWith(dir + path.sep);
}

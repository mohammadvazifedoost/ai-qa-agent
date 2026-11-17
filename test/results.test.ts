import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGrep, fileFilterArg, writePlaywrightLog } from '../src/runner/run.js';
import { collectOutcomes, PwReportSchema, scenarioIdFromTitle } from '../src/runner/results.js';
import { normalizePageArg } from '../src/scenarios/generate.js';
import { makeProject } from './helpers.js';

describe('scenarioIdFromTitle / normalizePageArg', () => {
  it('extracts scenario ids', () => {
    expect(scenarioIdFromTitle('CHECKOUT-002: Valid coupon')).toBe('CHECKOUT-002');
    expect(scenarioIdFromTitle('no id here')).toBeNull();
  });

  it('normalizes page arguments, including Git Bash path mangling', () => {
    expect(normalizePageArg('checkout')).toBe('/checkout');
    expect(normalizePageArg('/checkout')).toBe('/checkout');
    expect(normalizePageArg('home')).toBe('/');
    expect(normalizePageArg('C:/Program Files/Git/checkout')).toBe('/checkout');
  });
});

describe('buildGrep / fileFilterArg', () => {
  it('builds tag and id filters', () => {
    expect(buildGrep({})).toBeUndefined();
    expect(buildGrep({ tags: ['visual', '@auth'] })).toBe('@visual\\b|@auth\\b');
    expect(buildGrep({ scenarioIds: ['HOME-001'] })).toBe('^HOME-001\\b|\\sHOME-001:');
  });

  it('escapes spec paths as regular expressions relative to the test dir', () => {
    const testsDir = path.join('C:', 'proj', '.qa', 'tests');
    expect(fileFilterArg(testsDir, 'home.spec.ts')).toBe('home\\.spec\\.ts');
    expect(fileFilterArg(testsDir, path.join(testsDir, 'sub', 'a.spec.ts'))).toBe('sub/a\\.spec\\.ts');
  });
});

describe('writePlaywrightLog', () => {
  it('writes the log when the run directory has no logs folder yet', () => {
    // Nothing creates <run>/logs when an already running server is reused.
    const dir = path.join(makeProject({}), 'run');
    fs.mkdirSync(dir);
    writePlaywrightLog(dir, '\u001b[32mout\u001b[39m', 'err');
    expect(fs.readFileSync(path.join(dir, 'logs', 'playwright-stdout.log'), 'utf8')).toBe('out\nerr');
  });
});

describe('collectOutcomes', () => {
  it('normalizes a Playwright JSON report and copies evidence into the run directory', () => {
    const root = makeProject({ 'video.webm': 'v', 'trace.zip': 't', 'shot.png': 'p' });
    const runDir = path.join(root, 'run');
    const report = PwReportSchema.parse({
      stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
      errors: [],
      suites: [
        {
          title: 'home.spec.ts',
          file: 'home.spec.ts',
          specs: [
            {
              title: 'HOME-001: passes',
              file: 'home.spec.ts',
              line: 3,
              tags: ['@functional', '@desktop'],
              tests: [
                {
                  projectName: 'chromium-desktop',
                  status: 'expected',
                  annotations: [],
                  results: [{ status: 'passed', duration: 10, retry: 0, errors: [], attachments: [] }],
                },
              ],
            },
            {
              title: 'HOME-002: fails',
              file: 'home.spec.ts',
              line: 9,
              tags: ['@visual', '@desktop'],
              tests: [
                {
                  projectName: 'chromium-desktop',
                  status: 'unexpected',
                  annotations: [{ type: 'qa-visual', description: '{"status":"mismatch"}' }],
                  results: [
                    {
                      status: 'failed',
                      duration: 5,
                      retry: 0,
                      errors: [{ message: 'first' }],
                      attachments: [],
                    },
                    {
                      status: 'failed',
                      duration: 7,
                      retry: 1,
                      errors: [{ message: '\u001b[31mboom\u001b[39m', stack: 'stack' }, { message: 'soft' }],
                      attachments: [
                        { name: 'video', contentType: 'video/webm', path: path.join(root, 'video.webm') },
                        { name: 'trace', contentType: 'application/zip', path: path.join(root, 'trace.zip') },
                        { name: 'screenshot', contentType: 'image/png', path: path.join(root, 'shot.png') },
                        {
                          name: 'design-diff-home.png',
                          contentType: 'image/png',
                          path: path.join(root, 'shot.png'),
                        },
                        {
                          name: 'qa-logs.json',
                          contentType: 'application/json',
                          body: Buffer.from('{"console":[]}').toString('base64'),
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const outcomes = collectOutcomes(report, runDir, root, path.join(root, '.qa', 'tests'));
    expect(outcomes.map((o) => o.status)).toEqual(['passed', 'failed']);
    const failed = outcomes[1]!;
    expect(failed.key).toBe('HOME-002@chromium-desktop');
    expect(failed.attempts).toBe(2);
    expect(failed.durationMs).toBe(12);
    expect(failed.error?.message).toBe('boom\n\nsoft');
    expect(failed.annotations).toEqual([{ type: 'qa-visual', description: '{"status":"mismatch"}' }]);
    expect(failed.artifacts.video).toBe('run/videos/HOME-002_chromium-desktop.webm');
    expect(failed.artifacts.trace).toBe('run/traces/HOME-002_chromium-desktop.zip');
    expect(failed.artifacts.screenshots).toEqual(['run/screenshots/HOME-002_chromium-desktop.png']);
    expect(failed.artifacts.design).toEqual(['run/design/HOME-002_chromium-desktop_design-diff-home.png']);
    expect(fs.readFileSync(path.join(root, failed.artifacts.logs!), 'utf8')).toBe('{"console":[]}');
    expect(fs.existsSync(path.join(root, failed.artifacts.video!))).toBe(true);
    expect(failed.artifacts.videos).toEqual(['run/videos/HOME-002_chromium-desktop.webm']);
  });

  it('keeps the video of every page, in the order the pages were opened', () => {
    // Playwright names videos by page order (video.webm, video-1.webm, ...) but attaches them in the
    // order the pages closed, so a popup's video comes first.
    const root = makeProject({
      'out/video.webm': 'main',
      'out/video-1.webm': 'popup',
      'out/video-2.webm': 'third',
    });
    const report = PwReportSchema.parse({
      stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
      errors: [],
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            {
              title: 'A-001: opens a popup',
              file: 'a.spec.ts',
              line: 1,
              tags: [],
              tests: [
                {
                  projectName: 'chromium-desktop',
                  status: 'expected',
                  annotations: [],
                  results: [
                    {
                      status: 'passed',
                      duration: 1,
                      retry: 0,
                      errors: [],
                      attachments: ['video-2', 'video-1', 'video'].map((n) => ({
                        name: 'video',
                        contentType: 'video/webm',
                        path: path.join(root, 'out', `${n}.webm`),
                      })),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const [outcome] = collectOutcomes(report, path.join(root, 'run'), root, path.join(root, '.qa', 'tests'));
    const { video, videos } = outcome!.artifacts;
    expect(videos).toEqual([
      'run/videos/A-001_chromium-desktop.webm',
      'run/videos/A-001_chromium-desktop-1.webm',
      'run/videos/A-001_chromium-desktop-2.webm',
    ]);
    expect(video).toBe(videos[0]);
    expect(videos.map((v) => fs.readFileSync(path.join(root, v), 'utf8'))).toEqual([
      'main',
      'popup',
      'third',
    ]);
  });
});

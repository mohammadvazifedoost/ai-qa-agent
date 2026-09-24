import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGrep, fileFilterArg } from '../src/runner/run.js';
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
  });
});

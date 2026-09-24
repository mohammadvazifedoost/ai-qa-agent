/**
 * Runtime helpers imported by generated tests: `import { test, expect } from '@company/ai-qa/playwright'`.
 *
 * Everything here is deterministic. The AI decides *what* to check when it writes a test; these
 * helpers decide *whether it passed*, so a visual verdict never rests on an LLM saying "looks right".
 */
import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { compareStyle, type StyleCheck } from './style.js';

export { expect, devices, defineConfig } from '@playwright/test';
export type { Page, Locator } from '@playwright/test';

/** Annotation types the engine reads back from the JSON report. */
export const ANNOTATION = {
  scenario: 'qa-scenario',
  visual: 'qa-visual',
  tokens: 'qa-design-tokens',
  overflow: 'qa-overflow',
} as const;

interface VisualSettings {
  pixelThreshold: number;
  acceptableDiffRatio: number;
}

function visualSettings(): VisualSettings {
  const raw = process.env.AI_QA_VISUAL;
  const parsed = raw ? (JSON.parse(raw) as Partial<VisualSettings>) : {};
  return {
    pixelThreshold: parsed.pixelThreshold ?? 0.1,
    acceptableDiffRatio: parsed.acceptableDiffRatio ?? 0.02,
  };
}

function qaDir(): string {
  return process.env.AI_QA_DIR ?? path.resolve('.qa');
}

interface Reference {
  screen: string;
  file: string;
}

function findReference(screen: string): string | undefined {
  const file = path.join(qaDir(), 'design-system.json');
  if (!fs.existsSync(file)) return undefined;
  const ds = JSON.parse(fs.readFileSync(file, 'utf8')) as { references?: Reference[] };
  const ref = ds.references?.find((r) => r.screen.toLowerCase() === screen.toLowerCase());
  return ref ? path.join(qaDir(), ref.file) : undefined;
}

export interface VisualResult {
  screen: string;
  status: 'match' | 'acceptable' | 'mismatch' | 'no-reference';
  diffRatio: number;
  diffPixels: number;
  actualSize: [number, number];
  expectedSize: [number, number];
}

/** Compare two PNGs. Pixels outside the overlapping area count as different. */
export function diffImages(
  expected: PNG,
  actual: PNG,
  pixelThreshold: number,
): { diff: PNG; diffPixels: number; diffRatio: number } {
  const width = Math.min(expected.width, actual.width);
  const height = Math.min(expected.height, actual.height);
  const crop = (img: PNG): Buffer => {
    const out = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
      img.data.copy(out, y * width * 4, y * img.width * 4, y * img.width * 4 + width * 4);
    return out;
  };
  const diff = new PNG({ width, height });
  const overlapDiff = pixelmatch(crop(expected), crop(actual), diff.data, width, height, {
    threshold: pixelThreshold,
  });
  const totalArea = Math.max(expected.width, actual.width) * Math.max(expected.height, actual.height);
  const nonOverlap = totalArea - width * height;
  const diffPixels = overlapDiff + nonOverlap;
  return { diff, diffPixels, diffRatio: totalArea === 0 ? 0 : diffPixels / totalArea };
}

export class QaHelpers {
  constructor(
    private readonly page: Page,
    private readonly testInfo: TestInfo,
  ) {}

  /**
   * Assert computed CSS of an element against design-token values, e.g.
   * `{ backgroundColor: '#2563EB', borderRadius: '8px', fontFamily: 'Inter' }`.
   * All properties are checked; every mismatch is reported together.
   */
  async expectDesignTokens(
    locator: Locator,
    expected: Record<string, string>,
    label = locator.toString(),
  ): Promise<void> {
    await expect(locator).toBeVisible();
    const props = Object.keys(expected);
    const actual = await locator.evaluate((el, names) => {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return Object.fromEntries(
        names.map((n) => {
          if (n === 'width') return [n, `${rect.width}px`];
          if (n === 'height') return [n, `${rect.height}px`];
          const kebab = n.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
          return [n, cs.getPropertyValue(kebab)];
        }),
      );
    }, props);
    const checks: StyleCheck[] = props.map((p) => compareStyle(p, expected[p]!, actual[p] ?? ''));
    const failed = checks.filter((c) => !c.ok);
    this.testInfo.annotations.push({
      type: ANNOTATION.tokens,
      description: JSON.stringify({ element: label, checks }),
    });
    expect
      .soft(
        failed,
        `Design token mismatch for ${label}:\n` +
          failed.map((c) => `  ${c.property}: expected ${c.expected}, actual ${c.actual}`).join('\n'),
      )
      .toEqual([]);
  }

  /**
   * Pixel-compare the page (full page) or an element against the Figma reference image for `screen`.
   * Differences at or below the configured acceptable ratio are recorded as acceptable rendering noise.
   */
  async compareWithDesign(screen: string, target?: Locator): Promise<VisualResult> {
    const settings = visualSettings();
    const refFile = findReference(screen);
    if (!refFile || !fs.existsSync(refFile)) {
      const result: VisualResult = {
        screen,
        status: 'no-reference',
        diffRatio: 0,
        diffPixels: 0,
        actualSize: [0, 0],
        expectedSize: [0, 0],
      };
      this.testInfo.annotations.push({ type: ANNOTATION.visual, description: JSON.stringify(result) });
      return result;
    }
    await this.page.evaluate(() => document.fonts.ready);
    const expectedPng = PNG.sync.read(fs.readFileSync(refFile));
    // A design frame covers a region of the page starting at the top-left, so compare exactly that
    // region: otherwise a taller viewport would count every pixel below the design as different.
    const shot = target
      ? await target.screenshot({ animations: 'disabled', caret: 'hide' })
      : await this.page.screenshot({
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
          clip: { x: 0, y: 0, width: expectedPng.width, height: expectedPng.height },
        });
    const actualPng = PNG.sync.read(shot);
    const { diff, diffPixels, diffRatio } = diffImages(expectedPng, actualPng, settings.pixelThreshold);
    const status: VisualResult['status'] =
      diffPixels === 0 ? 'match' : diffRatio <= settings.acceptableDiffRatio ? 'acceptable' : 'mismatch';
    const result: VisualResult = {
      screen,
      status,
      diffRatio: Number(diffRatio.toFixed(4)),
      diffPixels,
      actualSize: [actualPng.width, actualPng.height],
      expectedSize: [expectedPng.width, expectedPng.height],
    };
    await this.testInfo.attach(`design-expected-${screen}.png`, { path: refFile, contentType: 'image/png' });
    await this.testInfo.attach(`design-actual-${screen}.png`, { body: shot, contentType: 'image/png' });
    await this.testInfo.attach(`design-diff-${screen}.png`, {
      body: PNG.sync.write(diff),
      contentType: 'image/png',
    });
    this.testInfo.annotations.push({ type: ANNOTATION.visual, description: JSON.stringify(result) });
    expect
      .soft(
        status,
        `Visual mismatch vs Figma "${screen}": ${(diffRatio * 100).toFixed(2)}% of pixels differ ` +
          `(acceptable ≤ ${(settings.acceptableDiffRatio * 100).toFixed(2)}%). ` +
          `Actual ${actualPng.width}x${actualPng.height}, design ${expectedPng.width}x${expectedPng.height}.`,
      )
      .not.toBe('mismatch');
    return result;
  }

  /** Fail if the document scrolls horizontally; lists the elements that stick out of the viewport. */
  async expectNoHorizontalOverflow(): Promise<void> {
    const info = await this.page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const offenders: string[] = [];
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1 && offenders.length < 10) {
          const name =
            el.tagName.toLowerCase() +
            (el.id ? `#${el.id}` : '') +
            (el.className && typeof el.className === 'string'
              ? `.${el.className.trim().split(/\s+/).join('.')}`
              : '');
          offenders.push(`${name} (right edge ${Math.round(r.right)}px)`);
        }
      }
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: vw, offenders };
    });
    this.testInfo.annotations.push({ type: ANNOTATION.overflow, description: JSON.stringify(info) });
    expect
      .soft(
        info.scrollWidth,
        `Page overflows horizontally: scrollWidth ${info.scrollWidth}px > viewport ${info.clientWidth}px. ` +
          `Elements past the right edge: ${info.offenders.join(', ') || 'none found'}`,
      )
      .toBeLessThanOrEqual(info.clientWidth);
  }
}

interface CapturedLogs {
  console: Array<{ type: string; text: string; location?: string }>;
  pageErrors: string[];
  network: Array<{ url: string; method: string; status?: number; failure?: string }>;
}

export const test = base.extend<{ qa: QaHelpers; qaCapture: void }>({
  qaCapture: [
    async ({ page }, use, testInfo) => {
      const logs: CapturedLogs = { console: [], pageErrors: [], network: [] };
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') {
          const loc = m.location();
          logs.console.push({
            type: m.type(),
            text: m.text(),
            location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined,
          });
        }
      });
      page.on('pageerror', (e) => logs.pageErrors.push(`${e.name}: ${e.message}`));
      page.on('requestfailed', (r) =>
        logs.network.push({ url: r.url(), method: r.method(), failure: r.failure()?.errorText }),
      );
      page.on('response', (r) => {
        if (r.status() >= 400)
          logs.network.push({ url: r.url(), method: r.request().method(), status: r.status() });
      });
      await use();
      await testInfo.attach('qa-logs.json', {
        body: JSON.stringify(logs, null, 2),
        contentType: 'application/json',
      });
    },
    { auto: true },
  ],
  qa: async ({ page }, use, testInfo) => {
    await use(new QaHelpers(page, testInfo));
  },
});

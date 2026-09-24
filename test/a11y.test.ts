import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { a11yFailureMessage, blockingViolations, runAxe } from '../src/playwright/index.js';

const BAD = `<!doctype html><html lang="en"><head><title>Bad</title></head><body><main>
  <h1>Shop</h1>
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  <p style="color:#bbb;background:#fff">Low contrast text</p>
  <section id="ok"><h2>Fine</h2><p>Readable text</p></section>
</main></body></html>`;

const GOOD = `<!doctype html><html lang="en"><head><title>Good</title></head><body><main>
  <h1>Shop</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Logo"><p>Readable text</p>
</main></body></html>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

describe('runAxe', () => {
  it('reports WCAG A/AA violations with impact, help and targets', async () => {
    const page = await browser.newPage();
    await page.setContent(BAD);
    const violations = await runAxe(page);
    const ids = violations.map((v) => v.id);
    expect(ids).toContain('image-alt');
    expect(ids).toContain('color-contrast');
    const img = violations.find((v) => v.id === 'image-alt')!;
    expect(img.impact).toBe('critical');
    expect(img.targets).toEqual(['img']);
    expect(img.help).toMatch(/alternative text/i);
    // Running twice does not inject axe twice.
    expect((await runAxe(page)).length).toBe(violations.length);
    await page.close();
  });

  it('finds nothing on a clean page, can be scoped and can skip rules', async () => {
    const page = await browser.newPage();
    await page.setContent(GOOD);
    expect(await runAxe(page)).toEqual([]);
    await page.setContent(BAD);
    expect(await runAxe(page, { include: page.locator('#ok') })).toEqual([]);
    const ids = (await runAxe(page, { disableRules: ['image-alt'] })).map((v) => v.id);
    expect(ids).not.toContain('image-alt');
    await page.close();
  });
});

describe('blocking violations', () => {
  const v = (id: string, impact: string) => ({
    id,
    impact,
    help: `${id} help`,
    helpUrl: 'u',
    targets: ['#x'],
  });

  it('fails only on serious and critical, and explains each one', () => {
    const all = [
      v('a', 'minor'),
      v('b', 'moderate'),
      v('c', 'serious'),
      v('d', 'critical'),
      v('e', null as unknown as string),
    ];
    expect(blockingViolations(all).map((x) => x.id)).toEqual(['c', 'd']);
    expect(a11yFailureMessage(all)).toBe(
      'Accessibility violations (WCAG 2.1 A/AA, serious or critical):\n' +
        '  c [serious] c help: #x\n' +
        '  d [critical] d help: #x\n' +
        '3 minor/moderate violation(s) are listed in the qa-a11y attachment.',
    );
  });
});

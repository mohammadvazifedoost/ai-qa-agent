import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

type Conditions = Record<string, string>;

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, Conditions>;
};

describe('package exports', () => {
  // Playwright loads .qa/playwright.config.ts and the tests with require() when the tested
  // project's package.json has no "type": "module". An entry with only an "import" condition
  // cannot be resolved that way (ERR_PACKAGE_PATH_NOT_EXPORTED).
  it.each(Object.keys(pkg.exports))('%s can be resolved by require() as well as import', (entry) => {
    const conditions = pkg.exports[entry]!;
    expect(conditions.default).toBe(conditions.import);
    expect(Object.keys(conditions).at(-1)).toBe('default');
  });
});

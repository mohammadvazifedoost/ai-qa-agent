import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { diffImages } from '../src/playwright/index.js';

function solid(width: number, height: number, rgb: [number, number, number]): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return png;
}

describe('diffImages', () => {
  it('reports zero difference for identical images', () => {
    const a = solid(20, 10, [255, 255, 255]);
    const r = diffImages(a, solid(20, 10, [255, 255, 255]), 0.1);
    expect(r.diffPixels).toBe(0);
    expect(r.diffRatio).toBe(0);
  });

  it('counts a differently coloured block', () => {
    const expected = solid(20, 10, [255, 255, 255]);
    const actual = solid(20, 10, [255, 255, 255]);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 5; x++) actual.data[(y * 20 + x) * 4 + 1] = 0; // 25% of pixels
    const r = diffImages(expected, actual, 0.1);
    expect(r.diffPixels).toBe(50);
    expect(r.diffRatio).toBeCloseTo(0.25);
  });

  it('counts non-overlapping area as different when sizes differ', () => {
    const r = diffImages(solid(10, 10, [0, 0, 0]), solid(10, 20, [0, 0, 0]), 0.1);
    expect(r.diffPixels).toBe(100);
    expect(r.diffRatio).toBeCloseTo(0.5);
    expect(r.diff.width).toBe(10);
    expect(r.diff.height).toBe(10);
  });
});

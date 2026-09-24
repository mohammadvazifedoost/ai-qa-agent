import { describe, expect, it } from 'vitest';
import { compareStyle, parseColor, toHex } from '../src/playwright/style.js';

describe('parseColor / toHex', () => {
  it('parses hex, rgb() and rgba() into the same representation', () => {
    expect(parseColor('#2563EB')).toEqual([37, 99, 235, 1]);
    expect(parseColor('rgb(37, 99, 235)')).toEqual([37, 99, 235, 1]);
    expect(parseColor('rgba(0, 0, 0, 0)')).toEqual([0, 0, 0, 0]);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(toHex([124, 58, 237, 1])).toBe('#7C3AED');
    expect(toHex([0, 0, 0, 0])).toBe('#00000000');
    expect(parseColor('8px')).toBeUndefined();
  });
});

describe('compareStyle', () => {
  it('compares colors by value and reports the actual as hex', () => {
    expect(compareStyle('backgroundColor', '#2563EB', 'rgb(37, 99, 235)').ok).toBe(true);
    const bad = compareStyle('backgroundColor', '#2563EB', 'rgb(124, 58, 237)');
    expect(bad.ok).toBe(false);
    expect(bad.actual).toBe('#7C3AED');
  });

  it('compares lengths with sub-pixel tolerance and shorthand expansion', () => {
    expect(compareStyle('height', '44px', '44.2px').ok).toBe(true);
    expect(compareStyle('height', '44px', '45px').ok).toBe(false);
    expect(compareStyle('borderRadius', '8px', '8px 8px 8px 8px').ok).toBe(true);
    expect(compareStyle('borderRadius', '8px', '2px').ok).toBe(false);
    expect(compareStyle('padding', '0px 20px', '0px 20px 0px 20px').ok).toBe(true);
  });

  it('compares font family by first family and weight by number', () => {
    expect(compareStyle('fontFamily', 'Inter', 'Inter, system-ui, sans-serif').ok).toBe(true);
    expect(compareStyle('fontFamily', 'Inter', '"Segoe UI", Inter').ok).toBe(false);
    expect(compareStyle('fontWeight', '700', 'bold').ok).toBe(true);
    expect(compareStyle('fontWeight', '600', '700').ok).toBe(false);
  });

  it('falls back to case-insensitive text comparison', () => {
    expect(compareStyle('textTransform', 'uppercase', 'UPPERCASE').ok).toBe(true);
    expect(compareStyle('display', 'flex', 'block').ok).toBe(false);
  });
});

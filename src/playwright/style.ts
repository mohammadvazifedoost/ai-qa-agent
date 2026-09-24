/** Pure CSS value comparison used by `expectDesignTokens` (kept separate for unit testing). */

export interface StyleCheck {
  property: string;
  expected: string;
  actual: string;
  ok: boolean;
}

type Rgba = [number, number, number, number];

export function parseColor(value: string): Rgba | undefined {
  const v = value.trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), a];
  }
  if (v === 'transparent') return [0, 0, 0, 0];
  if (v === 'white') return [255, 255, 255, 1];
  if (v === 'black') return [0, 0, 0, 1];
  return undefined;
}

export function toHex([r, g, b, a]: Rgba): string {
  const h = [r, g, b]
    .map((n) => Math.round(n).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return a < 1
    ? `#${h}${Math.round(a * 255)
        .toString(16)
        .padStart(2, '0')
        .toUpperCase()}`
    : `#${h}`;
}

const WEIGHTS: Record<string, string> = { normal: '400', bold: '700' };

function firstFamily(value: string): string {
  return (value.split(',')[0] ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
}

function px(value: string): number | undefined {
  const m = value.trim().match(/^(-?[\d.]+)px$/);
  return m ? Number(m[1]) : value.trim() === '0' ? 0 : undefined;
}

/**
 * Compare an expected design value with a computed style value.
 * Colors are compared as RGBA, lengths within 0.5px, font families by the first family,
 * shorthand radius/padding by each component.
 */
export function compareStyle(property: string, expected: string, actual: string): StyleCheck {
  const result = (ok: boolean, shownActual = actual): StyleCheck => ({
    property,
    expected,
    actual: shownActual,
    ok,
  });
  const ec = parseColor(expected);
  if (ec) {
    const ac = parseColor(actual);
    if (!ac) return result(false);
    const ok = ec.every((v, i) => Math.abs(v - ac[i]!) <= (i === 3 ? 0.01 : 1));
    return result(ok, toHex(ac));
  }
  if (/fontfamily/i.test(property)) return result(firstFamily(expected) === firstFamily(actual));
  if (/fontweight/i.test(property)) {
    return result((WEIGHTS[expected] ?? expected) === (WEIGHTS[actual] ?? actual));
  }
  const ep = expected.trim().split(/\s+/).map(px);
  const ap = actual.trim().split(/\s+/).map(px);
  if (ep.every((v) => v !== undefined) && ap.every((v) => v !== undefined) && ap.length > 0) {
    // "8px" vs "8px 8px 8px 8px" (shorthand) → compare every component against the expected pattern.
    const ok = ap.every((v, i) => Math.abs(v! - ep[i % ep.length]!) <= 0.5);
    return result(ok);
  }
  return result(expected.trim().toLowerCase() === actual.trim().toLowerCase());
}

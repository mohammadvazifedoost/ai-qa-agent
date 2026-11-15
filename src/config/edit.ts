/**
 * Change one top-level property of `.qa/config.ts` in place, keeping the rest of the file (its
 * comments, order and formatting) as the user wrote it. The file is TypeScript, so it is read with
 * the same small lexer that edits spec files; nothing is evaluated.
 */
import { tokenize, type Token } from '../scenarios/spec-edit.js';

/** A value written as TypeScript source: strings and numbers through JSON, objects indented. */
export function toSource(value: unknown, indent = '  '): string {
  if (Array.isArray(value)) return '[' + value.map((v) => toSource(v, indent)).join(', ') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return '{}';
    const inner = indent + '  ';
    return (
      '{\n' +
      entries
        .map(
          ([k, v]) =>
            inner + (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)) + ': ' + toSource(v, inner) + ',',
        )
        .join('\n') +
      '\n' +
      indent +
      '}'
    );
  }
  return JSON.stringify(value);
}

interface Found {
  /** Offset just after the `{` of the config object. */
  open: number;
  /** Offset of its closing `}`. */
  close: number;
  /** The property, when present: from its key to the end of its value. */
  prop: { start: number; end: number } | null;
  /** End offset of the last token before the closing brace (to place a comma after it). */
  lastEnd: number;
  lastText: string;
}

function locate(source: string, key: string): Found {
  const tokens = tokenize(source).filter((t) => t.kind !== 'comment');
  const text = (t: Token | undefined) => (t ? source.slice(t.start, t.end) : '');
  // `defineConfig({ … })`, or `export default { … }`.
  let open = -1;
  for (let i = 0; i < tokens.length && open < 0; i++) {
    if (text(tokens[i]) === 'defineConfig' && text(tokens[i + 1]) === '(' && text(tokens[i + 2]) === '{')
      open = i + 2;
    else if (text(tokens[i]) === 'export' && text(tokens[i + 1]) === 'default' && text(tokens[i + 2]) === '{')
      open = i + 2;
  }
  if (open < 0) throw new Error('Could not find the config object (defineConfig({ … })) in .qa/config.ts');

  let depth = 0;
  let prop: Found['prop'] = null;
  let current: { start: number; key: string } | null = null;
  let lastValueEnd = -1;
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    const s = text(t);
    if (depth === 0) {
      if (s === '}' || s === ',') {
        if (current && current.key === key) prop = { start: current.start, end: lastValueEnd };
        current = null;
        if (s === '}') {
          const prev = tokens[i - 1]!;
          return { open: tokens[open]!.end, close: t.start, prop, lastEnd: prev.end, lastText: text(prev) };
        }
        continue;
      }
      const prev = text(tokens[i - 1]);
      if (!current && (prev === '{' || prev === ',') && text(tokens[i + 1]) === ':') {
        const name = t.kind === 'string' ? (t.value ?? '') : s;
        current = { start: t.start, key: name };
      }
    }
    if (t.kind === 'punct' && (s === '{' || s === '[' || s === '(')) depth++;
    else if (t.kind === 'punct' && (s === '}' || s === ']' || s === ')')) depth--;
    lastValueEnd = t.end;
  }
  throw new Error('The config object in .qa/config.ts is not closed');
}

/** Set `key: <valueSource>` on the config object: replaced where it is, else added at the end. */
export function setConfigProperty(source: string, key: string, valueSource: string): string {
  const f = locate(source, key);
  if (f.prop) return source.slice(0, f.prop.start) + key + ': ' + valueSource + source.slice(f.prop.end);
  const comma = f.lastText === ',' || f.lastText === '{' ? '' : ',';
  return (
    source.slice(0, f.lastEnd) + comma + '\n  ' + key + ': ' + valueSource + ',' + source.slice(f.lastEnd)
  );
}

/** Whether the config object has `key` (outside comments). */
export function hasConfigProperty(source: string, key: string): boolean {
  return locate(source, key).prop !== null;
}

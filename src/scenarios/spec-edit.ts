/**
 * Surgical edits of generated spec files: find and remove one `test('<ID>: …', …)` call without
 * regenerating the file. A small lexer (strings, template literals, comments, regex literals)
 * makes bracket matching safe without shipping the TypeScript compiler at runtime.
 */

type TokenKind = 'ident' | 'punct' | 'string' | 'template' | 'regex' | 'comment' | 'number';

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** Literal value for strings and templates without substitutions. */
  value?: string;
}

/** After these keywords a `/` starts a regex literal, not a division. */
const REGEX_AFTER_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const isIdentStart = (c: string): boolean => /[A-Za-z_$\u0080-￿]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(c);

class Lexer {
  constructor(private readonly src: string) {}

  /** Tokenize from `pos`; with `inTemplateExpr`, stop at the `}` that closes a `${`. */
  lex(pos: number, inTemplateExpr: boolean): { tokens: Token[]; end: number } {
    const s = this.src;
    const tokens: Token[] = [];
    let braces = 0;
    let i = pos;
    while (i < s.length) {
      const c = s[i]!;
      if (/\s/.test(c)) {
        i++;
      } else if (c === '/' && s[i + 1] === '/') {
        const nl = s.indexOf('\n', i);
        const end = nl === -1 ? s.length : nl;
        tokens.push({ kind: 'comment', start: i, end });
        i = end;
      } else if (c === '/' && s[i + 1] === '*') {
        const close = s.indexOf('*/', i + 2);
        if (close === -1) throw new Error(`Unterminated block comment at offset ${i}`);
        tokens.push({ kind: 'comment', start: i, end: close + 2 });
        i = close + 2;
      } else if (c === '"' || c === "'") {
        const end = this.scanQuoted(i, c);
        tokens.push({ kind: 'string', start: i, end, value: unescape(s.slice(i + 1, end - 1)) });
        i = end;
      } else if (c === '`') {
        const { end, simple } = this.scanTemplate(i);
        tokens.push({
          kind: 'template',
          start: i,
          end,
          value: simple ? unescape(s.slice(i + 1, end - 1)) : undefined,
        });
        i = end;
      } else if (c === '/' && this.regexAllowed(tokens)) {
        const end = this.scanRegex(i);
        tokens.push({ kind: 'regex', start: i, end });
        i = end;
      } else if (isIdentStart(c)) {
        let j = i + 1;
        while (j < s.length && isIdentPart(s[j]!)) j++;
        tokens.push({ kind: 'ident', start: i, end: j });
        i = j;
      } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
        let j = i + 1;
        while (j < s.length && /[0-9A-Za-z_.]/.test(s[j]!)) j++;
        tokens.push({ kind: 'number', start: i, end: j });
        i = j;
      } else {
        if (c === '{') braces++;
        if (c === '}') {
          if (inTemplateExpr && braces === 0) return { tokens, end: i + 1 };
          braces--;
        }
        tokens.push({ kind: 'punct', start: i, end: i + 1 });
        i++;
      }
    }
    if (inTemplateExpr) throw new Error(`Unterminated template expression at offset ${pos}`);
    return { tokens, end: s.length };
  }

  private scanQuoted(start: number, quote: string): number {
    const s = this.src;
    for (let i = start + 1; i < s.length; i++) {
      if (s[i] === '\\') i++;
      else if (s[i] === quote) return i + 1;
      else if (s[i] === '\n') break;
    }
    throw new Error(`Unterminated string at offset ${start}`);
  }

  private scanTemplate(start: number): { end: number; simple: boolean } {
    const s = this.src;
    let simple = true;
    let i = start + 1;
    while (i < s.length) {
      if (s[i] === '\\') i += 2;
      else if (s[i] === '`') return { end: i + 1, simple };
      else if (s[i] === '$' && s[i + 1] === '{') {
        simple = false;
        i = this.lex(i + 2, true).end;
      } else i++;
    }
    throw new Error(`Unterminated template literal at offset ${start}`);
  }

  private scanRegex(start: number): number {
    const s = this.src;
    let inClass = false;
    for (let i = start + 1; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') i++;
      else if (c === '\n') break;
      else if (inClass) inClass = c !== ']';
      else if (c === '[') inClass = true;
      else if (c === '/') {
        let j = i + 1;
        while (j < s.length && isIdentPart(s[j]!)) j++;
        return j;
      }
    }
    throw new Error(`Unterminated regular expression at offset ${start}`);
  }

  /** True when a `/` after these tokens starts a regex literal rather than dividing a value. */
  private regexAllowed(tokens: readonly Token[]): boolean {
    const s = this.src;
    /** Index of the last token at or before `k` that is not a comment (-1 when there is none). */
    const code = (k: number): number => {
      while (k >= 0 && tokens[k]!.kind === 'comment') k--;
      return k;
    };
    /** Does the token at `k` end a value (so a `/` after it divides)? */
    const endsValue = (k: number): boolean => {
      if (k < 0) return false;
      const t = tokens[k]!;
      if (t.kind === 'ident') return !REGEX_AFTER_KEYWORDS.has(s.slice(t.start, t.end));
      if (t.kind !== 'punct') return true;
      const c = s[t.start]!;
      if (c === ')' || c === ']') return true;
      // TypeScript's non-null `x!` ends a value; the prefix `!x` does not.
      if (c === '!') return endsValue(code(k - 1));
      // So does a postfix `x++` / `x--`.
      if (c === '+' || c === '-') {
        const p = tokens[k - 1];
        return !!p && p.kind === 'punct' && s[p.start] === c && p.end === t.start && endsValue(code(k - 2));
      }
      return false;
    };
    return !endsValue(code(tokens.length - 1));
  }
}

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

export function tokenize(source: string): Token[] {
  return new Lexer(source).lex(0, false).tokens;
}

const TEST_MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail']);

interface TestCall {
  title: string;
  /** Index of the `test` identifier token. */
  first: number;
  /** Index of the closing `)` token. */
  close: number;
}

/** Every `test(...)` / `test.skip(...)` declaration whose first argument is a literal title. */
function findTestCalls(source: string, tokens: Token[]): TestCall[] {
  const text = (t: Token | undefined): string => (t ? source.slice(t.start, t.end) : '');
  const code = tokens.map((t, idx) => ({ t, idx })).filter((x) => x.t.kind !== 'comment');
  const calls: TestCall[] = [];
  for (let k = 0; k < code.length; k++) {
    const tok = code[k]!.t;
    if (tok.kind !== 'ident' || text(tok) !== 'test') continue;
    if (text(code[k - 1]?.t) === '.') continue; // foo.test(...)
    let n = k + 1;
    if (text(code[n]?.t) === '.' && TEST_MODIFIERS.has(text(code[n + 1]?.t))) n += 2;
    if (text(code[n]?.t) !== '(') continue;
    const arg = code[n + 1]?.t;
    if (!arg || (arg.kind !== 'string' && arg.kind !== 'template') || arg.value === undefined) continue;
    let depth = 0;
    let close = -1;
    for (let m = n; m < code.length; m++) {
      const p = text(code[m]!.t);
      if (code[m]!.t.kind !== 'punct') continue;
      if (p === '(' || p === '[' || p === '{') depth++;
      else if (p === ')' || p === ']' || p === '}') {
        depth--;
        if (depth === 0) {
          close = code[m]!.idx;
          break;
        }
      }
    }
    if (close === -1) throw new Error(`Unbalanced brackets in test "${arg.value}"`);
    calls.push({ title: arg.value, first: code[k]!.idx, close });
  }
  return calls;
}

const titleHasId = (title: string, id: string): boolean => title.trimStart().startsWith(`${id}:`);

/**
 * Scenario ids of the tests declared in a spec (titles "<ID>: …").
 *
 * Reading must not fail on a file the lexer cannot follow (it only has to be exact for edits,
 * which tokenize the file themselves), so such a file is scanned as plain text instead.
 */
export function listTestIds(source: string): string[] {
  let titles: string[];
  try {
    titles = findTestCalls(source, tokenize(source)).map((c) => c.title);
  } catch {
    const call = /(?<![.\w$])test(?:\.(?:only|skip|fixme|fail))?\(\s*(['"`])([^\n]*?)\1/g;
    titles = [...source.matchAll(call)].map((m) => m[2]!);
  }
  return titles
    .map((title) => /^\s*([A-Z0-9]+-\d{3}):/.exec(title)?.[1])
    .filter((id): id is string => !!id);
}

const lineStart = (s: string, pos: number): number => s.lastIndexOf('\n', pos - 1) + 1;
const onlySpaceBefore = (s: string, pos: number): boolean => /^[ \t]*$/.test(s.slice(lineStart(s, pos), pos));
const newlines = (s: string, from: number, to: number): number => s.slice(from, to).split('\n').length - 1;

/**
 * Comments directly above a test (no blank line in between) that clearly belong to it: they
 * mention the id, or they form their own block separated from the code above by a blank line.
 * Returns the token index of the first such comment, or `first` when there are none.
 */
function leadingCommentStart(source: string, tokens: Token[], first: number, id: string): number {
  let k = first;
  while (k > 0) {
    const prev = tokens[k - 1]!;
    if (prev.kind !== 'comment' || !onlySpaceBefore(source, prev.start)) break;
    if (newlines(source, prev.end, tokens[k]!.start) > 1) break;
    if (/^\/\/\s*Generated by/.test(source.slice(prev.start, prev.end))) break;
    k--;
  }
  if (k === first) return first;
  const block = source.slice(tokens[k]!.start, tokens[first]!.start);
  const above = k > 0 ? tokens[k - 1]!.end : 0;
  const detached = k === 0 || newlines(source, above, tokens[k]!.start) > 1;
  return block.includes(id) || detached ? k : first;
}

export interface RemoveResult {
  code: string;
  /** How many test declarations were removed (0 when the id has no test in the file). */
  removed: number;
}

/**
 * Remove the `test('<id>: …', …)` statement(s) for a scenario id, together with a leading
 * comment that belongs to them. Other tests, helpers and formatting are left untouched.
 */
export function removeTestBlock(source: string, id: string): RemoveResult {
  const tokens = tokenize(source);
  const calls = findTestCalls(source, tokens).filter((c) => titleHasId(c.title, id));
  let code = source;
  // Remove from the end so earlier offsets stay valid.
  for (const call of [...calls].reverse()) {
    const startTok = tokens[call.first]!;
    if (!onlySpaceBefore(source, startTok.start)) {
      throw new Error(`The test for ${id} is not a standalone statement; edit the spec by hand.`);
    }
    const from = lineStart(source, tokens[leadingCommentStart(source, tokens, call.first, id)]!.start);
    let to = tokens[call.close]!.end;
    const next = tokens[call.close + 1];
    if (next && next.kind === 'punct' && source[next.start] === ';') to = next.end;
    // Swallow the rest of the line (whitespace only) and its newline.
    const rest = /^[ \t]*(?:\r?\n|$)/.exec(source.slice(to));
    if (!rest) throw new Error(`Code follows the test for ${id} on the same line; edit the spec by hand.`);
    to += rest[0].length;
    // Do not leave two blank lines where the test used to be.
    const blankAbove = /(?:^|\n)[ \t]*\r?\n$/.test(code.slice(0, from));
    const blankBelow = /^[ \t]*(?:\r?\n|$)/.exec(code.slice(to));
    if ((blankAbove || from === 0) && blankBelow) to += blankBelow[0].length;
    code = code.slice(0, from) + code.slice(to);
  }
  return { code, removed: calls.length };
}

export interface UpsertResult {
  code: string;
  action: 'replaced' | 'added';
}

/** Strip the common indentation, then indent every line after the first with `indent`. */
function reindent(block: string, indent: string): string {
  const lines = block.replace(/\r\n/g, '\n').trim().split('\n');
  const common = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return lines
    .map((l, i) => {
      const body = l.trim() ? l.slice(common) : '';
      return i === 0 || !body ? body : indent + body;
    })
    .join('\n');
}

/** End of a call statement: after its `)` and an optional `;`. */
function statementEnd(tokens: Token[], source: string, close: number): number {
  const next = tokens[close + 1];
  return next && next.kind === 'punct' && source[next.start] === ';' ? next.end : tokens[close]!.end;
}

/**
 * Put one scenario's test into a spec: replace the existing `test('<id>: …')` statement in place,
 * or add it after the last test (inside the same `describe`, at the same indentation). `block`
 * must be exactly that one test statement. Everything else in the file is left untouched.
 */
export function upsertTestBlock(source: string, id: string, block: string): UpsertResult {
  const blockTokens = tokenize(block).filter((t) => t.kind !== 'comment');
  const blockCalls = findTestCalls(block, blockTokens);
  if (blockCalls.length !== 1 || !titleHasId(blockCalls[0]!.title, id)) {
    throw new Error(`The new code must contain exactly one test titled "${id}: …".`);
  }
  const only = blockCalls[0]!;
  if (only.first !== 0 || statementEnd(blockTokens, block, only.close) !== blockTokens.at(-1)!.end) {
    throw new Error(`The new code must contain only the test for ${id}, with no other statements.`);
  }

  const tokens = tokenize(source);
  const calls = findTestCalls(source, tokens);
  const mine = calls.filter((c) => titleHasId(c.title, id));
  if (mine.length > 1) throw new Error(`${id} has ${mine.length} tests in the file; edit the spec by hand.`);
  const anchor =
    mine[0] ?? calls.reduce<TestCall | undefined>((a, c) => (!a || c.close > a.close ? c : a), undefined);
  if (!anchor)
    throw new Error('The spec has no tests to place the new one next to; generate the whole file.');
  const start = tokens[anchor.first]!.start;
  if (!onlySpaceBefore(source, start)) {
    throw new Error(`The test next to ${id} is not a standalone statement; edit the spec by hand.`);
  }
  const indent = source.slice(lineStart(source, start), start);
  const code = reindent(block, indent);
  const end = statementEnd(tokens, source, anchor.close);
  if (mine.length === 1) {
    return { code: source.slice(0, start) + code + source.slice(end), action: 'replaced' };
  }
  return { code: source.slice(0, end) + '\n\n' + indent + code + source.slice(end), action: 'added' };
}

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
    const lastSignificant = (): Token | undefined => {
      for (let k = tokens.length - 1; k >= 0; k--) if (tokens[k]!.kind !== 'comment') return tokens[k];
      return undefined;
    };
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
      } else if (c === '/' && this.regexAllowed(lastSignificant())) {
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

  private regexAllowed(prev: Token | undefined): boolean {
    if (!prev) return true;
    if (prev.kind === 'ident') return REGEX_AFTER_KEYWORDS.has(this.src.slice(prev.start, prev.end));
    if (prev.kind === 'punct') return !/[)\]]/.test(this.src[prev.start]!);
    return prev.kind === 'comment';
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

/** Scenario ids of the tests declared in a spec (titles "<ID>: …"). */
export function listTestIds(source: string): string[] {
  return findTestCalls(source, tokenize(source))
    .map((c) => /^\s*([A-Z0-9]+-\d{3}):/.exec(c.title)?.[1])
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

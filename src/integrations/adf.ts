/**
 * Minimal Markdown → Atlassian Document Format (ADF) converter for the bug reports we render
 * (`renderBugMarkdown`): headings, paragraphs, ordered/bullet lists with one nesting level,
 * hard line breaks (two trailing spaces), and **bold**, _italic_, `code` and [links](url).
 * Jira Cloud REST v3 requires ADF for multi-line fields such as `description`.
 */

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])[_*]([^_*]+)[_*](?![\w*])/g;

/** Inline Markdown → ADF text nodes. */
export function inline(text: string): AdfNode[] {
  const out: AdfNode[] = [];
  let last = 0;
  const plain = (s: string): void => {
    if (s) out.push({ type: 'text', text: s });
  };
  for (const m of text.matchAll(INLINE)) {
    plain(text.slice(last, m.index));
    if (m[1] !== undefined) out.push({ type: 'text', text: m[1], marks: [{ type: 'strong' }] });
    else if (m[2] !== undefined) out.push({ type: 'text', text: m[2], marks: [{ type: 'code' }] });
    else if (m[3] !== undefined)
      out.push({ type: 'text', text: m[3], marks: [{ type: 'link', attrs: { href: m[4] } }] });
    else if (m[5] !== undefined) out.push({ type: 'text', text: m[5], marks: [{ type: 'em' }] });
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return out;
}

/** A paragraph from one or more source lines; a line ending in two spaces becomes a hard break. */
function paragraph(lines: string[]): AdfNode {
  const content: AdfNode[] = [];
  lines.forEach((line, i) => {
    content.push(...inline(line.replace(/\s+$/, '')));
    if (i < lines.length - 1)
      content.push(/ {2,}$/.test(line) ? { type: 'hardBreak' } : { type: 'text', text: ' ' });
  });
  return { type: 'paragraph', content };
}

const LIST_ITEM = /^(\s*)(?:([-*])|(\d+)\.)\s+(.*)$/;

export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const content: AdfNode[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) content.push(paragraph(para));
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      content.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: inline(heading[2]!) });
      continue;
    }
    const item = line.match(LIST_ITEM);
    if (item && item[1]!.length === 0) {
      flush();
      // Collect the whole list: top-level items plus indented child items.
      const ordered = item[3] !== undefined;
      const list: AdfNode = { type: ordered ? 'orderedList' : 'bulletList', content: [] };
      while (i < lines.length) {
        const m = lines[i]!.match(LIST_ITEM);
        if (!m) break;
        if (m[1]!.length === 0) {
          if ((m[3] !== undefined) !== ordered) break;
          list.content!.push({ type: 'listItem', content: [paragraph([m[4]!])] });
        } else {
          const parent = list.content!.at(-1);
          if (!parent) break;
          let child = parent.content!.find((n) => n.type === 'bulletList' || n.type === 'orderedList');
          if (!child) {
            child = { type: m[3] !== undefined ? 'orderedList' : 'bulletList', content: [] };
            parent.content!.push(child);
          }
          child.content!.push({ type: 'listItem', content: [paragraph([m[4]!])] });
        }
        i++;
      }
      i--;
      content.push(list);
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return { type: 'doc', version: 1, content };
}

export function textToAdf(text: string): AdfDoc {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

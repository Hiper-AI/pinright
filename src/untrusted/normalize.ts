/**
 * Text that a human reviewer would not see but a model reads: invisible Unicode
 * (tag characters, zero-width runs, bidi overrides, variation-selector payloads),
 * control characters, HTML comments, markdown comments and hidden HTML elements.
 * normalize() removes all of it and returns what it hid, so the detector can
 * judge the hidden part on its own: hiding text from the reader is the tell.
 */

export type HiddenKind = 'unicode-tags' | 'variation-selectors' | 'zero-width-run' | 'html-comment' | 'markdown-comment' | 'hidden-html';

export interface HiddenText {
  kind: HiddenKind;
  /** The decoded or uncovered text ('' when it cannot be decoded). */
  text: string;
}

export interface Normalized {
  text: string;
  hidden: HiddenText[];
  /** Characters removed, by class: lets a caller say "removed 40 invisible characters". */
  removed: number;
}

const TAG_RUN = /[\u{E0000}-\u{E007F}]+/gu;
const BLACK_FLAG = '\u{1F3F4}';
/** Two or more variation selectors in a row carry data (one after an emoji is normal). */
const VS_RUN = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]{2,}/gu;
const VS_SUPPLEMENT = /[\u{E0100}-\u{E01EF}]/gu;
const ZW_RUN = /[\u{200B}-\u{200D}\u{2060}-\u{2064}\u{FEFF}]{8,}/gu;
const INVISIBLE = /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{00AD}\u{061C}\u{115F}\u{1160}\u{180E}\u{3164}\u{FFA0}]|\u{034F}|\u{17B4}|\u{17B5}/gu;
// eslint-disable-next-line no-control-regex -- the point is to match terminal escapes
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex -- C0/C1 controls other than tab, newline and carriage return
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function decodeTags(run: string): string {
  let out = '';
  for (const ch of run) {
    const c = (ch.codePointAt(0) as number) - 0xe0000;
    if (c >= 0x20 && c <= 0x7e) out += String.fromCharCode(c);
  }
  return out;
}

/** Character-level cleanup only: safe on any text, code included. */
export function stripInvisible(input: string): { text: string; hidden: HiddenText[]; removed: number } {
  const hidden: HiddenText[] = [];
  let removed = 0;
  let text = input.replace(TAG_RUN, (run, offset: number, all: string) => {
    removed += [...run].length;
    const decoded = decodeTags(run);
    // Subdivision flags (England, Scotland, Wales) are a black flag plus a few tag letters.
    const flag = all.slice(Math.max(0, offset - 2), offset).includes(BLACK_FLAG) && /^[a-z0-9]{2,6}$/.test(decoded);
    if (!flag && decoded.trim()) hidden.push({ kind: 'unicode-tags', text: decoded });
    return '';
  });
  text = text.replace(VS_RUN, (run) => {
    const n = [...run].length;
    removed += n;
    if (n > 2) hidden.push({ kind: 'variation-selectors', text: '' });
    return '';
  });
  text = text.replace(VS_SUPPLEMENT, () => {
    removed++;
    return '';
  });
  text = text.replace(ZW_RUN, (run) => {
    hidden.push({ kind: 'zero-width-run', text: '' });
    removed += run.length;
    return '';
  });
  text = text
    .replace(ANSI, (m) => {
      removed += m.length;
      return '';
    })
    .replace(INVISIBLE, () => {
      removed++;
      return '';
    })
    .replace(CONTROL, () => {
      removed++;
      return '';
    })
    .replace(/[\u{2028}\u{2029}]/gu, '\n');
  return { text, hidden, removed };
}

/** Prose and fenced code, in order. Hidden-markup rules only apply to prose: in a code block it is visible. */
export function splitFences(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  let buf: string[] = [];
  let fence: string | undefined;
  const flush = (code: boolean) => {
    if (buf.length) out.push({ code, text: buf.join('\n') });
    buf = [];
  };
  for (const line of text.split('\n')) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!fence && m) {
      flush(false);
      fence = m[1];
      buf.push(line);
      continue;
    }
    buf.push(line);
    if (fence && m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.trim().slice(m[1].length).trim()) {
      flush(true);
      fence = undefined;
    }
  }
  flush(Boolean(fence));
  return out;
}

const HTML_COMMENT = /<!--([\s\S]*?)(?:-->|$)/g;
const MD_COMMENT = /^ {0,3}\[[^\]\n]*\]:\s*(?:#|<>)\s*(?:\(([^\n]*)\)|"([^\n]*)"|'([^\n]*)')\s*$/gm;
// Bounded body: an unclosed <p> must not make every later tag scan to the end of the document.
const HIDDEN_ELEMENT = /<(div|span|p|section|aside|small|font|sub|sup)\b([^>]{0,400})>([\s\S]{0,4000}?)<\/\1\s*>/gi;
const HIDDEN_STYLE = /\bhidden\b|display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|em|rem|pt|%)?\s*[;"']|opacity\s*:\s*0(?:\.0+)?\s*[;"']|color\s*:\s*(?:transparent|white|#fff(?:fff)?)\b/i;

/** Hidden markup in one prose segment. */
function stripHiddenMarkup(prose: string, hidden: HiddenText[]): string {
  return prose
    .replace(HTML_COMMENT, (_m, body: string) => {
      if (body.trim()) hidden.push({ kind: 'html-comment', text: body.trim() });
      return '';
    })
    .replace(MD_COMMENT, (_m, a?: string, b?: string, c?: string) => {
      const body = (a ?? b ?? c ?? '').trim();
      if (body) hidden.push({ kind: 'markdown-comment', text: body });
      return '';
    })
    .replace(HIDDEN_ELEMENT, (m, _tag: string, attrs: string, body: string) => {
      if (!HIDDEN_STYLE.test(attrs)) return m;
      if (body.trim()) hidden.push({ kind: 'hidden-html', text: body.trim() });
      return '';
    });
}

/**
 * Full normalization. `markup` (default true) also removes hidden markdown/HTML
 * from prose; pass false for code (type definitions, Python sources).
 */
export function normalize(input: string, opts: { markup?: boolean } = {}): Normalized {
  const chars = stripInvisible(input.replace(/\r\n?/g, '\n'));
  const hidden = chars.hidden;
  if (opts.markup === false) return { text: chars.text, hidden, removed: chars.removed };
  const text = splitFences(chars.text)
    .map((s) => (s.code ? s.text : stripHiddenMarkup(s.text, hidden)))
    .join('\n');
  return { text, hidden, removed: chars.removed };
}

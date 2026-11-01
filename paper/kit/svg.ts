/* eslint-disable no-control-regex -- the terminal renderer parses ANSI escapes */
/**
 * Shared pieces of the paper kit's figure scripts: the two themes, SVG text helpers, a
 * terminal-panel renderer and the SVG to PNG step (a Chrome or Edge already on the machine,
 * headless; nothing is installed).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Mode = 'light' | 'dark';

/** Chart chrome, from the validated reference palette (dataviz skill, references/palette.md). */
export const THEME = {
  light: { bg: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#6f6e69', grid: '#e1e0d9', axis: '#c3c2b7', border: '#e1e0d9', term: '#f4f3f0', termBar: '#e8e7e3' },
  dark: { bg: '#1a1a19', ink: '#f0efec', ink2: '#c3c2b7', muted: '#a3a29b', grid: '#2c2c2a', axis: '#383835', border: '#383835', term: '#111110', termBar: '#262624' },
} as const;

/**
 * One color per arm, the same in every figure. The two reference arms (no docs, no pin) are
 * grays; the four pinright arms take categorical slots in an order that passes the adjacent-pair
 * CVD and normal-vision checks in both modes (validate_palette.js, 2026-11-01).
 */
export const ARM_COLOR: Record<Mode, Record<string, string>> = {
  light: { 'no-docs': '#898781', 'docs-only': '#eb6834', pinright: '#2a78d6', 'hook-only': '#1baf7a', 'pinright+hook': '#eda100', latest: '#d9d8d2' },
  dark: { 'no-docs': '#898781', 'docs-only': '#d95926', pinright: '#3987e5', 'hook-only': '#199e70', 'pinright+hook': '#c98500', latest: '#45443f' },
};
/** Before/after pairs: the gray of "no docs" for before, the pinright blue for after. */
export const BEFORE = { light: '#a9a8a2', dark: '#6b6a65' } as const;
export const AFTER = { light: '#2a78d6', dark: '#3987e5' } as const;

export const ARM_SHORT: Record<string, string> = {
  'no-docs': 'No docs',
  'docs-only': 'docs-only (security layer off)',
  pinright: 'pinright MCP',
  'hook-only': 'pinright hook only',
  'pinright+hook': 'pinright MCP + hook',
  latest: 'No pin (reference)',
};

export const SANS = `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
export const MONO = `'Cascadia Mono', 'Cascadia Code', Consolas, 'SFMono-Regular', Menlo, 'DejaVu Sans Mono', monospace`;

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function text(x: number, y: number, s: string, o: { size?: number; fill: string; anchor?: 'start' | 'middle' | 'end'; weight?: number; font?: string; baseline?: string } ): string {
  return `<text x="${r(x)}" y="${r(y)}" font-family="${o.font ?? SANS}" font-size="${o.size ?? 13}" fill="${o.fill}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.weight ? ` font-weight="${o.weight}"` : ''}${o.baseline ? ` dominant-baseline="${o.baseline}"` : ''}>${esc(s)}</text>`;
}
export const r = (n: number) => String(Math.round(n * 10) / 10);

export function svgDoc(w: number, h: number, mode: Mode, title: string, desc: string, body: string): string {
  const t = THEME[mode];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${t.bg}" stroke="${t.border}"/>
${body}
</svg>
`;
}

/** Bar with a 4px rounded data end and a square base on the baseline (pointing up). */
export function barUp(x: number, y: number, w: number, h: number, fill: string, stroke?: string): string {
  if (h <= 0.01) return `<line x1="${r(x)}" x2="${r(x + w)}" y1="${r(y + h)}" y2="${r(y + h)}" stroke="${stroke ?? fill}" stroke-width="2"/>`;
  const rad = Math.min(4, h, w / 2);
  const b = y + h;
  const d = `M${r(x)},${r(b)} V${r(y + rad)} Q${r(x)},${r(y)} ${r(x + rad)},${r(y)} H${r(x + w - rad)} Q${r(x + w)},${r(y)} ${r(x + w)},${r(y + rad)} V${r(b)} Z`;
  return `<path d="${d}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1"` : ''}/>`;
}
/** Horizontal bar growing right from x, rounded at the data end. */
export function barRight(x: number, y: number, w: number, h: number, fill: string): string {
  if (w <= 0.01) return `<line x1="${r(x)}" x2="${r(x)}" y1="${r(y)}" y2="${r(y + h)}" stroke="${fill}" stroke-width="2"/>`;
  const rad = Math.min(4, w, h / 2);
  const d = `M${r(x)},${r(y)} H${r(x + w - rad)} Q${r(x + w)},${r(y)} ${r(x + w)},${r(y + rad)} V${r(y + h - rad)} Q${r(x + w)},${r(y + h)} ${r(x + w - rad)},${r(y + h)} H${r(x)} Z`;
  return `<path d="${d}" fill="${fill}"/>`;
}
/** Vertical 95% interval with caps. */
export function errV(cx: number, y1: number, y2: number, stroke: string): string {
  if (Math.abs(y1 - y2) < 0.5) return '';
  return `<g stroke="${stroke}" stroke-width="1.25" fill="none"><line x1="${r(cx)}" x2="${r(cx)}" y1="${r(y1)}" y2="${r(y2)}"/><line x1="${r(cx - 4)}" x2="${r(cx + 4)}" y1="${r(y1)}" y2="${r(y1)}"/><line x1="${r(cx - 4)}" x2="${r(cx + 4)}" y1="${r(y2)}" y2="${r(y2)}"/></g>`;
}

export function legend(x: number, y: number, items: { label: string; color: string; outline?: string }[], mode: Mode, maxW = 1e9): { svg: string; height: number } {
  const t = THEME[mode];
  let cx = x;
  let cy = y;
  const parts: string[] = [];
  for (const it of items) {
    const w = 18 + it.label.length * 6.5 + 28;
    if (cx + w > x + maxW) {
      cx = x;
      cy += 22;
    }
    parts.push(`<rect x="${r(cx)}" y="${r(cy - 10)}" width="12" height="12" rx="3" fill="${it.color}"${it.outline ? ` stroke="${it.outline}"` : ''}/>`);
    parts.push(text(cx + 18, cy, it.label, { size: 13, fill: t.ink2 }));
    cx += w;
  }
  return { svg: parts.join('\n'), height: cy - y + 22 };
}

// ------------------------------------------------------------------ terminal panels

const ANSI: Record<string, Record<Mode, string>> = {
  '31': { light: '#c03030', dark: '#e66767' },
  '32': { light: '#0a7a0a', dark: '#4cc24c' },
  '33': { light: '#946200', dark: '#e0a526' },
  '34': { light: '#1c5cab', dark: '#6da7ec' },
  '35': { light: '#a33a73', dark: '#e87ba4' },
  '36': { light: '#0e7c6b', dark: '#3fc1a5' },
  '90': { light: '#6f6e69', dark: '#a3a29b' },
};

interface Span { s: string; color?: string; bold?: boolean; dim?: boolean }

/** Splits a line with SGR escapes into styled spans. */
function spans(line: string): Span[] {
  const out: Span[] = [];
  let cur: Omit<Span, 's'> = {};
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (m) {
      for (const code of (m[1] || '0').split(';')) {
        if (code === '0') cur = {};
        else if (code === '1') cur = { ...cur, bold: true };
        else if (code === '2') cur = { ...cur, dim: true };
        else if (code === '22') cur = { ...cur, bold: false, dim: false };
        else if (code === '39') cur = { ...cur, color: undefined };
        else if (ANSI[code]) cur = { ...cur, color: code };
      }
    } else if (part) out.push({ s: part, ...cur });
  }
  return out;
}

/** Wraps a line to `cols` columns, continuing with a two-space indent; keeps the escapes. */
export function wrapAnsi(line: string, cols: number): string[] {
  // Plain characters, each with the SGR state in force (as an escape prefix).
  const chars: { c: string; sgr: string }[] = [];
  let sgr = '';
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) sgr = /^\x1b\[0?m$/.test(part) ? '' : sgr + part;
    else for (const c of part) chars.push({ c, sgr });
  }
  const plain = chars.map((x) => x.c).join('');
  if (plain.length <= cols) return [line];
  const indent = (plain.match(/^\s*/)?.[0] ?? '') + '  ';
  const encode = (from: number, to: number) => {
    let s = '';
    let cur = '';
    for (let i = from; i < to; i++) {
      if (chars[i].sgr !== cur) {
        s += `\x1b[0m${chars[i].sgr}`;
        cur = chars[i].sgr;
      }
      s += chars[i].c;
    }
    return cur ? `${s}\x1b[0m` : s;
  };
  const out: string[] = [];
  let start = 0;
  let first = true;
  while (plain.length - start > (first ? cols : cols - indent.length)) {
    const width = first ? cols : cols - indent.length;
    let cut = plain.lastIndexOf(' ', start + width);
    if (cut <= start + width * 0.5) cut = start + width;
    let end = cut;
    while (end > start && plain[end - 1] === ' ') end--;
    out.push((first ? '' : indent) + encode(start, end));
    start = cut;
    while (start < plain.length && plain[start] === ' ') start++;
    first = false;
  }
  out.push((first ? '' : indent) + encode(start, plain.length));
  return out;
}

export interface TerminalOpts {
  title: string;
  /** Lines shown as typed input (prefixed with the prompt, in bold). */
  prompt?: string;
  command?: string;
  lines: string[];
  cols?: number;
  mode: Mode;
  /** Lines (0-based, after wrapping) to tint as the hook's block message. */
  highlight?: (plain: string) => 'block' | 'ok' | undefined;
  desc: string;
}

export function terminal(o: TerminalOpts): { svg: string; w: number; h: number } {
  const t = THEME[o.mode];
  const cols = o.cols ?? 100;
  const size = 14;
  const cw = size * 0.6;
  const lh = 21;
  const pad = 22;
  const bar = 34;
  const body: string[] = [];
  if (o.command) body.push(`\x1b[1m${o.prompt ?? '$'} ${o.command}\x1b[22m`, '');
  for (const l of o.lines) body.push(...wrapAnsi(l, cols));
  const w = Math.round(pad * 2 + cols * cw);
  const h = Math.round(bar + pad + body.length * lh + pad - 6);
  const parts: string[] = [];
  parts.push(`<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${t.term}" stroke="${t.border}"/>`);
  parts.push(`<path d="M0.5,${bar} V10.5 Q0.5,0.5 10.5,0.5 H${w - 10.5} Q${w - 0.5},0.5 ${w - 0.5},10.5 V${bar} Z" fill="${t.termBar}"/>`);
  for (let i = 0; i < 3; i++) parts.push(`<circle cx="${20 + i * 18}" cy="${bar / 2}" r="5.5" fill="${t.axis}"/>`);
  parts.push(text(w / 2, bar / 2 + 1, o.title, { size: 13, fill: t.ink2, anchor: 'middle', baseline: 'middle' }));
  body.forEach((line, i) => {
    const y = bar + pad + i * lh + 4;
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    const hl = o.highlight?.(plain);
    if (hl) {
      const c = hl === 'block' ? (o.mode === 'light' ? '#fbe9e7' : '#3a2220') : o.mode === 'light' ? '#e6f4e6' : '#1d321d';
      parts.push(`<rect x="${pad - 8}" y="${y - lh + 6}" width="${w - 2 * pad + 16}" height="${lh}" fill="${c}"/>`);
    }
    const tspans = spans(line)
      .map((sp) => {
        const fill = sp.color ? ANSI[sp.color][o.mode] : sp.dim ? t.muted : t.ink;
        return `<tspan fill="${fill}"${sp.bold ? ' font-weight="700"' : ''}>${esc(sp.s)}</tspan>`;
      })
      .join('');
    parts.push(`<text x="${pad}" y="${y}" font-family="${MONO}" font-size="${size}" xml:space="preserve">${tspans}</text>`);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(o.title)}</title>
<desc id="d">${esc(o.desc)}</desc>
${parts.join('\n')}
</svg>
`;
  return { svg, w, h };
}

// ------------------------------------------------------------------ SVG to PNG

function browser(): string | undefined {
  const c =
    process.platform === 'win32'
      ? [
          join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
          join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
          join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return process.env.PINRIGHT_KIT_BROWSER ?? c.find((p) => existsSync(p));
}

/** Renders an SVG file to a PNG at 2x with a local headless Chrome or Edge. Returns false if none. */
export function pngFromSvg(svgPath: string, pngPath: string, w: number, h: number): boolean {
  const exe = browser();
  if (!exe) return false;
  const profile = mkdtempSync(join(tmpdir(), 'pinright-kit-'));
  try {
    const res = spawnSync(exe, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, '--force-device-scale-factor=2', `--window-size=${w},${h}`,
      '--default-background-color=00000000', `--screenshot=${pngPath}`, pathToFileURL(svgPath).href,
    ], { stdio: 'ignore', timeout: 60_000 });
    return res.status === 0 && existsSync(pngPath);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

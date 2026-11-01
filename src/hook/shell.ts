/**
 * A small reader for the command lines agents run: enough of POSIX sh, cmd and
 * PowerShell to find each simple command, its redirections and its stdin, and
 * the command lines nested inside `$(...)`, backticks and process substitutions.
 * It never executes anything and never fails: input it does not understand
 * becomes plain words.
 */

export interface SimpleCommand {
  words: string[];
  /** `>` and `>>` targets (also `&>`), in order. */
  writes: { file: string; append: boolean }[];
  /** `< file`. */
  input?: string;
  /** The body of a `<<` heredoc or a `<<<` here-string. */
  stdin?: string;
  /** True when this command's output is piped into the next one. */
  pipeNext: boolean;
}

export interface ParsedShell {
  commands: SimpleCommand[];
  /** Command lines found inside `$(...)`, backticks, `<(...)` and `>(...)`. */
  substitutions: string[];
}

/** Marks a word that the shell would compute at run time: its value is unknown here. */
export const DYNAMIC = '$(…)';

const fresh = (): SimpleCommand => ({ words: [], writes: [], pipeNext: false });

/** Index just past the `)` that closes the `(` at `open`, honoring quotes and nesting. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '\\') i++;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return s.length;
}

export function parseShell(src: string): ParsedShell {
  const commands: SimpleCommand[] = [];
  const substitutions: string[] = [];
  let cur = fresh();
  let tok = '';
  let has = false;
  let quoted = false;
  let pending: { kind: 'write' | 'input' | 'herestring' | 'heredoc'; append?: boolean; strip?: boolean } | undefined;
  const heredocs: { delim: string; strip: boolean; cmd: SimpleCommand }[] = [];

  const endCmd = (pipe: boolean) => {
    pushTok();
    if (cur.words.length || cur.writes.length || cur.stdin !== undefined || cur.input) {
      cur.pipeNext = pipe;
      commands.push(cur);
    }
    cur = fresh();
  };
  function pushTok() {
    if (!has) return;
    const t = tok;
    const wasQuoted = quoted;
    tok = '';
    has = false;
    quoted = false;
    if (pending) {
      const p = pending;
      pending = undefined;
      if (p.kind === 'write') cur.writes.push({ file: t, append: Boolean(p.append) });
      else if (p.kind === 'input') cur.input = t;
      else if (p.kind === 'herestring') cur.stdin = t;
      else heredocs.push({ delim: t, strip: Boolean(p.strip), cmd: cur });
      return;
    }
    // A bare brace opens or closes a group: `{ npm i x; }`.
    if (!wasQuoted && (t === '{' || t === '}')) {
      endCmd(false);
      return;
    }
    cur.words.push(t);
  }
  const substitution = (from: number): number => {
    const end = closeParen(src, from);
    substitutions.push(src.slice(from + 1, end - 1));
    tok += DYNAMIC;
    has = true;
    return end - 1;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? src.length : end;
      tok += src.slice(i + 1, stop);
      has = quoted = true;
      i = stop;
      continue;
    }
    if (c === '"') {
      has = quoted = true;
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        const d = src[j];
        if (d === '\\' && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1])) {
          if (src[j + 1] !== '\n') tok += src[j + 1];
          j++;
        } else if (d === '$' && src[j + 1] === '(') j = substitution(j + 1);
        else if (d === '`') {
          const end = src.indexOf('`', j + 1);
          const close = src.indexOf('"', j + 1);
          if (end > 0 && (close < 0 || end < close)) {
            substitutions.push(src.slice(j + 1, end));
            tok += DYNAMIC;
            j = end;
          } else if (j + 1 < src.length) tok += src[++j]; // PowerShell escape inside a string
        } else tok += d;
      }
      i = j;
      continue;
    }
    if (c === '\\') {
      // A line continuation joins the lines; it is not a word.
      if (next === '\n') {
        i++;
        continue;
      }
      if (next === '\r' && src[i + 2] === '\n') {
        i += 2;
        continue;
      }
      // Before a letter or a dot it is a Windows path separator (C:\tools\npm.cmd), kept for basename().
      else if (next !== undefined && /[A-Za-z0-9._-]/.test(next)) tok += c;
      else if (next !== undefined) {
        tok += next;
        i++;
      }
      has = true;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > 0) {
        substitutions.push(src.slice(i + 1, end));
        tok += DYNAMIC;
        has = true;
        i = end;
      } else if (next !== undefined && next !== '\n') {
        // PowerShell's escape character outside a string: n`pm is npm.
        tok += next;
        has = true;
        i++;
      }
      continue;
    }
    if (c === '$' && next === '(') {
      i = substitution(i + 1);
      continue;
    }
    if (c === '#' && !has) {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      pushTok();
      continue;
    }
    if (c === '\n') {
      endCmd(false);
      // Heredoc bodies start on the next line.
      while (heredocs.length) {
        const h = heredocs.shift() as { delim: string; strip: boolean; cmd: SimpleCommand };
        const body: string[] = [];
        let j = i + 1;
        while (j <= src.length) {
          const nl = src.indexOf('\n', j);
          const line = src.slice(j, nl < 0 ? src.length : nl).replace(/\r$/, '');
          j = nl < 0 ? src.length + 1 : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          body.push(line);
        }
        h.cmd.stdin = body.join('\n') + (body.length ? '\n' : '');
        i = j - 1;
      }
      continue;
    }
    if (c === ';') {
      endCmd(false);
      continue;
    }
    if (c === '|') {
      if (next === '|') {
        i++;
        endCmd(false);
      } else {
        if (next === '&') i++;
        endCmd(true);
      }
      continue;
    }
    if (c === '&') {
      if (next === '>') {
        pushTok();
        i++;
        const append = src[i + 1] === '>';
        if (append) i++;
        pending = { kind: 'write', append };
      } else {
        if (next === '&') i++;
        endCmd(false);
      }
      continue;
    }
    if (c === '(' || c === ')') {
      if (c === '(' && /^[<>]$/.test(tok)) {
        // <(...) or >(...): a process substitution.
        tok = '';
        has = false;
        i = substitution(i);
        continue;
      }
      endCmd(false);
      continue;
    }
    if (c === '>' || c === '<') {
      if (next === '(') {
        pushTok();
        i = substitution(i + 1);
        // The substitution stands for a file name; it is not one we can follow.
        tok = '';
        has = false;
        continue;
      }
      // "2>": the digits are a file descriptor, not a word.
      if (/^\d+$/.test(tok) && !quoted) {
        tok = '';
        has = false;
      } else pushTok();
      if (c === '>') {
        const append = next === '>';
        if (append || next === '|') i++;
        if (src[i + 1] === '&') {
          // >&2, 2>&1: a descriptor copy, no file.
          i++;
          while (/[\d-]/.test(src[i + 1] ?? '')) i++;
          continue;
        }
        pending = { kind: 'write', append };
      } else if (next === '<') {
        if (src[i + 2] === '<') {
          i += 2;
          pending = { kind: 'herestring' };
        } else {
          i++;
          const strip = src[i + 1] === '-';
          if (strip) i++;
          pending = { kind: 'heredoc', strip };
        }
      } else {
        if (next === '&') {
          i++;
          while (/[\d-]/.test(src[i + 1] ?? '')) i++;
          continue;
        }
        pending = { kind: 'input' };
      }
      continue;
    }
    tok += c;
    has = true;
  }
  endCmd(false);
  return { commands, substitutions };
}

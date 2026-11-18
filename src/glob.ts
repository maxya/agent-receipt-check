/**
 * Convert a glob (§4.11) to an anchored RegExp over POSIX relative paths.
 * Dotfiles are matched by `*`; `**` is the only recursive token.
 */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern;
  let out = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === '/' && p[i + 1] === '*' && p[i + 2] === '*' && i + 3 === p.length) {
      out += '(?:/.*)?';
      i += 3;
      continue;
    }
    if (c === '*' && p[i + 1] === '*') {
      const prevIsSlash = i > 0 && p[i - 1] === '/';
      if (p[i + 2] === '/' && (i === 0 || prevIsSlash)) {
        out += '(?:.*/)?';
        i += 3;
        continue;
      }
      out += '.*';
      i += 2;
      continue;
    }
    if (c === '*') {
      out += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (c === '{') {
      const end = p.indexOf('}', i + 1);
      if (end !== -1) {
        const body = p.slice(i + 1, end);
        const parts = body.split(',').map(escapeLiteral);
        out += `(?:${parts.join('|')})`;
        i = end + 1;
        continue;
      }
    }
    out += escapeLiteral(c);
    i++;
  }
  return new RegExp(`^${out}$`);
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** True when a path pattern uses glob syntax rather than naming one file/directory. */
export function isGlob(pattern: string): boolean {
  return /[*?{]/.test(pattern);
}

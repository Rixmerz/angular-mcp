/**
 * Minimal glob matching for the subset used by rules layers and decisions:
 * `**` (any number of path segments, including zero), `*` (anything within a
 * single segment) and `?` (a single character). Patterns and paths are always
 * POSIX-style, `/`-separated, relative paths (see `normalizeRelativePath` in
 * graph/model.ts).
 *
 * A dedicated matcher (instead of a general-purpose glob dependency) keeps
 * behavior exact, dependency-free and easy to test — the rules file only ever
 * needs this small subset.
 */

const REGEXP_SPECIAL_CHARS = /[.+^${}()|[\]\\]/g;

function escapeLiteral(char: string): string {
  return char.replace(REGEXP_SPECIAL_CHARS, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i]!;

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 3;
        } else {
          source += '.*';
          i += 2;
        }
        continue;
      }
      source += '[^/]*';
      i += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }

    source += escapeLiteral(char);
    i += 1;
  }

  return new RegExp(`^${source}$`);
}

const compiledPatterns = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  let regExp = compiledPatterns.get(pattern);
  if (!regExp) {
    regExp = globToRegExp(pattern);
    compiledPatterns.set(pattern, regExp);
  }
  return regExp;
}

/** True when `path` matches `pattern`. Both must be `/`-separated relative paths. */
export function matchGlob(pattern: string, path: string): boolean {
  return compile(pattern).test(path);
}

/** True when `path` matches at least one of `patterns`. */
export function matchAnyGlob(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchGlob(pattern, path));
}

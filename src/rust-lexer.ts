/**
 * Shared lexer for item-level Rust analysis (source ordering, Decision Atlas
 * anchors). It drops whitespace, line/nested block comments, string, byte,
 * C and raw string literals and char literals, keeps lifetimes and labels as a
 * `'` token followed by an identifier, and records each token's 1-based line.
 * rustc remains authoritative; this is not a full parser.
 */
export type RustToken = {
  text: string;
  line: number;
};

export function tokenizeRust(source: string): RustToken[] {
  const tokens: RustToken[] = [];
  let index = 0;
  let line = 1;

  const advance = (count = 1): void => {
    for (let offset = 0; offset < count; offset += 1) {
      if (source[index + offset] === "\n") line += 1;
    }
    index += count;
  };

  const skipQuoted = (quote: string): void => {
    advance();
    while (index < source.length) {
      if (source[index] === "\\") {
        advance(Math.min(2, source.length - index));
        continue;
      }
      if (source[index] === quote) {
        advance();
        return;
      }
      advance();
    }
  };

  const rawString = (): { prefixLength: number; hashes: string } | undefined => {
    const match = source.slice(index).match(/^(?:b|c)?r(#{0,255})"/);
    if (!match) return undefined;
    return { prefixLength: match[0].length, hashes: match[1] ?? "" };
  };

  const skipRawString = (prefixLength: number, hashes: string): void => {
    advance(prefixLength);
    const terminator = `"${hashes}`;
    while (index < source.length) {
      if (source.startsWith(terminator, index)) {
        advance(terminator.length);
        return;
      }
      advance();
    }
  };

  const skipBlockComment = (): void => {
    let depth = 1;
    advance(2);
    while (index < source.length && depth > 0) {
      if (source.startsWith("/*", index)) {
        depth += 1;
        advance(2);
      } else if (source.startsWith("*/", index)) {
        depth -= 1;
        advance(2);
      } else {
        advance();
      }
    }
  };

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (/\s/.test(char)) {
      advance();
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") advance();
      continue;
    }
    if (char === "/" && next === "*") {
      skipBlockComment();
      continue;
    }

    const raw = rawString();
    if (raw) {
      skipRawString(raw.prefixLength, raw.hashes);
      continue;
    }
    if ((char === "b" || char === "c") && next === '"') {
      advance();
      skipQuoted('"');
      continue;
    }
    if (char === '"') {
      skipQuoted('"');
      continue;
    }
    if (char === "b" && next === "'") {
      advance();
      skipQuoted("'");
      continue;
    }
    if (char === "'") {
      // A char literal is `'\<escape>'` or exactly one code point between quotes;
      // anything else (`'a`, `'static`, `'outer:`) is a lifetime or label.
      const codePoint = source.codePointAt(index + 1);
      const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
      if (next === "\\" || (next !== undefined && source[index + 1 + width] === "'")) {
        skipQuoted("'");
        continue;
      }
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      const tokenLine = line;
      advance();
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) advance();
      if (source.slice(start, index) === "r" && source[index] === "#") {
        advance();
        while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) advance();
      }
      tokens.push({ text: source.slice(start, index), line: tokenLine });
      continue;
    }

    const compound = ["::", "->", "=>", "..=", "..."].find((value) =>
      source.startsWith(value, index),
    );
    if (compound) {
      tokens.push({ text: compound, line });
      advance(compound.length);
      continue;
    }

    tokens.push({ text: char, line });
    advance();
  }

  return tokens;
}

export function matchingBraces(tokens: RustToken[]): Map<number, number> {
  const stack: number[] = [];
  const matches = new Map<number, number>();
  for (const [index, token] of tokens.entries()) {
    if (token.text === "{") stack.push(index);
    else if (token.text === "}") {
      const open = stack.pop();
      if (open !== undefined) {
        matches.set(open, index);
        matches.set(index, open);
      }
    }
  }
  return matches;
}

export function skipBalanced(
  tokens: RustToken[],
  start: number,
  open: string,
  close: string,
  limit: number,
): number {
  if (tokens[start]?.text !== open) return start;
  let depth = 1;
  let cursor = start + 1;
  while (cursor < limit && depth > 0) {
    if (tokens[cursor]!.text === open) depth += 1;
    else if (tokens[cursor]!.text === close) depth -= 1;
    cursor += 1;
  }
  return cursor;
}

export function skipAttributes(tokens: RustToken[], start: number, limit: number): number {
  let cursor = start;
  while (cursor < limit && tokens[cursor]?.text === "#") {
    cursor += 1;
    if (tokens[cursor]?.text === "!") cursor += 1;
    if (tokens[cursor]?.text !== "[") return start;
    cursor = skipBalanced(tokens, cursor, "[", "]", limit);
  }
  return cursor;
}

export function skipVisibility(tokens: RustToken[], start: number, limit: number): number {
  if (tokens[start]?.text !== "pub") return start;
  let cursor = start + 1;
  if (tokens[cursor]?.text === "(") {
    cursor = skipBalanced(tokens, cursor, "(", ")", limit);
  }
  return cursor;
}

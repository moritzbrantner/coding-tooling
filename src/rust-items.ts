import {
  matchingBraces,
  skipAttributes,
  skipBalanced,
  skipVisibility,
  tokenizeRust,
  type RustToken,
} from "./rust-lexer.ts";

/**
 * One named Rust item declared in a single source file, addressed by its
 * `::`-separated item path relative to that file: inline `mod` blocks add a
 * segment, enum variants are `Enum::Variant`, associated items of `impl Type`,
 * `impl Trait for Type` and `trait Trait` blocks are `Type::item`.
 */
export interface RustDeclaration {
  path: string[];
  /** 1-based line of the item's name identifier. */
  line: number;
  /** A `fn` carrying a `#[test]` (or `#[<path>::test]`) attribute. */
  test: boolean;
}

export type RustItemsResult =
  | { ok: true; declarations: RustDeclaration[] }
  | { ok: false; reason: string };

const identifier = /^(?:r#)?[A-Za-z_][A-Za-z0-9_]*$/u;
const keywords = new Set([
  "as",
  "async",
  "const",
  "crate",
  "dyn",
  "enum",
  "extern",
  "fn",
  "for",
  "impl",
  "mod",
  "mut",
  "pub",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "type",
  "union",
  "unsafe",
  "use",
  "where",
]);

function name(token: RustToken | undefined): string | undefined {
  if (!token || !identifier.test(token.text)) return undefined;
  const text = token.text.startsWith("r#") ? token.text.slice(2) : token.text;
  if (text === "_" || (keywords.has(text) && !token.text.startsWith("r#"))) return undefined;
  return text;
}

/** Fails closed on unbalanced `()`, `[]` or `{}` instead of guessing item extents. */
function balanced(tokens: RustToken[]): boolean {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.text === "(" || token.text === "[" || token.text === "{") stack.push(token.text);
    else if (pairs[token.text] && stack.pop() !== pairs[token.text]) return false;
  }
  return stack.length === 0;
}

/** True when an outer attribute list starting at `start` contains `#[test]` / `#[x::test]`. */
function hasTestAttribute(tokens: RustToken[], start: number, limit: number): boolean {
  let cursor = start;
  while (cursor < limit && tokens[cursor]?.text === "#") {
    cursor += 1;
    if (tokens[cursor]?.text === "!") cursor += 1;
    if (tokens[cursor]?.text !== "[") return false;
    const next = skipBalanced(tokens, cursor, "[", "]", limit);
    const path: string[] = [];
    let inner = cursor + 1;
    while (
      inner < next - 1 &&
      (identifier.test(tokens[inner]!.text) || tokens[inner]!.text === "::")
    )
      path.push(tokens[inner++]!.text);
    const end = tokens[inner]?.text;
    if (path[path.length - 1] === "test" && (inner === next - 1 || end === "("))
      if (path.length === 1 || path[path.length - 2] === "::") return true;
    cursor = next;
  }
  return false;
}

/** End (exclusive) of an item: its matching `}` (plus `;`) or its top-level `;`. */
function itemEnd(
  tokens: RustToken[],
  start: number,
  limit: number,
  braces: Map<number, number>,
  bodyAllowed: boolean,
): { end: number; bodyOpen?: number; bodyClose?: number } {
  let parens = 0;
  let brackets = 0;
  for (let cursor = start; cursor < limit; cursor += 1) {
    const text = tokens[cursor]!.text;
    if (text === "(") parens += 1;
    else if (text === ")") parens -= 1;
    else if (text === "[") brackets += 1;
    else if (text === "]") brackets -= 1;
    else if (text === "{" && parens === 0 && brackets === 0) {
      const close = braces.get(cursor)!;
      if (!bodyAllowed) {
        cursor = close;
        continue;
      }
      const end = tokens[close + 1]?.text === ";" ? close + 2 : close + 1;
      return { end, bodyOpen: cursor, bodyClose: close };
    } else if (text === ";" && parens === 0 && brackets === 0) return { end: cursor + 1 };
  }
  return { end: limit };
}

/** Skips a balanced `<...>` generic list (`->` and `=>` are single tokens). */
function skipGenerics(tokens: RustToken[], start: number, limit: number): number {
  if (tokens[start]?.text !== "<") return start;
  let depth = 0;
  let cursor = start;
  while (cursor < limit) {
    const text = tokens[cursor]!.text;
    if (text === "<") depth += 1;
    else if (text === ">") depth -= 1;
    cursor += 1;
    if (depth === 0) break;
  }
  return cursor;
}

/** The self type's final path segment in an `impl` header, or undefined for `(A, B)`, `[T]`, etc. */
function implSelfType(tokens: RustToken[], start: number, bodyOpen: number): string | undefined {
  let cursor = skipGenerics(tokens, start, bodyOpen);
  // `impl Trait for Type`: the self type follows a top-level `for` (not `for<'a>` bounds).
  let depth = 0;
  for (let scan = cursor; scan < bodyOpen; scan += 1) {
    const text = tokens[scan]!.text;
    if (text === "<" || text === "(" || text === "[") depth += 1;
    else if (text === ">" || text === ")" || text === "]") depth -= 1;
    else if (text === "where" && depth === 0) break;
    else if (text === "for" && depth === 0 && tokens[scan + 1]?.text !== "<") {
      cursor = scan + 1;
      break;
    }
  }
  if (tokens[cursor]?.text === "!") cursor += 1;
  while (cursor < bodyOpen) {
    const text = tokens[cursor]!.text;
    if (text === "&" || text === "*" || text === "mut" || text === "const" || text === "dyn")
      cursor += 1;
    else if (text === "'") cursor += 2;
    else break;
  }
  let last: string | undefined;
  while (cursor < bodyOpen) {
    if (tokens[cursor]!.text === "::") {
      cursor += 1;
      continue;
    }
    const segment = tokens[cursor]!.text;
    if (!identifier.test(segment) || segment === "where" || segment === "for") break;
    last = name(tokens[cursor]) ?? segment;
    cursor += 1;
    if (tokens[cursor]?.text === "<") cursor = skipGenerics(tokens, cursor, bodyOpen);
    if (tokens[cursor]?.text !== "::") break;
  }
  return last === "Self" || last === "self" ? undefined : last;
}

class RustItemParser {
  readonly declarations: RustDeclaration[] = [];
  private readonly braces: Map<number, number>;

  constructor(private readonly tokens: RustToken[]) {
    this.braces = matchingBraces(tokens);
  }

  private declare(path: string[], token: RustToken, test = false): void {
    this.declarations.push({ path, line: token.line, test });
  }

  /** Module or block scope: items whose names extend `prefix`. */
  items(start: number, end: number, prefix: string[], owner?: string): void {
    let cursor = start;
    while (cursor < end) {
      const text = this.tokens[cursor]!.text;
      if (text === ";" || text === ",") {
        cursor += 1;
        continue;
      }
      // Inner attributes (`#![...]`) belong to the enclosing scope.
      if (text === "#" && this.tokens[cursor + 1]?.text === "!") {
        cursor = skipBalanced(this.tokens, cursor + 2, "[", "]", end);
        continue;
      }
      cursor = this.item(cursor, end, prefix, owner);
    }
  }

  private item(start: number, limit: number, prefix: string[], owner?: string): number {
    const tokens = this.tokens;
    const test = hasTestAttribute(tokens, start, limit);
    let cursor = skipVisibility(tokens, skipAttributes(tokens, start, limit), limit);
    const qualifiers = new Set(["async", "const", "unsafe", "extern", "default", "auto", "safe"]);
    // `const NAME` is an item; `const fn` / `const unsafe fn` are qualifiers.
    while (
      cursor < limit &&
      qualifiers.has(tokens[cursor]!.text) &&
      !(tokens[cursor]!.text === "const" && name(tokens[cursor + 1]))
    ) {
      if (tokens[cursor]!.text === "extern" && tokens[cursor + 1]?.text === "crate") break;
      if (tokens[cursor]!.text === "extern" && tokens[cursor + 1]?.text === "{") {
        // `extern "C" { ... }` (the ABI string is not a token): foreign items join this scope.
        const close = this.braces.get(cursor + 1)!;
        this.items(cursor + 2, close, prefix, owner);
        return close + 1;
      }
      cursor += 1;
    }
    const keyword = tokens[cursor]?.text;
    const scoped = (item: string) => (owner ? [...prefix, owner, item] : [...prefix, item]);
    const nameToken = tokens[cursor + 1];
    const itemName = name(nameToken);

    switch (keyword) {
      case "fn":
      case "struct":
      case "union":
      case "type":
      case "static":
      case "const":
      case "trait":
      case "enum":
      case "mod": {
        const isStatic = keyword === "static" && tokens[cursor + 1]?.text === "mut";
        const declaredToken = isStatic ? tokens[cursor + 2] : nameToken;
        const declared = isStatic ? name(declaredToken) : itemName;
        const extent = itemEnd(
          tokens,
          cursor,
          limit,
          this.braces,
          keyword !== "static" && keyword !== "const" && keyword !== "type",
        );
        if (!declared || !declaredToken) return extent.end;
        if (keyword === "fn") {
          this.declare(scoped(declared), declaredToken, test);
          return extent.end;
        }
        this.declare(scoped(declared), declaredToken);
        if (extent.bodyOpen !== undefined && extent.bodyClose !== undefined) {
          if (keyword === "mod" && !owner)
            this.items(extent.bodyOpen + 1, extent.bodyClose, [...prefix, declared]);
          else if (keyword === "trait" && !owner)
            this.items(extent.bodyOpen + 1, extent.bodyClose, prefix, declared);
          else if (keyword === "enum")
            this.variants(extent.bodyOpen + 1, extent.bodyClose, scoped(declared));
        }
        return extent.end;
      }
      case "impl": {
        const extent = itemEnd(tokens, cursor, limit, this.braces, true);
        if (extent.bodyOpen === undefined || extent.bodyClose === undefined || owner)
          return extent.end;
        const self = implSelfType(tokens, cursor + 1, extent.bodyOpen);
        if (self) this.items(extent.bodyOpen + 1, extent.bodyClose, prefix, self);
        return extent.end;
      }
      case "macro_rules": {
        const extent = itemEnd(tokens, cursor, limit, this.braces, true);
        const macro = name(tokens[cursor + 2]);
        if (tokens[cursor + 1]?.text === "!" && macro && !owner)
          this.declare(scoped(macro), tokens[cursor + 2]!);
        return extent.end;
      }
      default:
        // `use`, `extern crate`, macro invocations and anything unrecognised declare nothing here.
        return itemEnd(tokens, Math.min(cursor, limit - 1), limit, this.braces, true).end;
    }
  }

  /** Enum body: comma-separated variants, each optionally attributed. */
  private variants(start: number, end: number, enumPath: string[]): void {
    let cursor = start;
    while (cursor < end) {
      cursor = skipVisibility(this.tokens, skipAttributes(this.tokens, cursor, end), end);
      const variant = name(this.tokens[cursor]);
      if (variant) this.declare([...enumPath, variant], this.tokens[cursor]!);
      let depth = 0;
      while (cursor < end) {
        const text = this.tokens[cursor]!.text;
        if (text === "(" || text === "[" || text === "{") depth += 1;
        else if (text === ")" || text === "]" || text === "}") depth -= 1;
        else if (text === "," && depth === 0) break;
        cursor += 1;
      }
      cursor += 1;
    }
  }
}

/**
 * Item-level Rust declarations of one file, built on the shared lexer so that
 * comments, strings, raw strings and char literals never produce matches.
 * Out-of-line `mod x;` files, macro-generated items and `use` re-exports are not
 * followed; function bodies are not searched for nested items.
 */
export function rustDeclarations(source: string): RustItemsResult {
  const tokens = tokenizeRust(source);
  if (!balanced(tokens))
    return { ok: false, reason: "Rust source has unbalanced delimiters and cannot be parsed" };
  const parser = new RustItemParser(tokens);
  parser.items(0, tokens.length, []);
  return { ok: true, declarations: parser.declarations };
}

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative } from "node:path";
import type * as Ts from "@typescript/typescript6";

import type { Component } from "./model.ts";
import { walkFiles } from "./shared.ts";

const require = createRequire(import.meta.url);
type TypeScriptApi = typeof import("@typescript/typescript6");
let typeScriptApi: TypeScriptApi | undefined;

function typeScript(): TypeScriptApi {
  typeScriptApi ??= require("@typescript/typescript6") as TypeScriptApi;
  return typeScriptApi;
}

function componentRoot(root: string, component: Component): string {
  return component.path === "." ? root : join(root, component.path);
}

function lineOf(sourceFile: Ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function declarationName(statement: Ts.Statement): string | undefined {
  if (
    typeScript().isTypeAliasDeclaration(statement) ||
    typeScript().isInterfaceDeclaration(statement)
  ) {
    return statement.name.text;
  }
  return undefined;
}

function typeReferenceName(node: Ts.Node): string | undefined {
  if (!typeScript().isTypeReferenceNode(node)) return undefined;
  if (typeScript().isIdentifier(node.typeName)) return node.typeName.text;
  return node.typeName.right.text;
}

function referencesType(node: Ts.Node | undefined, name: string): boolean {
  if (!node) return false;
  let found = false;
  const visit = (current: Ts.Node): void => {
    if (found) return;
    if (typeReferenceName(current) === name) {
      found = true;
      return;
    }
    current.forEachChild(visit);
  };
  visit(node);
  return found;
}

function componentNamesUsingProps(statement: Ts.Statement, propsName: string): string[] {
  const expectedComponent = propsName.endsWith("Props") ? propsName.slice(0, -"Props".length) : "";
  if (!expectedComponent || !/^[A-Z][A-Za-z0-9]*$/.test(expectedComponent)) return [];

  if (
    typeScript().isFunctionDeclaration(statement) &&
    statement.name?.text === expectedComponent &&
    (statement.parameters.some((parameter) => referencesType(parameter.type, propsName)) ||
      referencesType(statement.type, propsName))
  ) {
    return [expectedComponent];
  }

  if (!typeScript().isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) => {
    if (!typeScript().isIdentifier(declaration.name) || declaration.name.text !== expectedComponent)
      return [];
    if (
      referencesType(declaration.type, propsName) ||
      referencesType(declaration.initializer, propsName)
    ) {
      return [expectedComponent];
    }
    return [];
  });
}

export function reactPropsAdjacencyFailures(root: string, components: Component[]): string[] {
  const failures: string[] = [];
  const roots = new Set(
    components
      .filter(
        (component) => component.kind === "package" && component.technologies.includes("react"),
      )
      .map((component) => componentRoot(root, component)),
  );

  for (const packageRoot of roots) {
    for (const file of walkFiles(packageRoot, 10).filter(
      (candidate) => extname(candidate) === ".tsx",
    )) {
      try {
        if (statSync(file).size > 1_000_000) continue;
        const content = readFileSync(file, "utf8");
        const sourceFile = typeScript().createSourceFile(
          file,
          content,
          typeScript().ScriptTarget.Latest,
          true,
          typeScript().ScriptKind.TSX,
        );
        const statements = sourceFile.statements;
        const propsDeclarations = new Map<string, number>();
        for (const [index, statement] of statements.entries()) {
          const name = declarationName(statement);
          if (name?.endsWith("Props")) propsDeclarations.set(name, index);
        }

        for (const [propsName, propsIndex] of propsDeclarations) {
          const componentName = propsName.slice(0, -"Props".length);
          const componentIndex = statements.findIndex((statement) =>
            componentNamesUsingProps(statement, propsName).includes(componentName),
          );
          if (componentIndex < 0) continue;
          if (propsIndex + 1 === componentIndex) continue;
          failures.push(
            `${relative(root, file).replaceAll("\\", "/")}:${lineOf(
              sourceFile,
              statements[componentIndex]!.getStart(sourceFile),
            )}: ${propsName} must appear immediately before ${componentName}`,
          );
        }
      } catch {
        // Syntax/typechecking remains the repository's normal TypeScript validation responsibility.
      }
    }
  }
  return failures;
}

type CSharpToken = { text: string; line: number };
type CSharpMember = { kind: number; access: number; line: number; label: string };

const csharpKindOrder: Record<string, number> = {
  field: 0,
  constructor: 1,
  finalizer: 2,
  delegate: 3,
  event: 4,
  enum: 5,
  interface: 6,
  property: 7,
  indexer: 8,
  operator: 9,
  method: 10,
  struct: 11,
  class: 12,
};

function tokenizeCSharp(source: string): CSharpToken[] {
  const tokens: CSharpToken[] = [];
  let index = 0;
  let line = 1;
  const advance = (count = 1): void => {
    for (let offset = 0; offset < count; offset += 1) {
      if (source[index + offset] === "\n") line += 1;
    }
    index += count;
  };
  const skipQuoted = (quote: string, verbatim = false): void => {
    advance();
    while (index < source.length) {
      const char = source[index]!;
      if (!verbatim && char === "\\") {
        advance(Math.min(2, source.length - index));
        continue;
      }
      if (char === quote) {
        if (verbatim && source[index + 1] === quote) {
          advance(2);
          continue;
        }
        advance();
        return;
      }
      advance();
    }
  };
  const skipRawString = (quotes: number): void => {
    advance(quotes);
    const terminator = '"'.repeat(quotes);
    while (index < source.length) {
      if (source.startsWith(terminator, index)) {
        advance(quotes);
        return;
      }
      advance();
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
      advance(2);
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        advance();
      }
      if (index < source.length) advance(2);
      continue;
    }
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") advance();
      continue;
    }
    if (char === "'") {
      skipQuoted("'");
      continue;
    }

    const prefixStart = index;
    let prefixEnd = index;
    while (source[prefixEnd] === "$" || source[prefixEnd] === "@") prefixEnd += 1;
    if (source[prefixEnd] === '"') {
      const quoteCount = source.slice(prefixEnd).match(/^"+/)?.[0].length ?? 1;
      const verbatim = source.slice(prefixStart, prefixEnd).includes("@");
      advance(prefixEnd - prefixStart);
      if (quoteCount >= 3) skipRawString(quoteCount);
      else skipQuoted('"', verbatim);
      continue;
    }
    if (char === '"') {
      const quoteCount = source.slice(index).match(/^"+/)?.[0].length ?? 1;
      if (quoteCount >= 3) skipRawString(quoteCount);
      else skipQuoted('"');
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      const tokenLine = line;
      advance();
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) advance();
      tokens.push({ text: source.slice(start, index), line: tokenLine });
      continue;
    }
    if (char === "=" && next === ">") {
      tokens.push({ text: "=>", line });
      advance(2);
      continue;
    }
    tokens.push({ text: char, line });
    advance();
  }
  return tokens;
}

function matchingBraces(tokens: CSharpToken[]): Map<number, number> {
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

function nextIdentifier(tokens: CSharpToken[], start: number): string | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    const text = tokens[index]!.text;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text) && text !== "class" && text !== "struct") {
      return text;
    }
    if (text === "{" || text === ";") return undefined;
  }
  return undefined;
}

function memberAccess(header: string[], interfaceMember: boolean): number {
  if (header.includes("public")) return 0;
  if (header.includes("internal") && header.includes("protected")) return 2;
  if (header.includes("internal")) return 1;
  if (header.includes("private") && header.includes("protected")) return 4;
  if (header.includes("protected")) return 3;
  if (header.includes("private")) return 5;
  if (interfaceMember || header.includes(".")) return 0;
  return 5;
}

function classifyMember(
  header: string[],
  typeName: string,
  hasBody: boolean,
): { kind: number; label: string } | undefined {
  const has = (value: string): boolean => header.includes(value);
  if (has("delegate")) return { kind: csharpKindOrder["delegate"]!, label: "delegate" };
  if (has("event")) return { kind: csharpKindOrder["event"]!, label: "event" };
  if (has("enum")) return { kind: csharpKindOrder["enum"]!, label: "enum" };
  if (has("interface")) {
    return { kind: csharpKindOrder["interface"]!, label: "interface" };
  }
  if (has("struct") && !has("record")) {
    return { kind: csharpKindOrder["struct"]!, label: "struct" };
  }
  if (has("class") || has("record")) {
    return { kind: csharpKindOrder["class"]!, label: "class" };
  }
  if (has("operator")) {
    return { kind: csharpKindOrder["operator"]!, label: "operator" };
  }
  if (header[0] === "~") {
    return { kind: csharpKindOrder["finalizer"]!, label: "finalizer" };
  }

  if (has("this") && has("[")) {
    return { kind: csharpKindOrder["indexer"]!, label: "indexer" };
  }
  const arrow = header.indexOf("=>");
  const paren = header.indexOf("(");
  if (paren >= 0 && (arrow < 0 || paren < arrow)) {
    const previous = header[paren - 1];
    if (previous === typeName) {
      return { kind: csharpKindOrder["constructor"]!, label: "constructor" };
    }
    return { kind: csharpKindOrder["method"]!, label: "method" };
  }
  if (hasBody || arrow >= 0) {
    return { kind: csharpKindOrder["property"]!, label: "property" };
  }
  return { kind: csharpKindOrder["field"]!, label: "field" };
}

function parseTypeMembers(
  tokens: CSharpToken[],
  open: number,
  close: number,
  typeName: string,
  typeKind: string,
  braces: Map<number, number>,
): CSharpMember[] {
  const members: CSharpMember[] = [];
  let cursor = open + 1;
  while (cursor < close) {
    while (cursor < close && (tokens[cursor]!.text === ";" || tokens[cursor]!.text === ",")) {
      cursor += 1;
    }
    if (cursor >= close) break;

    while (tokens[cursor]?.text === "[") {
      let depth = 1;
      cursor += 1;
      while (cursor < close && depth > 0) {
        if (tokens[cursor]!.text === "[") depth += 1;
        else if (tokens[cursor]!.text === "]") depth -= 1;
        cursor += 1;
      }
    }
    if (cursor >= close) break;

    const start = cursor;
    let parens = 0;
    let brackets = 0;
    let equalsSeen = false;
    let terminator = -1;
    let bodyClose = -1;
    while (cursor < close) {
      const text = tokens[cursor]!.text;
      if (text === "(") parens += 1;
      else if (text === ")") parens = Math.max(0, parens - 1);
      else if (text === "[") brackets += 1;
      else if (text === "]") brackets = Math.max(0, brackets - 1);
      else if (text === "=" && parens === 0 && brackets === 0) equalsSeen = true;
      else if (text === "{" && parens === 0 && brackets === 0) {
        const matching = braces.get(cursor);
        if (matching === undefined) break;
        if (equalsSeen) {
          cursor = matching + 1;
          continue;
        }
        terminator = cursor;
        bodyClose = matching;
        break;
      } else if (text === ";" && parens === 0 && brackets === 0) {
        terminator = cursor;
        break;
      }
      cursor += 1;
    }
    if (terminator < 0) break;

    const header = tokens.slice(start, terminator).map((token) => token.text);
    const classified = classifyMember(header, typeName, bodyClose >= 0);
    if (classified) {
      members.push({
        kind: classified.kind,
        access: memberAccess(header, typeKind === "interface"),
        line: tokens[start]!.line,
        label: classified.label,
      });
    }
    if (bodyClose >= 0) {
      cursor = bodyClose + 1;
      if (tokens[cursor]?.text === "=") {
        let parensAfterBody = 0;
        let bracketsAfterBody = 0;
        cursor += 1;
        while (cursor < close) {
          const text = tokens[cursor]!.text;
          if (text === "(") parensAfterBody += 1;
          else if (text === ")") parensAfterBody = Math.max(0, parensAfterBody - 1);
          else if (text === "[") bracketsAfterBody += 1;
          else if (text === "]") bracketsAfterBody = Math.max(0, bracketsAfterBody - 1);
          else if (text === "{" && parensAfterBody === 0 && bracketsAfterBody === 0) {
            const matching = braces.get(cursor);
            if (matching === undefined) break;
            cursor = matching + 1;
            continue;
          } else if (text === ";" && parensAfterBody === 0 && bracketsAfterBody === 0) {
            cursor += 1;
            break;
          }
          cursor += 1;
        }
      }
    } else {
      cursor = terminator + 1;
    }
  }
  return members;
}

function csharpOrderingFailuresForSource(source: string, relativePath: string): string[] {
  if (/^\s*#(?:if|elif|else|endif)\b/m.test(source)) return [];
  if (/^\s*\/\/\s*<auto-generated[>\s]/im.test(source)) return [];
  const failures: string[] = [];
  const tokens = tokenizeCSharp(source);
  const braces = matchingBraces(tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    const kind = tokens[index]!.text;
    if (!(kind === "class" || kind === "struct" || kind === "interface" || kind === "record")) {
      continue;
    }
    const typeName = nextIdentifier(tokens, index + 1);
    if (!typeName) continue;
    let open = index + 1;
    while (open < tokens.length && tokens[open]!.text !== "{" && tokens[open]!.text !== ";") {
      open += 1;
    }
    if (tokens[open]?.text !== "{") continue;
    const close = braces.get(open);
    if (close === undefined) continue;

    const members = parseTypeMembers(tokens, open, close, typeName, kind, braces);
    let previous: CSharpMember | undefined;
    for (const member of members) {
      if (
        previous &&
        (member.kind < previous.kind ||
          (member.kind === previous.kind && member.access < previous.access))
      ) {
        failures.push(
          `${relativePath}:${member.line}: ${member.label} is out of canonical kind/access order in ${typeName}`,
        );
        break;
      }
      previous = member;
    }
  }
  return failures;
}

export function csharpMemberOrderingFailures(root: string, components: Component[]): string[] {
  const failures: string[] = [];
  const roots = new Set(
    components
      .filter((component) => component.kind === "dotnet")
      .map((component) => componentRoot(root, component)),
  );
  for (const dotnetRoot of roots) {
    for (const file of walkFiles(dotnetRoot, 12).filter((candidate) => {
      const normalized = candidate.replaceAll("\\", "/");
      return extname(candidate) === ".cs" && !/(?:\.g|\.generated)\.cs$/i.test(normalized);
    })) {
      try {
        if (statSync(file).size > 1_000_000) continue;
        const relativePath = relative(root, file).replaceAll("\\", "/");
        failures.push(...csharpOrderingFailuresForSource(readFileSync(file, "utf8"), relativePath));
      } catch {
        // Compiler validation remains authoritative for invalid/unreadable C# source.
      }
    }
  }
  return failures;
}

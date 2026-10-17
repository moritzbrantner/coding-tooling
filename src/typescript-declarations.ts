import { createRequire } from "node:module";
import type * as Ts from "@typescript/typescript6";

const require = createRequire(import.meta.url);
type TypeScriptApi = typeof import("@typescript/typescript6");
let typeScriptApi: TypeScriptApi | undefined;

function typeScript(): TypeScriptApi {
  typeScriptApi ??= require("@typescript/typescript6") as TypeScriptApi;
  return typeScriptApi;
}

/** A named TypeScript declaration or a literal-named test case in one file. */
export interface TypeScriptSymbol {
  /** `.`-joined declaration path, or ` > `-joined describe/test path for tests. */
  name: string;
  /** 1-based line of the name identifier (of the `test(`/`it(` call for tests). */
  line: number;
  /** Declarations of one name that TypeScript merges (overloads, accessor pairs, interfaces). */
  merge: string;
}

export interface TypeScriptSymbols {
  declarations: TypeScriptSymbol[];
  tests: TypeScriptSymbol[];
}

function scriptKind(ts: TypeScriptApi, path: string): Ts.ScriptKind {
  return path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function memberName(ts: TypeScriptApi, name: Ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

const testModifiers = new Set(["only", "skip", "todo", "concurrent", "failing", "serial"]);

/** `test`, `it` or `describe`, optionally with one modifier (`test.only`); `.each` is not literal. */
function testCallee(ts: TypeScriptApi, expression: Ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    testModifiers.has(expression.name.text)
  )
    return expression.expression.text;
  return undefined;
}

/**
 * Parses one TypeScript file with the TypeScript compiler API (syntax
 * only; no type checking or module resolution) and lists its declarations and
 * literal-named `test()` / `it()` cases. Comments and strings never match.
 */
export function typeScriptSymbols(path: string, source: string): TypeScriptSymbols {
  const ts = typeScript();
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(ts, path),
  );
  const declarations: TypeScriptSymbol[] = [];
  const tests: TypeScriptSymbol[] = [];
  const lineOf = (node: Ts.Node) =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const add = (prefix: string[], name: string | undefined, node: Ts.Node, merge: string) => {
    if (name) declarations.push({ name: [...prefix, name].join("."), line: lineOf(node), merge });
  };

  const members = (prefix: string[], list: readonly (Ts.ClassElement | Ts.TypeElement)[]) => {
    for (const member of list) {
      const name = memberName(ts, member.name);
      if (!member.name || !name) continue;
      const merge =
        ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)
          ? "accessor"
          : ts.isMethodDeclaration(member) || ts.isMethodSignature(member)
            ? "method"
            : String(member.kind);
      add(prefix, name, member.name, merge);
    }
  };

  const statements = (prefix: string[], list: readonly Ts.Statement[]) => {
    for (const statement of list) {
      if (ts.isFunctionDeclaration(statement) && statement.name)
        add(prefix, statement.name.text, statement.name, "function");
      else if (ts.isClassDeclaration(statement) && statement.name) {
        add(prefix, statement.name.text, statement.name, "class");
        members([...prefix, statement.name.text], statement.members);
      } else if (ts.isInterfaceDeclaration(statement)) {
        add(prefix, statement.name.text, statement.name, "interface");
        members([...prefix, statement.name.text], statement.members);
      } else if (ts.isTypeAliasDeclaration(statement))
        add(prefix, statement.name.text, statement.name, "type");
      else if (ts.isEnumDeclaration(statement)) {
        add(prefix, statement.name.text, statement.name, "enum");
        for (const member of statement.members)
          add([...prefix, statement.name.text], memberName(ts, member.name), member.name, "member");
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name))
            add(prefix, declaration.name.text, declaration.name, "variable");
      } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
        // `namespace A.B {}` nests ModuleDeclarations; each segment extends the path.
        let module: Ts.ModuleDeclaration = statement;
        const scope = [...prefix];
        for (;;) {
          add(scope, (module.name as Ts.Identifier).text, module.name, "namespace");
          scope.push((module.name as Ts.Identifier).text);
          if (module.body && ts.isModuleDeclaration(module.body)) module = module.body;
          else break;
        }
        if (module.body && ts.isModuleBlock(module.body)) statements(scope, module.body.statements);
      }
    }
  };
  statements([], file.statements);

  const visit = (node: Ts.Node, describe: string[]) => {
    if (ts.isCallExpression(node)) {
      const callee = testCallee(ts, node.expression);
      const first = node.arguments[0];
      const name =
        first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
          ? first.text
          : undefined;
      if (name !== undefined && callee === "describe") {
        ts.forEachChild(node, (child) => visit(child, [...describe, name]));
        return;
      }
      if (name !== undefined && (callee === "test" || callee === "it"))
        tests.push({ name: [...describe, name].join(" > "), line: lineOf(node), merge: "test" });
    }
    ts.forEachChild(node, (child) => visit(child, describe));
  };
  visit(file, []);
  return { declarations, tests };
}

/**
 * Matches one exact name. Declarations TypeScript merges into one symbol
 * (overloads, get/set pairs, interface or namespace merging) count once, at
 * their first line; distinct declarations of the same name are ambiguous.
 */
export function matchTypeScriptSymbol(
  symbols: TypeScriptSymbol[],
  name: string,
): TypeScriptSymbol[] {
  const matches = symbols.filter((symbol) => symbol.name === name);
  const mergeable = new Set(["function", "method", "accessor", "interface", "namespace"]);
  const first = matches[0];
  if (first && mergeable.has(first.merge) && matches.every((match) => match.merge === first.merge))
    return [first];
  return matches;
}

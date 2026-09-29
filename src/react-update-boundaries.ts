import ts from "@typescript/typescript6";

export type ReactUpdateBoundaryKind =
  | "animation-frame-state"
  | "effect-mirrored-state"
  | "broad-context-update-risk";
export type ReactUpdateBoundaryFinding = {
  kind: ReactUpdateBoundaryKind;
  conventionId: string;
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  subject: string;
  message: string;
  recommendation: string;
};

type Callback = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;
type State = { value: ts.Symbol; setter: ts.Symbol; name: string };

const conventions: Record<ReactUpdateBoundaryKind, string> = {
  "animation-frame-state": "REACT-008",
  "effect-mirrored-state": "REACT-009",
  "broad-context-update-risk": "REACT-010",
};

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
}

/** Syntax evidence only: imported React bindings and same-file, directly invoked callbacks. */
export function analyzeReactUpdateBoundaries(
  path: string,
  content: string,
): ReactUpdateBoundaryFinding[] {
  const file = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : path.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : /\.[cm]?js$/.test(path)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
  );
  if (
    !file.statements.some(
      (node) =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "react",
    )
  )
    return [];
  const program = ts.createProgram(
    [path],
    { noLib: true, noResolve: true, allowJs: true },
    {
      getSourceFile: (name) => (name === path ? file : undefined),
      getDefaultLibFileName: () => "",
      writeFile: () => {},
      getCurrentDirectory: () => "",
      getDirectories: () => [],
      fileExists: (name) => name === path,
      readFile: (name) => (name === path ? content : undefined),
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
    },
  );
  const checker = program.getTypeChecker();
  const symbol = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);
  const imports = new Map<ts.Symbol, string>();
  const namespaces = new Set<ts.Symbol>();
  const states: State[] = [];
  const contexts = new Set<ts.Symbol>();
  const mutated = new Set<ts.Symbol>();
  const result: ReactUpdateBoundaryFinding[] = [];
  const seen = new Set<string>();

  function reactCall(node: ts.Expression, name: string): boolean {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return imports.get(symbol(node)!) === name;
    return (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === name &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(symbol(node.expression)!)
    );
  }
  function callback(node: ts.Expression | undefined): Callback | undefined {
    if (!node) return undefined;
    node = unwrap(node);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
    if (!ts.isIdentifier(node)) return undefined;
    if (mutated.has(symbol(node)!)) return undefined;
    const declarations = symbol(node)?.declarations;
    if (declarations?.length !== 1) return undefined;
    const declaration = declarations[0]!;
    if (ts.isFunctionDeclaration(declaration)) return declaration;
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    ) {
      const value = unwrap(declaration.initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
    }
    return undefined;
  }
  function add(
    kind: ReactUpdateBoundaryKind,
    node: ts.Node,
    subject: string,
    message: string,
    recommendation: string,
  ): void {
    const key = `${kind}:${node.getStart(file)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const start = file.getLineAndCharacterOfPosition(node.getStart(file));
    const end = file.getLineAndCharacterOfPosition(node.getEnd());
    result.push({
      kind,
      conventionId: conventions[kind],
      path,
      startLine: start.line + 1,
      startColumn: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
      subject,
      message,
      recommendation,
    });
  }

  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "react" ||
      statement.importClause?.isTypeOnly
    )
      continue;
    const clause = statement.importClause;
    if (clause?.name) namespaces.add(symbol(clause.name)!);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(symbol(bindings.name)!);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly)
          imports.set(symbol(binding.name)!, binding.propertyName?.text ?? binding.name.text);
      }
    }
  }
  if (imports.size === 0 && namespaces.size === 0) return [];

  walk(file, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    const initializer = unwrap(node.initializer);
    if (!ts.isCallExpression(initializer)) return;
    if (reactCall(initializer.expression, "createContext") && ts.isIdentifier(node.name))
      contexts.add(symbol(node.name)!);
    if (
      !reactCall(initializer.expression, "useState") ||
      !ts.isArrayBindingPattern(node.name) ||
      node.name.elements.length !== 2
    )
      return;
    const [value, setter] = node.name.elements;
    if (
      value &&
      setter &&
      ts.isBindingElement(value) &&
      ts.isBindingElement(setter) &&
      ts.isIdentifier(value.name) &&
      ts.isIdentifier(setter.name)
    ) {
      states.push({
        value: symbol(value.name)!,
        setter: symbol(setter.name)!,
        name: value.name.text,
      });
    }
  });

  walk(file, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    )
      mutated.add(symbol(node.left)!);
  });

  function inspectFrame(fn: Callback, visited: Set<Callback>, depth: number): void {
    if (
      !fn.body ||
      visited.has(fn) ||
      depth > 8 ||
      fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )
      return;
    visited.add(fn);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const state = ts.isIdentifier(callee)
          ? states.find(
              (candidate) => candidate.setter === symbol(callee) && !mutated.has(candidate.setter),
            )
          : undefined;
        if (state)
          add(
            "animation-frame-state",
            node,
            state.name,
            `Animation-frame callback directly publishes React state through ${callee.getText(file)}.`,
            "Use renderer refs/frame callbacks or publish React UI state at a bounded cadence; explicitly suppress this finding when React-rendered UI must update every frame.",
          );
        const local = callback(callee);
        if (local) inspectFrame(local, visited, depth + 1);
      }
      node.forEachChild(visit);
    };
    visit(fn.body);
  }
  function isFrameCall(node: ts.CallExpression): boolean {
    const callee = unwrap(node.expression);
    if (ts.isIdentifier(callee) && callee.text === "requestAnimationFrame")
      return !symbol(callee)?.declarations?.length;
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "requestAnimationFrame" &&
      ts.isIdentifier(callee.expression) &&
      ["window", "globalThis"].includes(callee.expression.text) &&
      !symbol(callee.expression)?.declarations?.length
    );
  }
  function isReactValue(value: ts.Expression, effect: Callback): boolean {
    let root = value;
    if (ts.isPropertyAccessExpression(root)) {
      if (!ts.isIdentifier(root.expression) || root.name.text === "current") return false;
      root = root.expression;
    }
    if (!ts.isIdentifier(root)) return false;
    if (root === value && states.some((state) => state.value === symbol(root))) return true;
    let owner: ts.Node | undefined = effect.parent;
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
    if (!owner || !ts.isFunctionLike(owner)) return false;
    return owner.parameters.some((parameter) => {
      let matches = false;
      walk(parameter.name, (node) => {
        if (ts.isIdentifier(node) && symbol(node) === symbol(root)) matches = true;
      });
      return matches;
    });
  }
  function inspectEffect(node: ts.CallExpression): void {
    const fn = callback(node.arguments[0]);
    const dependencies = node.arguments[1];
    if (!fn?.body || !dependencies || !ts.isArrayLiteralExpression(dependencies)) return;
    const body = fn.body;
    const expression = ts.isBlock(body)
      ? body.statements.length === 1 && ts.isExpressionStatement(body.statements[0]!)
        ? body.statements[0]!.expression
        : undefined
      : body;
    if (
      !expression ||
      !ts.isCallExpression(expression) ||
      !ts.isIdentifier(expression.expression) ||
      expression.arguments.length !== 1
    )
      return;
    const state = states.find(
      (candidate) =>
        candidate.setter === symbol(expression.expression) && !mutated.has(candidate.setter),
    );
    const value = unwrap(expression.arguments[0]!);
    if (
      !state ||
      !isReactValue(value, fn) ||
      dependencies.elements.length !== 1 ||
      dependencies.elements[0]!.getText(file) !== value.getText(file)
    )
      return;
    add(
      "effect-mirrored-state",
      expression,
      state.name,
      `Effect only copies ${value.getText(file)} into local React state ${state.name}.`,
      "Derive the value during render or at the owning update boundary; reserve effects for synchronization with external systems.",
    );
  }
  function inspectProvider(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): void {
    const tag = node.tagName;
    const context =
      ts.isPropertyAccessExpression(tag) && tag.name.text === "Provider" ? tag.expression : tag;
    if (!ts.isIdentifier(context) || !contexts.has(symbol(context)!)) return;
    const attribute = node.attributes.properties.find(
      (property) => ts.isJsxAttribute(property) && property.name.getText(file) === "value",
    );
    if (
      !attribute ||
      !ts.isJsxAttribute(attribute) ||
      !attribute.initializer ||
      !ts.isJsxExpression(attribute.initializer) ||
      !attribute.initializer.expression
    )
      return;
    let value = unwrap(attribute.initializer.expression);
    if (ts.isIdentifier(value)) {
      const declaration = symbol(value)?.valueDeclaration;
      if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !declaration.initializer ||
        !ts.isVariableDeclarationList(declaration.parent) ||
        !(declaration.parent.flags & ts.NodeFlags.Const)
      )
        return;
      value = unwrap(declaration.initializer);
    }
    if (!ts.isObjectLiteralExpression(value) || value.properties.some(ts.isSpreadAssignment))
      return;
    const values = value.properties.flatMap((property) =>
      ts.isShorthandPropertyAssignment(property)
        ? [checker.getShorthandAssignmentValueSymbol(property)]
        : ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)
          ? [symbol(property.initializer)]
          : [],
    );
    for (const state of states) {
      const tokens = state.name.replace(/([a-z])([A-Z])/g, "$1_$2");
      if (
        !/(?:^|_)(?:hover|pointer|frame|tick)(?:_|$)/i.test(tokens) ||
        !values.includes(state.value) ||
        !values.includes(state.setter)
      )
        continue;
      const capability = value.properties.some((property) => {
        const name = property.name?.getText(file) ?? "";
        return /service|client|api|repository|commands|capabilities/i.test(name);
      });
      if (capability)
        add(
          "broad-context-update-risk",
          attribute,
          state.name,
          `Provider combines potentially frequent ${state.name} state and its setter with unrelated services or capabilities.`,
          "Review consumer update boundaries and split context by update frequency where appropriate; naming alone does not establish actual runtime frequency.",
        );
    }
  }

  walk(file, (node) => {
    if (ts.isCallExpression(node)) {
      if (isFrameCall(node)) {
        const fn = callback(node.arguments[0]);
        if (fn) inspectFrame(fn, new Set(), 0);
      }
      if (reactCall(node.expression, "useEffect") || reactCall(node.expression, "useLayoutEffect"))
        inspectEffect(node);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) inspectProvider(node);
  });
  // oxlint-disable-next-line unicorn/no-array-sort -- Repository compiler lib targets ES2022; result is locally owned.
  return result.sort(
    (left, right) =>
      left.startLine - right.startLine ||
      left.startColumn - right.startColumn ||
      left.kind.localeCompare(right.kind),
  );
}

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";

import { analyzeProvider } from "./analysis.ts";
import type { AnalysisAction, AnalysisFileReplacement } from "./analysis-model.ts";

export const analysisActionIdPattern = /^CTA-[A-F0-9]{12}$/;

export type AnalysisActionApplyResult = {
  result: "applied" | "no-op" | "conflict" | "failed";
  actionId: string;
  changed: string[];
  noOp: string[];
  rolledBack: string[];
  diagnostics: Array<{ code: string; message: string; path?: string }>;
};

export type AnalysisActionApplyOptions = {
  writeFile?: (path: string, content: string) => void;
};

type PreparedReplacement = {
  replacement: AnalysisFileReplacement;
  absolutePath: string;
  previousContent: string;
  outcome: "change" | "no-op";
};

class AnalysisActionConflict extends Error {
  constructor(
    readonly path: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export function sha256Text(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function analysisActionId(provider: string, actionKey: string, subjectKey: string): string {
  const digest = createHash("sha256")
    .update(`${provider}\0${actionKey}\0${subjectKey}`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `CTA-${digest}`;
}

function withinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function actionPath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, path);
  if (!withinRoot(absoluteRoot, absolute)) {
    throw new AnalysisActionConflict(path, `Analysis action path escapes repository root: ${path}`);
  }
  return absolute;
}

function assertNoSymlinkComponents(root: string, path: string, logicalPath: string): void {
  const absoluteRoot = resolve(root);
  const local = relative(absoluteRoot, path);
  let current = absoluteRoot;
  for (const segment of local.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new AnalysisActionConflict(
        logicalPath,
        `Analysis action path crosses a symbolic link: ${relative(absoluteRoot, current)}`,
      );
    }
  }
}

function prepareReplacement(root: string, replacement: AnalysisFileReplacement): PreparedReplacement {
  if (!/^[a-f0-9]{64}$/.test(replacement.beforeSha256)) {
    throw new AnalysisActionConflict(replacement.path, "Analysis action beforeSha256 is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(replacement.afterSha256)) {
    throw new AnalysisActionConflict(replacement.path, "Analysis action afterSha256 is invalid");
  }
  if (sha256Text(replacement.content) !== replacement.afterSha256) {
    throw new AnalysisActionConflict(
      replacement.path,
      "Analysis action replacement content does not match afterSha256",
    );
  }
  if (replacement.beforeSha256 === replacement.afterSha256) {
    throw new AnalysisActionConflict(
      replacement.path,
      "Analysis action replacement must change file content",
    );
  }

  const absolutePath = actionPath(root, replacement.path);
  assertNoSymlinkComponents(root, absolutePath, replacement.path);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new AnalysisActionConflict(
      replacement.path,
      `Analysis action target must be an existing file: ${replacement.path}`,
    );
  }

  const previousContent = readFileSync(absolutePath, "utf8");
  const currentDigest = sha256Text(previousContent);
  if (currentDigest === replacement.afterSha256) {
    return { replacement, absolutePath, previousContent, outcome: "no-op" };
  }
  if (currentDigest !== replacement.beforeSha256) {
    throw new AnalysisActionConflict(
      replacement.path,
      `Analysis action target changed since the action was produced: ${replacement.path}`,
    );
  }
  return { replacement, absolutePath, previousContent, outcome: "change" };
}

function conflictResult(action: AnalysisAction, error: AnalysisActionConflict): AnalysisActionApplyResult {
  return {
    result: "conflict",
    actionId: action.id,
    changed: [],
    noOp: [],
    rolledBack: [],
    diagnostics: [{ code: "analysis-action-conflict", message: error.message, path: error.path }],
  };
}

function failedResult(
  action: AnalysisAction,
  message: string,
  rolledBack: string[] = [],
): AnalysisActionApplyResult {
  return {
    result: "failed",
    actionId: action.id,
    changed: [],
    noOp: [],
    rolledBack,
    diagnostics: [{ code: "analysis-action-failed", message }],
  };
}

function postconditionSatisfied(root: string, action: AnalysisAction): boolean {
  const postcondition = action.postcondition;
  if (!postcondition) return true;
  const provider = analyzeProvider(root, postcondition.provider);
  if (!provider || provider.status !== "applied") return false;
  return !provider.diagnostics.some(
    (diagnostic) =>
      diagnostic.code === postcondition.code &&
      (!postcondition.path || diagnostic.location?.path === postcondition.path),
  );
}

export function applyAnalysisAction(
  root: string,
  action: AnalysisAction,
  options: AnalysisActionApplyOptions = {},
): AnalysisActionApplyResult {
  if (!analysisActionIdPattern.test(action.id)) {
    return failedResult(action, `Invalid analysis action ID: ${action.id}`);
  }
  if (action.kind !== "replace-files" || action.replacements.length === 0) {
    return failedResult(action, "Analysis action must contain at least one guarded file replacement");
  }
  const paths = action.replacements.map((replacement) => replacement.path);
  if (new Set(paths).size !== paths.length) {
    return failedResult(action, "Analysis action contains duplicate replacement paths");
  }

  let prepared: PreparedReplacement[];
  try {
    prepared = action.replacements.map((replacement) => prepareReplacement(root, replacement));
  } catch (error) {
    if (error instanceof AnalysisActionConflict) return conflictResult(action, error);
    return failedResult(action, error instanceof Error ? error.message : String(error));
  }

  const writes = prepared.filter((replacement) => replacement.outcome === "change");
  const noOp = prepared
    .filter((replacement) => replacement.outcome === "no-op")
    .map((replacement) => replacement.replacement.path);
  const writeFile = options.writeFile ?? ((path: string, content: string) => writeFileSync(path, content));
  const touched: PreparedReplacement[] = [];

  try {
    for (const replacement of writes) {
      assertNoSymlinkComponents(root, replacement.absolutePath, replacement.replacement.path);
      writeFile(replacement.absolutePath, replacement.replacement.content);
      touched.push(replacement);
    }
  } catch (error) {
    const rolledBack: string[] = [];
    for (const replacement of [...touched].reverse()) {
      try {
        writeFileSync(replacement.absolutePath, replacement.previousContent);
        rolledBack.push(replacement.replacement.path);
      } catch {
        // Continue restoring remaining files; the action remains failed.
      }
    }
    return failedResult(
      action,
      error instanceof Error ? error.message : String(error),
      rolledBack,
    );
  }

  if (!postconditionSatisfied(root, action)) {
    const rolledBack: string[] = [];
    for (const replacement of [...writes].reverse()) {
      try {
        writeFileSync(replacement.absolutePath, replacement.previousContent);
        rolledBack.push(replacement.replacement.path);
      } catch {
        // Continue restoring remaining files; the action remains failed.
      }
    }
    return failedResult(action, "Analysis action postcondition was not satisfied", rolledBack);
  }

  return {
    result: writes.length === 0 ? "no-op" : "applied",
    actionId: action.id,
    changed: writes.map((replacement) => replacement.replacement.path),
    noOp,
    rolledBack: [],
    diagnostics: [],
  };
}

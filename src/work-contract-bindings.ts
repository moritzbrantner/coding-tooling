import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import type { Diagnostic, ResultEnvelope } from "./model.ts";
import { parsePerformanceContract, performanceContractPath } from "./performance-contract.ts";
import { discoverPublicContract } from "./public-contract.ts";
import { rustPublicItemResolver } from "./rust-public-items.ts";
import { readJson, relativePosix, walkFiles } from "./shared.ts";

export const workContractBindingsSchemaVersion = "coding-tooling/work-contract-bindings/v1";

/** Comment marker binding the following declaration to a work-contract operation id. */
const markerToken = "@coding-tooling-work";
const kebab = /^[a-z0-9][a-z0-9-]*$/;
const sourceExtensions = new Set([
  ".rs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const httpMethods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
// Repository source only: walkFiles already skips node_modules, target, dist and similar output.
const maxSourceDepth = 12;

export type WorkBindingSource = "public-contract" | "openapi-operation-id" | "source-marker";

export type WorkBinding = {
  source: WorkBindingSource;
  /** Stable public-contract surface id, for surface-backed bindings. */
  surface?: string;
  /** Repository-relative declaration that provides the surface (e.g. an OpenAPI document). */
  declaration?: string;
  /**
   * Repository-relative POSIX path and 1-based line of a source marker; `line` also locates the
   * `pub` declaration of a Rust item-path `publicContract` (e.g. `crate::module::Type::method`).
   */
  path?: string;
  line?: number;
};

export type WorkBindingOperation = {
  id: string;
  publicContract: string | null;
  surface: string | null;
  state: "bound" | "unbound" | "stale" | "mismatched";
  bindings: WorkBinding[];
};

export type WorkContractBindingsData = {
  schemaVersion: typeof workContractBindingsSchemaVersion;
  root: string;
  contract: { path: string };
  operations: WorkBindingOperation[];
  limitations: string[];
};

type Marker = { id: string; path: string; line: number };
type OperationIdDeclaration = { operationId: string; surface: string; declaration: string };

class Unavailable extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const markerLine = new RegExp(
  String.raw`^\s*(?:\/\/\/?|\/\*\*?|\*)\s*${markerToken}(?=\s|\*\/|$)(.*)$`,
);

function isCommentOrAnnotation(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#[") ||
    (trimmed.startsWith("@") && !trimmed.startsWith(markerToken))
  );
}

/**
 * Conservatively recognize comment-start lines, ignoring text inside JS/TS template
 * literals, quoted strings and Rust raw strings. A marker is binding evidence only
 * when the language lexer is in a comment, not when a string depicts one.
 */
function commentMarkerLines(lines: string[], rust: boolean): boolean[] {
  let blockDepth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let rawEnd: string | null = null;
  return lines.map((line) => {
    const prefix = line.trimStart();
    const startsBlockLine = blockDepth > 0 && prefix.startsWith("*") && !prefix.startsWith("*/");
    const startsComment =
      blockDepth === 0 &&
      quote === null &&
      rawEnd === null &&
      (prefix.startsWith("//") || prefix.startsWith("/*"));
    const isComment = startsBlockLine || startsComment;

    for (let index = 0; index < line.length;) {
      if (rawEnd !== null) {
        const end = line.indexOf(rawEnd, index);
        if (end < 0) break;
        index = end + rawEnd.length;
        rawEnd = null;
        continue;
      }
      if (quote !== null) {
        if (line[index] === "\\") {
          index += 2;
          continue;
        }
        if (line[index] === quote) quote = null;
        index += 1;
        continue;
      }
      if (blockDepth > 0) {
        if (line.startsWith("/*", index)) {
          blockDepth += 1;
          index += 2;
        } else if (line.startsWith("*/", index)) {
          blockDepth -= 1;
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }
      if (line.startsWith("//", index)) break;
      if (line.startsWith("/*", index)) {
        blockDepth += 1;
        index += 2;
        continue;
      }
      if (rust) {
        const raw = /^(?:br|r)(#*)"/.exec(line.slice(index));
        if (raw && (index === 0 || !/[A-Za-z0-9_]/.test(line[index - 1]!))) {
          rawEnd = `"${raw[1]}`;
          index += raw[0].length;
          continue;
        }
        if (line[index] === "'") {
          const character = /^'(?:\\.|[^\\'])'/.exec(line.slice(index));
          index += character?.[0].length ?? 1;
          continue;
        }
      }
      const character = line[index];
      if (character === '"' || character === "'" || character === "`") quote = character;
      index += 1;
    }
    return isComment;
  });
}
/** Reads source markers; malformed and detached markers become diagnostics and bind nothing. */
function sourceMarkers(root: string, diagnostics: Diagnostic[]): Marker[] {
  const markers: Marker[] = [];
  const files = walkFiles(root, maxSourceDepth)
    .filter((file) => sourceExtensions.has(extname(file)))
    .map((file) => ({ file, path: relativePosix(root, file) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const { file, path } of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!content.includes(markerToken)) continue;
    const lines = content.split(/\r?\n/);
    const comments = commentMarkerLines(lines, extname(file) === ".rs");
    lines.forEach((text, index) => {
      if (!comments[index]) return;
      const match = markerLine.exec(text);
      if (!match) return;
      const line = index + 1;
      const location = `${path}:${line}`;
      const tokens = match[1]!
        .replace(/\*\/\s*$/, "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const malformed = (reason: string) =>
        diagnostics.push({
          code: "work-binding-malformed",
          message: `Work binding marker at ${location} ${reason}; it binds nothing.`,
          path,
        });
      if (tokens.length === 0) return malformed("names no operation id");
      if (tokens.length > 1)
        return malformed(
          `must carry only the operation id (found "${tokens.join(" ")}"); budgets stay in ${performanceContractPath}`,
        );
      if (!kebab.test(tokens[0]!)) return malformed(`names an invalid operation id "${tokens[0]}"`);
      // The marker must sit directly above code, allowing intervening comments or attributes.
      let next = index + 1;
      while (next < lines.length && isCommentOrAnnotation(lines[next]!)) next += 1;
      if (next >= lines.length || lines[next]!.trim() === "")
        return malformed("is not directly above a declaration");
      markers.push({ id: tokens[0]!, path, line });
    });
  }
  return markers;
}

function surfaceIdFor(method: string, path: string): string {
  return ["http-operation", method.toUpperCase(), path].map(encodeURIComponent).join(":");
}

/** OpenAPI operationIds, read from the same documents public-contract discovery uses. */
function openApiOperationIds(root: string): OperationIdDeclaration[] {
  const declarations: OperationIdDeclaration[] = [];
  const files = walkFiles(root, 5)
    .filter((file) => {
      const name = basename(file).toLowerCase();
      return (
        name.endsWith(".json") &&
        (name === "openapi.json" || name === "swagger.json" || name.startsWith("openapi."))
      );
    })
    .sort();
  for (const file of files) {
    const document = readJson<{ paths?: Record<string, Record<string, unknown>> }>(file);
    if (!document?.paths) continue;
    const declaration = relativePosix(root, file);
    for (const path of Object.keys(document.paths).sort()) {
      const operations = document.paths[path];
      if (!operations || typeof operations !== "object") continue;
      for (const method of Object.keys(operations).sort()) {
        if (!httpMethods.has(method.toLowerCase())) continue;
        const operation = operations[method] as { operationId?: unknown } | undefined;
        if (typeof operation?.operationId !== "string") continue;
        declarations.push({
          operationId: operation.operationId,
          surface: surfaceIdFor(method, path),
          declaration,
        });
      }
    }
  }
  return declarations;
}

function group<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    groups.set(id, [...(groups.get(id) ?? []), value]);
  }
  return groups;
}

/**
 * Static, read-only binding of public operations to work-contract operations (#301). Budgets stay
 * single-sourced in the performance contract; a binding is declaration provenance, never evidence
 * that the operation executed or met its contract.
 */
export function workContractBindings(root: string): ResultEnvelope<WorkContractBindingsData> {
  const started = Date.now();
  const resolvedRoot = resolve(root);
  const diagnostics: Diagnostic[] = [];
  const data: WorkContractBindingsData = {
    schemaVersion: workContractBindingsSchemaVersion,
    root: resolvedRoot,
    contract: { path: performanceContractPath },
    operations: [],
    limitations: [
      "Bindings are static declaration provenance; they do not show that an operation executed or satisfied its work contract. Executed evidence comes only from `performance work`, matched by work-contract operation id.",
      "Source markers are not checked against the route or handler they annotate; endpoint meaning is never inferred from source.",
    ],
  };
  let unavailable = false;
  try {
    const contractFile = resolve(resolvedRoot, performanceContractPath);
    if (!existsSync(contractFile))
      throw new Unavailable(`Missing ${performanceContractPath}.`, "performance-contract-missing");
    let contract;
    try {
      contract = parsePerformanceContract(JSON.parse(readFileSync(contractFile, "utf8")));
    } catch (error) {
      throw new Unavailable(
        `Invalid performance contract: ${error instanceof Error ? error.message : String(error)}`,
        "performance-contract-invalid",
      );
    }
    const declared = new Set(contract.operations.map((operation) => operation.id));
    const surfaces = new Map(
      discoverPublicContract(resolvedRoot).map((surface) => [surface.id, surface]),
    );
    const resolveRustItem = rustPublicItemResolver(resolvedRoot);

    const markers = sourceMarkers(resolvedRoot, diagnostics);
    for (const marker of markers.filter((value) => !declared.has(value.id)))
      diagnostics.push({
        code: "work-binding-unknown",
        message: `Work binding marker at ${marker.path}:${marker.line} names "${marker.id}", which ${performanceContractPath} does not declare.`,
        path: marker.path,
      });
    const markersById = group(
      markers.filter((value) => declared.has(value.id)),
      (value) => value.id,
    );
    const operationIds = group(
      openApiOperationIds(resolvedRoot).filter((value) => declared.has(value.operationId)),
      (value) => value.operationId,
    );

    for (const operation of contract.operations) {
      const bindings: WorkBinding[] = [];
      let state: WorkBindingOperation["state"] = "unbound";
      let surface: string | null = null;

      if (operation.publicContract !== null) {
        const discovered = surfaces.get(operation.publicContract);
        const rustItem = discovered ? null : resolveRustItem(operation.publicContract);
        surface = operation.publicContract;
        if (discovered) {
          bindings.push({
            source: "public-contract",
            surface: discovered.id,
            ...(discovered.declaration ? { declaration: discovered.declaration } : {}),
          });
        } else if (rustItem) {
          bindings.push({
            source: "public-contract",
            surface: operation.publicContract,
            declaration: rustItem.path,
            line: rustItem.line,
          });
        } else {
          state = "stale";
          diagnostics.push({
            code: "work-binding-stale",
            message: `Work operation "${operation.id}" declares publicContract ${operation.publicContract}, but no such public surface is discovered; update the contract or restore the surface.`,
            path: performanceContractPath,
          });
        }
      }

      const owned = operationIds.get(operation.id) ?? [];
      if (owned.length > 1)
        diagnostics.push({
          code: "work-binding-duplicate",
          message: `Work operation "${operation.id}" is bound by several OpenAPI operationIds: ${owned
            .map((value) => `${value.surface} (${value.declaration})`)
            .join(", ")}.`,
          path: owned[0]!.declaration,
        });
      for (const declaration of owned) {
        if (operation.publicContract !== null && declaration.surface !== operation.publicContract) {
          if (state !== "stale") state = "mismatched";
          diagnostics.push({
            code: "work-binding-mismatch",
            message: `Work operation "${operation.id}" declares publicContract ${operation.publicContract}, but OpenAPI operationId "${operation.id}" in ${declaration.declaration} is on ${declaration.surface}; the declared surface is kept.`,
            path: declaration.declaration,
          });
          continue;
        }
        if (operation.publicContract === null && owned.length === 1) surface = declaration.surface;
        bindings.push({
          source: "openapi-operation-id",
          surface: declaration.surface,
          declaration: declaration.declaration,
        });
      }

      const marked = markersById.get(operation.id) ?? [];
      if (marked.length > 1)
        diagnostics.push({
          code: "work-binding-duplicate",
          message: `Work operation "${operation.id}" is bound by several source markers: ${marked
            .map((value) => `${value.path}:${value.line}`)
            .join(", ")}.`,
          path: marked[0]!.path,
        });
      for (const marker of marked)
        bindings.push({ source: "source-marker", path: marker.path, line: marker.line });

      if (state === "unbound" && bindings.length > 0) state = "bound";
      data.operations.push({
        id: operation.id,
        publicContract: operation.publicContract,
        surface,
        state,
        bindings,
      });
    }
  } catch (error) {
    unavailable = true;
    diagnostics.push(
      error instanceof Unavailable
        ? { code: error.code, message: error.message, path: performanceContractPath }
        : {
            code: "work-contract-bindings-unavailable",
            message: error instanceof Error ? error.message : String(error),
          },
    );
  }
  return {
    schemaVersion: 1,
    operation: "work-contract-bindings",
    status: unavailable ? "unavailable" : diagnostics.length ? "failed" : "passed",
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

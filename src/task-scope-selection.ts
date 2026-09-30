import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { Glob } from "bun";

import type { Component, Diagnostic } from "./model.ts";
import {
  portableTaskPath,
  type TaskKnowledge,
  type TaskScope,
} from "./task-knowledge-declarations.ts";

export type TaskTarget = { path: string; directory: boolean };
export type TaskSelection = {
  targets: TaskTarget[];
  components: Component[];
  scopes: TaskScope[];
  conservative: boolean;
};

function ancestor(parent: string, child: string): boolean {
  return parent === "." || parent === child || child.startsWith(`${parent}/`);
}

export function containedTaskPath(root: string, path: string): boolean {
  if (!portableTaskPath(path)) return false;
  const absolute = resolve(root, path);
  const child = relative(resolve(root), absolute);
  if (isAbsolute(child) || child === ".." || child.startsWith("../") || child.startsWith("..\\"))
    return false;
  try {
    const resolved = relative(realpathSync(root), realpathSync(absolute));
    return (
      !isAbsolute(resolved) &&
      resolved !== ".." &&
      !resolved.startsWith("../") &&
      !resolved.startsWith("..\\")
    );
  } catch {
    return false;
  }
}

function matches(root: string, pattern: string, target: TaskTarget): boolean {
  if (new Glob(pattern).match(target.path)) return true;
  const literal = pattern.split(/[*?[{]/)[0]!.replace(/\/$/, "") || ".";
  if (target.directory && (ancestor(target.path, literal) || ancestor(literal, target.path)))
    return true;
  return (
    !/[*?[{]/.test(pattern) &&
    lstatSync(join(root, pattern), { throwIfNoEntry: false })?.isDirectory() === true &&
    ancestor(pattern, target.path)
  );
}

export function selectTaskScope(
  root: string,
  options: { targets?: string[]; components?: string[]; taskKind?: string },
  components: Component[],
  knowledge: TaskKnowledge | undefined,
  diagnostics: Diagnostic[],
): TaskSelection {
  const targets = new Map<string, TaskTarget>();
  let conservative = false;
  function gap(code: string, message: string): void {
    diagnostics.push({ code, message });
    conservative = true;
  }
  function target(path: string): void {
    if (!portableTaskPath(path) || /[*?[{]/.test(path)) {
      gap("task-target-selection-unsupported", `Target must be a literal repository path: ${path}`);
      return;
    }
    if (!containedTaskPath(root, path)) {
      gap("task-target-unresolved", `Target is missing or escapes the repository: ${path}`);
      return;
    }
    const normalized = relative(resolve(root), resolve(root, path)).replaceAll("\\", "/") || ".";
    const entry = lstatSync(join(root, normalized), { throwIfNoEntry: false });
    if (!entry || (!entry.isFile() && !entry.isDirectory())) {
      gap(
        "task-target-selection-unsupported",
        `Target is not a regular file or directory: ${path}`,
      );
      return;
    }
    targets.set(normalized, { path: normalized, directory: entry.isDirectory() });
  }
  for (const path of options.targets ?? []) target(path);
  const selected = new Set<Component>();
  for (const selector of options.components ?? []) {
    const byPath = components.filter((component) => component.path === selector);
    const found = byPath.length
      ? byPath
      : components.filter((component) => component.name === selector);
    if (!found.length || (!byPath.length && found.length > 1)) {
      gap("task-component-unresolved", `Component is missing or ambiguous: ${selector}`);
      continue;
    }
    for (const component of found) {
      selected.add(component);
      target(component.path);
    }
  }
  if (!targets.size)
    gap(
      "task-scope-unspecified",
      "No resolved target or component; retain repository-wide validation",
    );
  const scopes = (knowledge?.scopes ?? []).filter(
    (scope) =>
      (!options.taskKind ||
        !scope.taskKinds?.length ||
        scope.taskKinds.includes(options.taskKind)) &&
      [...targets.values()].some((item) =>
        scope.paths.some((pattern) => matches(root, pattern, item)),
      ),
  );
  for (const item of targets.values()) {
    if (!scopes.some((scope) => scope.paths.some((pattern) => matches(root, pattern, item))))
      gap("task-relationship-undeclared", `No declared knowledge relationship covers ${item.path}`);
    const containing = components.filter((component) => ancestor(component.path, item.path));
    const longest = Math.max(...containing.map((component) => component.path.length));
    for (const component of containing.filter((candidate) => candidate.path.length === longest))
      selected.add(component);
    if (item.directory)
      for (const component of components.filter((candidate) => ancestor(item.path, candidate.path)))
        selected.add(component);
  }
  for (const scope of scopes) {
    for (const selector of scope.components ?? []) {
      const found = components.filter(
        (component) => component.path === selector || component.name === selector,
      );
      if (!found.length)
        gap(
          "task-related-component-unresolved",
          `${scope.id} declares an unknown component: ${selector}`,
        );
      for (const component of found) selected.add(component);
    }
  }
  return {
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort fresh selection under ES2022.
    targets: [...targets.values()].sort((left, right) => left.path.localeCompare(right.path)),
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort fresh selection under ES2022.
    components: (conservative ? [...components] : [...selected]).sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.kind.localeCompare(right.kind) ||
        left.name.localeCompare(right.name),
    ),
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort fresh selection under ES2022.
    scopes: (conservative ? [...(knowledge?.scopes ?? [])] : scopes).sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    conservative,
  };
}

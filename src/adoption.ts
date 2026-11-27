import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { repositoryFoundationRecommendation } from "./bootstrap.ts";
import { prepareConventionAdoption } from "./convention-registry.ts";
import type { Diagnostic, ResultEnvelope, ResultStatus } from "./model.ts";
import { readJson, relativePosix, repositoryRoot, walkFiles } from "./shared.ts";

type AdoptionOptions = {
  root?: string;
  conventionsRoot?: string;
  registryPath?: string;
  group?: string;
  approval?: string;
};

type InstructionEdit = { path: string; beforeSha256: null; after: string };
type Group = {
  preview: { id: string } & Record<string, unknown>;
  apply: () => Record<string, unknown>;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeScope(root: string, directory: string): boolean {
  let current = directory;
  while (current !== root) {
    if (
      !lstatSync(current, { throwIfNoEntry: false })?.isDirectory() ||
      lstatSync(join(current, ".git"), { throwIfNoEntry: false })
    )
      return false;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return true;
}

function guidance(path: string): { content: string | null; unsafe: boolean } {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return { content: null, unsafe: false };
  if (!entry.isFile() || entry.nlink !== 1) return { content: null, unsafe: true };
  return { content: readFileSync(path, "utf8"), unsafe: false };
}

function packageManifest(path: string): boolean {
  if (basename(path) === "Cargo.toml") {
    return /^\s*\[package\]\s*(?:#.*)?$/m.test(readFileSync(path, "utf8"));
  }
  const manifest = readJson<unknown>(path);
  return typeof manifest === "object" && manifest !== null && !Array.isArray(manifest);
}

function inspectInstructions(root: string) {
  const files = walkFiles(root, 4);
  const scopes = new Map<string, string[]>();
  scopes.set(root, []);
  const review: Diagnostic[] = [];
  let unsafeManifest = false;
  for (const file of files.sort()) {
    if (relativePosix(root, file).startsWith(".conventions/")) continue;
    const name = basename(file);
    const manifest = name === "package.json" || name === "Cargo.toml";
    if (!manifest && name !== "AGENTS.md" && name !== "CLAUDE.md") continue;
    const directory = dirname(file);
    if (
      !safeScope(root, directory) ||
      (manifest && !lstatSync(file, { throwIfNoEntry: false })?.isFile())
    ) {
      unsafeManifest ||= manifest;
      review.push({
        code: "adoption-unsafe-scope",
        path: relativePosix(root, file),
        message: "Nested checkout or unsafe manifest; excluded from adoption",
      });
      continue;
    }
    const manifests = scopes.get(directory) ?? [];
    if (manifest && packageManifest(file)) manifests.push(name);
    scopes.set(directory, manifests);
  }

  const edits: InstructionEdit[] = [];
  const evidence = [...scopes.entries()].map(([directory, manifests]) => {
    const scope = relativePosix(root, directory);
    const agents = guidance(join(directory, "AGENTS.md"));
    const claude = guidance(join(directory, "CLAUDE.md"));
    const path = (name: string) => relativePosix(root, join(directory, name));
    if (agents.unsafe || claude.unsafe) {
      review.push({
        code: "adoption-unsafe-instructions",
        path: scope,
        message: "Non-regular or shared instruction file; no edits proposed in this scope",
      });
    } else if (claude.content !== null && claude.content !== "@AGENTS.md\n") {
      review.push({
        code: "adoption-claude-review",
        path: path("CLAUDE.md"),
        message: "Existing Claude guidance requires review; it will not be overwritten",
      });
    } else {
      if (agents.content === null && manifests.length > 0) {
        const links = manifests.map((name) => `- [\`${name}\`](${name})`).join("\n");
        edits.push({
          path: path("AGENTS.md"),
          beforeSha256: null,
          after: `# Agent guidance\n\nLocal package manifests:\n\n${links}\n`,
        });
      } else if (agents.content === null) {
        review.push({
          code: "adoption-agents-review",
          path: path("AGENTS.md"),
          message: "No local package manifest supplies guidance; author this scope explicitly",
        });
      }
      if (claude.content === null && (agents.content !== null || manifests.length > 0)) {
        edits.push({ path: path("CLAUDE.md"), beforeSha256: null, after: "@AGENTS.md\n" });
      }
    }
    return {
      scope,
      manifests: manifests.map((name) => ({
        path: path(name),
        sha256: digest(readFileSync(join(directory, name), "utf8")),
      })),
      agentsSha256: agents.content === null ? null : digest(agents.content),
      claudeSha256: claude.content === null ? null : digest(claude.content),
    };
  });

  const group: Group = {
    preview: { id: "instructions", evidence, edits },
    apply: () => {
      for (const edit of edits) {
        const path = join(root, edit.path);
        if (!safeScope(root, dirname(path)) || lstatSync(path, { throwIfNoEntry: false })) {
          throw new Error(`Instruction destination changed: ${edit.path}`);
        }
      }
      for (const edit of edits) {
        writeFileSync(join(root, edit.path), edit.after, { encoding: "utf8", flag: "wx" });
      }
      return { created: edits.map((edit) => edit.path) };
    },
  };
  return { evidence, review, unsafeManifest, group: edits.length > 0 ? group : undefined };
}

export function adoptionCommand(
  action: "plan" | "apply",
  options: AdoptionOptions = {},
): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const root = resolve(options.root ?? repositoryRoot());
  function result(
    status: ResultStatus,
    data: Record<string, unknown>,
    diagnostics: Diagnostic[] = [],
  ): ResultEnvelope<Record<string, unknown>> {
    return {
      schemaVersion: 1,
      operation: "adoption",
      status,
      durationMs: Date.now() - started,
      data: { root, ...data },
      diagnostics,
    };
  }
  try {
    if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) {
      throw new Error("Select a real repository directory, not a symlink");
    }
    const instructions = inspectInstructions(root);
    const groups: Group[] = instructions.group ? [instructions.group] : [];
    let conventions: Record<string, unknown>;
    try {
      if (instructions.unsafeManifest) {
        throw new Error("Unsafe package boundary prevents convention recommendations");
      }
      const recommendation = repositoryFoundationRecommendation(root);
      const detected = new Set(recommendation.technologies);
      const technology = recommendation.modules.filter((module) => detected.has(module));
      const discretionary = recommendation.modules.filter((module) => !detected.has(module));
      const registry = prepareConventionAdoption(
        [
          { id: "technology-conventions", modules: technology },
          { id: "review-conventions", modules: discretionary },
        ],
        { root, conventionsRoot: options.conventionsRoot, registryPath: options.registryPath },
      );
      conventions = {
        status: "available",
        technologies: recommendation.technologies,
        selectedModules: registry.selected,
        installedModules: registry.installed,
        resolvedModules: registry.resolved,
        technologyCandidates: technology,
        reviewCandidates: discretionary,
      };
      groups.push(...registry.groups);
    } catch (error) {
      conventions = {
        status: "blocked",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const plans = groups.map(({ preview }) => ({
      ...preview,
      approval: digest(JSON.stringify({ root, preview })),
    }));
    const data = { conventions, scopes: instructions.evidence, groups: plans };
    if (action === "plan") return result("passed", data, instructions.review);
    const index = plans.findIndex((plan) => plan.id === options.group);
    const plan = plans[index];
    const group = groups[index];
    if (!plan || !group || plan.approval !== options.approval) {
      return result("failed", data, [
        {
          code: "adoption-approval-stale",
          message: "Select a current migration group and its exact approval hash from adoption plan",
        },
      ]);
    }
    const applied = group.apply();
    return result("passed", { group: plan.id, applied, validation: "not-run" }, instructions.review);
  } catch (error) {
    return result("error", {}, [
      {
        code: "adoption-error",
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DetectorContext } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { relativePosix, walkFiles } from "./shared.ts";

type CargoTargetKind = "lib" | "bin" | "test" | "example" | "bench";

export type ExplicitCargoTarget = {
  manifestPath: string;
  kind: CargoTargetKind;
  name?: string;
  declaredPath: string;
  resolvedPath: string;
};

type MutableTarget = {
  kind: CargoTargetKind;
  name?: string;
  declaredPath?: string;
};

const targetTablePattern = /^\s*\[lib\]\s*(?:#.*)?$/;
const targetArrayPattern = /^\s*\[\[(bin|test|example|bench)\]\]\s*(?:#.*)?$/;
const anyTablePattern = /^\s*\[.*\]\s*(?:#.*)?$/;
const stringAssignmentPattern = /^\s*(name|path)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/;

function parseTomlString(value: string): string | undefined {
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return undefined;
}

function cargoManifestPaths(root: string): string[] {
  return walkFiles(root, 8)
    .filter((path) => path.endsWith("Cargo.toml"))
    .sort();
}

function parseExplicitTargets(root: string, manifestPath: string): ExplicitCargoTarget[] {
  let content: string;
  try {
    content = readFileSync(manifestPath, "utf8");
  } catch {
    return [];
  }

  const targets: MutableTarget[] = [];
  let current: MutableTarget | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (targetTablePattern.test(line)) {
      current = { kind: "lib" };
      targets.push(current);
      continue;
    }
    const arrayTarget = targetArrayPattern.exec(line);
    if (arrayTarget?.[1]) {
      current = { kind: arrayTarget[1] as CargoTargetKind };
      targets.push(current);
      continue;
    }
    if (anyTablePattern.test(line)) {
      current = undefined;
      continue;
    }
    if (!current) continue;

    const assignment = stringAssignmentPattern.exec(line);
    if (!assignment?.[1] || !assignment[2]) continue;
    const value = parseTomlString(assignment[2]);
    if (value === undefined) continue;
    if (assignment[1] === "name") current.name = value;
    else current.declaredPath = value;
  }

  const directory = dirname(manifestPath);
  const relativeManifest = relativePosix(root, manifestPath);
  return targets.flatMap((target) => {
    if (!target.declaredPath) return [];
    const resolvedPath = join(directory, target.declaredPath);
    return [
      {
        manifestPath: relativeManifest,
        kind: target.kind,
        name: target.name,
        declaredPath: target.declaredPath,
        resolvedPath: relativePosix(root, resolvedPath),
      },
    ];
  });
}

export function explicitCargoTargets(root: string): ExplicitCargoTarget[] {
  return cargoManifestPaths(root)
    .flatMap((manifestPath) => parseExplicitTargets(root, manifestPath))
    .sort(
      (left, right) =>
        left.manifestPath.localeCompare(right.manifestPath) ||
        left.kind.localeCompare(right.kind) ||
        (left.name ?? "").localeCompare(right.name ?? "") ||
        left.declaredPath.localeCompare(right.declaredPath),
    );
}

function targetLabel(target: ExplicitCargoTarget): string {
  return target.name ? `${target.kind} target ${target.name}` : `${target.kind} target`;
}

export function missingCargoTargetPathFindings({ root }: DetectorContext): RawFinding[] {
  return explicitCargoTargets(root).flatMap((target) => {
    if (existsSync(join(root, target.resolvedPath))) return [];
    const label = targetLabel(target);
    const subjectKey = `${target.manifestPath}#${target.kind}:${target.name ?? target.declaredPath}`;
    return [
      {
        subject: {
          kind: "file" as const,
          key: subjectKey,
          path: target.manifestPath,
          description: `Cargo ${label} declared in ${target.manifestPath}`,
        },
        requirement: {
          kind: "file" as const,
          key: target.resolvedPath,
          description: `declared Cargo target path ${target.declaredPath} exists`,
          expectedArtifact: target.resolvedPath,
        },
        message: `${target.manifestPath} declares ${label} at missing path ${target.declaredPath}`,
        evidence: [
          {
            kind: "manifest" as const,
            path: target.manifestPath,
            detail: `${label} explicitly declares path = ${JSON.stringify(target.declaredPath)}`,
          },
        ],
        relatedFiles: [target.manifestPath, target.resolvedPath],
        verification: [],
      },
    ];
  });
}

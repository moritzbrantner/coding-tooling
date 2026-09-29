import { readFileSync } from "node:fs";

import type { RawFinding } from "./expectation-detector-types.ts";
import type { DetectorContext } from "./expectation-package-context.ts";
import {
  analyzeReactUpdateBoundaries,
  type ReactUpdateBoundaryFinding,
  type ReactUpdateBoundaryKind,
} from "./react-update-boundaries.ts";
import { relativePosix } from "./shared.ts";

const sourceFindings = new WeakMap<DetectorContext, ReactUpdateBoundaryFinding[]>();

export function reactUpdateBoundaryFindings(
  context: DetectorContext,
  kind: ReactUpdateBoundaryKind,
): RawFinding[] {
  let findings = sourceFindings.get(context);
  if (!findings) {
    findings = context.packages.flatMap((packageInfo) =>
      [...packageInfo.sourceFiles, ...packageInfo.javaScriptSourceFiles]
        // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh array with the repository ES2022 compiler lib.
        .sort()
        .flatMap((source) => {
          const path = relativePosix(context.root, source);
          return analyzeReactUpdateBoundaries(path, readFileSync(source, "utf8"));
        }),
    );
    sourceFindings.set(context, findings);
  }
  return findings
    .filter((finding) => finding.kind === kind)
    .map((finding) => {
      const path = finding.path;
      return {
        subject: {
          kind: "file" as const,
          key: `${path}:${finding.startLine}:${finding.startColumn}:${finding.subject}`,
          path,
          description: `${finding.subject} at ${path}:${finding.startLine}:${finding.startColumn}`,
        },
        requirement: { kind: "signal" as const, key: kind, description: finding.recommendation },
        message: finding.message,
        evidence: [
          {
            kind: "file" as const,
            path,
            detail: `${finding.startLine}:${finding.startColumn}: ${finding.message}`,
          },
        ],
        analysisEvidence: [
          {
            provider: "react-update-boundaries",
            code: finding.conventionId,
            message: finding.message,
            location: {
              path,
              startLine: finding.startLine,
              startColumn: finding.startColumn,
              endLine: finding.endLine,
              endColumn: finding.endColumn,
            },
          },
        ],
        relatedFiles: [path],
        verification: [],
      };
    });
}

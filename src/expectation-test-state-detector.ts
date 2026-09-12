import { readFileSync } from "node:fs";

import type { DetectorContext } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { relativePosix } from "./shared.ts";

type TestState = "focused" | "disabled";

type Match = {
  state: TestState;
  api: string;
  line: number;
};

const focusedPattern = /^\s*(test|it|describe)\.only\s*\(/;
const disabledPattern = /^\s*(test|it|describe)\.(skip|todo)\s*\(/;

function matches(content: string): Match[] {
  const result: Match[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const focused = focusedPattern.exec(line);
    if (focused) {
      result.push({ state: "focused", api: `${focused[1]}.only`, line: index + 1 });
      continue;
    }
    const disabled = disabledPattern.exec(line);
    if (disabled) {
      result.push({ state: "disabled", api: `${disabled[1]}.${disabled[2]}`, line: index + 1 });
    }
  }
  return result;
}

function findings(context: DetectorContext, state: TestState): RawFinding[] {
  const result: RawFinding[] = [];
  for (const packageInfo of context.packages) {
    for (const testFile of packageInfo.testFiles) {
      let content: string;
      try {
        content = readFileSync(testFile, "utf8");
      } catch {
        continue;
      }
      const path = relativePosix(context.root, testFile);
      for (const match of matches(content).filter((item) => item.state === state)) {
        const focused = state === "focused";
        result.push({
          subject: {
            kind: "file",
            key: `${path}:${match.line}:${match.api}`,
            path,
            description: `${focused ? "focused" : "disabled"} test case ${match.api} at ${path}:${match.line}`,
          },
          requirement: {
            kind: "test",
            key: focused ? "no-focused-test-case" : "disabled-test-case-reviewed",
            description: focused
              ? "committed test suites do not contain focused-only cases"
              : "skipped and TODO test cases remain visible as explicit test debt",
          },
          message: focused
            ? `${path}:${match.line} uses ${match.api}, which can exclude the rest of the suite`
            : `${path}:${match.line} uses ${match.api} and is not an executed behavioral case`,
          evidence: [
            {
              kind: "file",
              path,
              detail: `${match.api} is present on line ${match.line}`,
            },
          ],
          relatedFiles: [path],
          verification: [],
        });
      }
    }
  }
  return result;
}

export function focusedTestCaseFindings(context: DetectorContext): RawFinding[] {
  return findings(context, "focused");
}

export function disabledTestCaseFindings(context: DetectorContext): RawFinding[] {
  return findings(context, "disabled");
}

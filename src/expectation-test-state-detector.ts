import { readFileSync } from "node:fs";

import type { DetectorContext } from "./expectation-package-context.ts";
import type { RawFinding } from "./expectation-detector-types.ts";
import { relativePosix } from "./shared.ts";

type TestState = "focused" | "disabled";
type ScanState = "code" | "line-comment" | "block-comment" | "single" | "double" | "template";

type Match = {
  state: TestState;
  api: string;
  line: number;
};

const focusedPattern = /^\s*(test|it|describe)\.only\s*\(/;
const skippedPattern = /^\s*(test|it|describe)\.skip\s*\(/;
const todoPattern = /^\s*(test|it)\.todo\s*\(/;

function maskCommentsAndStrings(content: string): string {
  let state: ScanState = "code";
  let escaped = false;
  let result = "";

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    const next = content[index + 1];

    if (state === "line-comment") {
      if (character === "\n") {
        state = "code";
        result += character;
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        state = "code";
        index += 1;
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state !== "code") {
      if (character === "\n") {
        result += "\n";
        escaped = false;
        continue;
      }
      result += " ";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (
        (state === "single" && character === "'") ||
        (state === "double" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      result += "  ";
      state = "line-comment";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      result += "  ";
      state = "block-comment";
      index += 1;
      continue;
    }
    if (character === "'") {
      result += " ";
      state = "single";
      continue;
    }
    if (character === '"') {
      result += " ";
      state = "double";
      continue;
    }
    if (character === "`") {
      result += " ";
      state = "template";
      continue;
    }

    result += character;
  }

  return result;
}

function matches(content: string): Match[] {
  const result: Match[] = [];
  const masked = maskCommentsAndStrings(content);
  for (const [index, line] of masked.split(/\r?\n/).entries()) {
    const focused = focusedPattern.exec(line);
    if (focused) {
      result.push({ state: "focused", api: `${focused[1]}.only`, line: index + 1 });
      continue;
    }
    const skipped = skippedPattern.exec(line);
    if (skipped) {
      result.push({ state: "disabled", api: `${skipped[1]}.skip`, line: index + 1 });
      continue;
    }
    const todo = todoPattern.exec(line);
    if (todo) result.push({ state: "disabled", api: `${todo[1]}.todo`, line: index + 1 });
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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analysisActionId, applyAnalysisAction, sha256Text } from "../src/analysis-actions.ts";
import type { AnalysisAction } from "../src/analysis-model.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-analysis-actions-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function action(
  provider: string,
  actionKey: string,
  replacements: Array<{ path: string; before: string; after: string }>,
): AnalysisAction {
  return {
    id: analysisActionId(provider, actionKey, replacements.map((item) => item.path).join("|")),
    provider,
    title: actionKey,
    kind: "replace-files",
    replacements: replacements.map((replacement) => ({
      path: replacement.path,
      beforeSha256: sha256Text(replacement.before),
      afterSha256: sha256Text(replacement.after),
      content: replacement.after,
    })),
  };
}

describe("deterministic analysis actions", () => {
  test("applies a guarded replacement and becomes an idempotent no-op", () => {
    const before = "export const value: string = 123;\n";
    const after = 'export const value: string = "ok";\n';
    const root = fixture({
      "src/value.ts": before,
      "tsconfig.json": `${JSON.stringify(
        {
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    });
    const candidate = action("typescript-compiler", "fix-ts2322", [
      { path: "src/value.ts", before, after },
    ]);
    candidate.postcondition = {
      kind: "diagnostic-absent",
      provider: "typescript-compiler",
      code: "TS2322",
      path: "src/value.ts",
    };

    const first = applyAnalysisAction(root, candidate);
    const second = applyAnalysisAction(root, candidate);

    expect(first).toMatchObject({ result: "applied", changed: ["src/value.ts"], noOp: [] });
    expect(second).toMatchObject({ result: "no-op", changed: [], noOp: ["src/value.ts"] });
    expect(readFileSync(join(root, "src", "value.ts"), "utf8")).toBe(after);
  });

  test("conflicts instead of overwriting source that changed after action creation", () => {
    const before = "export const value = 1;\n";
    const after = "export const value = 2;\n";
    const root = fixture({ "src/value.ts": "export const value = 3;\n" });
    const candidate = action("test-provider", "replace-value", [
      { path: "src/value.ts", before, after },
    ]);

    const result = applyAnalysisAction(root, candidate);

    expect(result.result).toBe("conflict");
    expect(result.diagnostics[0]?.code).toBe("analysis-action-conflict");
    expect(readFileSync(join(root, "src", "value.ts"), "utf8")).toBe("export const value = 3;\n");
  });

  test("rolls back earlier writes when a later replacement fails", () => {
    const firstBefore = "first-before\n";
    const firstAfter = "first-after\n";
    const secondBefore = "second-before\n";
    const secondAfter = "second-after\n";
    const root = fixture({
      "src/first.ts": firstBefore,
      "src/second.ts": secondBefore,
    });
    const candidate = action("test-provider", "replace-two", [
      { path: "src/first.ts", before: firstBefore, after: firstAfter },
      { path: "src/second.ts", before: secondBefore, after: secondAfter },
    ]);
    let writes = 0;

    const result = applyAnalysisAction(root, candidate, {
      writeFile(path, content) {
        writes += 1;
        if (writes === 2) throw new Error("injected write failure");
        writeFileSync(path, content);
      },
    });

    expect(result).toMatchObject({ result: "failed", rolledBack: ["src/first.ts"] });
    expect(readFileSync(join(root, "src", "first.ts"), "utf8")).toBe(firstBefore);
    expect(readFileSync(join(root, "src", "second.ts"), "utf8")).toBe(secondBefore);
  });

  test("rolls back when the declared provider diagnostic remains", () => {
    const before = "export const value: string = 123;\n";
    const stillBroken = "export const value: string = 456;\n";
    const root = fixture({
      "src/value.ts": before,
      "tsconfig.json": `${JSON.stringify(
        {
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    });
    const candidate = action("typescript-compiler", "bad-fix-ts2322", [
      { path: "src/value.ts", before, after: stillBroken },
    ]);
    candidate.postcondition = {
      kind: "diagnostic-absent",
      provider: "typescript-compiler",
      code: "TS2322",
      path: "src/value.ts",
    };

    const result = applyAnalysisAction(root, candidate);

    expect(result).toMatchObject({ result: "failed", rolledBack: ["src/value.ts"] });
    expect(readFileSync(join(root, "src", "value.ts"), "utf8")).toBe(before);
  });

  test("rejects replacement content that does not match its declared digest", () => {
    const before = "before\n";
    const root = fixture({ "src/value.ts": before });
    const candidate = action("test-provider", "invalid-digest", [
      { path: "src/value.ts", before, after: "after\n" },
    ]);
    candidate.replacements[0]!.content = "different\n";

    const result = applyAnalysisAction(root, candidate);

    expect(result.result).toBe("conflict");
    expect(readFileSync(join(root, "src", "value.ts"), "utf8")).toBe(before);
  });
});

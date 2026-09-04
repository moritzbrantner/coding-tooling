import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const actionPath = join(import.meta.dir, "..", "action.yml");

function actionSource(): string {
  return readFileSync(actionPath, "utf8");
}

describe("composite action contract", () => {
  test("exposes read-only environment fingerprint capture", () => {
    const source = actionSource();

    expect(source).toContain("environment-fingerprint");
    expect(source).toContain('"$INPUT_OPERATION" == "environment-fingerprint"');
    expect(source).toContain("environment fingerprint");
    expect(source).toContain(
      '--profile "$INPUT_ENVIRONMENT_PROFILE" --json > "$INPUT_REPORT_PATH"',
    );
    expect(source).toContain('echo "report-path=$INPUT_REPORT_PATH" >> "$GITHUB_OUTPUT"');
  });

  test("keeps environment capture dependency installation disabled", () => {
    const source = actionSource();
    const fingerprintInstallCondition = "inputs.operation == 'environment-fingerprint'";

    expect(source).toContain("if: inputs.operation == 'run'");
    expect(source).not.toContain(fingerprintInstallCondition);
  });

  test("exposes read-only foundation audit capture", () => {
    const source = actionSource();

    expect(source).toContain("foundation auditing");
    expect(source).toContain('"$INPUT_OPERATION" == "foundation"');
    expect(source).toContain('foundation audit --root . --json > "$INPUT_REPORT_PATH"');
    expect(source).toContain('echo "report-path=$INPUT_REPORT_PATH" >> "$GITHUB_OUTPUT"');
  });

  test("keeps foundation audit dependency installation disabled", () => {
    const source = actionSource();
    const foundationInstallCondition = "inputs.operation == 'foundation'";

    expect(source).toContain("if: inputs.operation == 'run'");
    expect(source).not.toContain(foundationInstallCondition);
  });
});

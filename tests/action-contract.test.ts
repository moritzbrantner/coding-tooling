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

    expect(source).toContain("inputs.operation == 'run'");
    expect(source).not.toContain(fingerprintInstallCondition);
  });

  test("prepares a declared environment-v1 before run validation", () => {
    const source = actionSource();

    expect(source).toContain("Detect consumer environment-v1");
    expect(source).toContain('"$INPUT_OPERATION" == "run"');
    expect(source).toContain(".repository-environment.toml");
    expect(source).toContain("scripts/codex-environment.sh");
    expect(source).toContain("Set up consumer Node");
    expect(source).toContain("node-version-file: .node-version");
    expect(source).toContain("bash scripts/codex-environment.sh setup");
    expect(source).toContain("Verify environment-v1 preserves tracked state");
  });

  test("does not duplicate dependency installation after environment-v1 setup", () => {
    const source = actionSource();

    expect(source).toContain(
      "inputs.operation == 'run' && steps.consumer-environment.outputs.detected != 'true'",
    );
  });

  test("derives fallback run dependency preparation from the selected validation scope", () => {
    const source = actionSource();

    expect(source).toContain('if [[ "$INPUT_OPERATION" == "run" ]]');
    expect(source).toContain(
      'args=(install prepare --tier "$INPUT_TIER" --config "$INPUT_CONFIG" --json)',
    );
    expect(source).toContain('args+=(--component "$INPUT_COMPONENT")');
    expect(source).toContain('bun "${{ github.action_path }}/src/cli.ts" "${args[@]}"');
  });

  test("exposes resolver-backed dependency evidence without pre-installing the repository graph", () => {
    const source = actionSource();

    expect(source).toContain("dependency-resolution");
    expect(source).toContain('"$INPUT_OPERATION" == "dependency-resolution"');
    expect(source).toContain("dependency_args=(dependencies resolve --json)");
    expect(source).toContain("dependency_args+=(--strict)");
    expect(source).not.toContain("inputs.operation == 'dependency-resolution'");
  });

  test("exposes read-only remediation planning", () => {
    const source = actionSource();

    expect(source).toContain("remediation planning");
    expect(source).toContain('"$INPUT_OPERATION" == "remediation-plan"');
    expect(source).toContain('remediation plan --json > "$INPUT_REPORT_PATH"');
    expect(source).toContain('echo "report-path=$INPUT_REPORT_PATH" >> "$GITHUB_OUTPUT"');
  });

  test("keeps remediation planning dependency installation disabled", () => {
    const source = actionSource();
    const remediationInstallCondition = "inputs.operation == 'remediation-plan'";

    expect(source).toContain("inputs.operation == 'run'");
    expect(source).not.toContain(remediationInstallCondition);
  });

  test("exposes compact agent summary without pre-installing consumer dependencies", () => {
    const source = actionSource();
    const agentSummaryInstallCondition = "inputs.operation == 'agent-summary'";

    expect(source).toContain("compact agent evidence summaries");
    expect(source).toContain('"$INPUT_OPERATION" == "agent-summary"');
    expect(source).toContain('agent summary --json > "$INPUT_REPORT_PATH"');
    expect(source).toContain('echo "report-path=$INPUT_REPORT_PATH" >> "$GITHUB_OUTPUT"');
    expect(source).not.toContain(agentSummaryInstallCondition);
  });

  test("exposes read-only foundation audit capture", () => {
    const source = actionSource();

    expect(source).toContain("foundation auditing/planning");
    expect(source).toContain('"$INPUT_OPERATION" == "foundation"');
    expect(source).toContain('foundation audit --root . --json > "$INPUT_REPORT_PATH"');
    expect(source).toContain('echo "report-path=$INPUT_REPORT_PATH" >> "$GITHUB_OUTPUT"');
  });

  test("keeps foundation audit dependency installation disabled", () => {
    const source = actionSource();
    const foundationInstallCondition = "inputs.operation == 'foundation'";

    expect(source).toContain("inputs.operation == 'run'");
    expect(source).not.toContain(foundationInstallCondition);
  });

  test("exposes read-only bootstrap planning", () => {
    const source = actionSource();

    expect(source).toContain("bootstrap-plan");
    expect(source).toContain('"$INPUT_OPERATION" == "bootstrap-plan"');
    expect(source).toContain('bootstrap plan --root . --json > "$INPUT_REPORT_PATH"');
    expect(source).toContain('echo "report-path=$INPUT_REPORT_PATH" >> "$GITHUB_OUTPUT"');
  });

  test("keeps bootstrap planning dependency installation disabled", () => {
    const source = actionSource();
    const bootstrapPlanInstallCondition = "inputs.operation == 'bootstrap-plan'";

    expect(source).toContain("inputs.operation == 'run'");
    expect(source).not.toContain(bootstrapPlanInstallCondition);
  });
});

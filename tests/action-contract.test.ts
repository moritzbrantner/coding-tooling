import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const actionPath = join(import.meta.dir, "..", "action.yml");

function actionSource(): string {
  return readFileSync(actionPath, "utf8");
}

describe("composite action contract", () => {
  test("pushes the caller source revision into coding-tooling operations", () => {
    const source = actionSource();

    expect(source).toContain("source-sha:");
    expect(source).toContain("CODING_TOOLING_SOURCE_SHA:");
    expect(source).toContain("CODING_TOOLING_SOURCE_ROOT: ${{ github.workspace }}");
    expect(source).toContain("inputs.source-sha != '' && inputs.source-sha || github.sha");
  });

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

  test("reuses declared environment-v1 caches by semantic fingerprint", () => {
    const source = actionSource();

    expect(source).toContain("Resolve consumer environment-v1 cache");
    expect(source).toContain("environment fingerprint");
    expect(source).toContain('config.get("cache", {}).get("paths", [])');
    expect(source).toContain("Restore consumer environment-v1 cache");
    expect(source).toContain("actions/cache@caa296126883cff596d87d8935842f9db880ef25");
    expect(source).toContain("consumer-environment-cache.outputs.fingerprint");
    expect(source).not.toContain("restore-keys:");
  });

  test("uses the environment-v1 Bun pin before falling back to the action runtime", () => {
    const source = actionSource();

    expect(source).toContain('bun_version="${package_bun:-$version_file_bun}"');
    expect(source).toContain("CONSUMER_BUN_VERSION:");
    expect(source).toContain("consumer-environment.outputs.bun-version");
    expect(source).toContain('effective_version="$INPUT_BUN_VERSION"');
    expect(source).toContain('effective_version="$CONSUMER_BUN_VERSION"');
    expect(source).toContain('authority="environment-v1"');
    expect(source).toContain('bun-version: ${{ steps.tooling-bun.outputs.version }}');
  });

  test("skips setup-bun when the effective Bun is already installed", () => {
    const source = actionSource();

    expect(source).toContain("Detect coding-tooling Bun");
    expect(source).toContain('[[ "$(bun --version)" == "$effective_version" ]]');
    expect(source).toContain("if: steps.tooling-bun.outputs.ready != 'true'");
  });

  test("prepares environment-v1 without happy-path environment verification", () => {
    const source = actionSource();

    expect(source).toContain("Detect consumer environment-v1");
    expect(source).toContain('"$INPUT_OPERATION" == "run"');
    expect(source).toContain(".repository-environment.toml");
    expect(source).toContain("scripts/codex-environment.sh");
    expect(source).toContain("Set up consumer Node");
    expect(source).toContain("node-version-file: .node-version");
    expect(source).toContain("bash scripts/codex-environment.sh setup");
    expect(source).not.toContain("Verify environment-v1 preserves tracked state");
  });

  test("treats a missing optional validation report as incomplete score evidence", () => {
    const source = actionSource();

    expect(source).toContain('[[ -n "$INPUT_VALIDATION_REPORT"');
    expect(source).toContain('-f "$INPUT_VALIDATION_REPORT" ]]');
    expect(source).toContain("was not produced; scoring structural evidence");
  });

  test("verifies environment-v1 only after a run failure", () => {
    const source = actionSource();

    expect(source).toContain("Diagnose environment-v1 after run failure");
    expect(source).toContain(
      "failure() && inputs.operation == 'run' && steps.consumer-environment.outputs.detected == 'true'",
    );
    expect(source).toContain("environment verify");
    expect(source).toContain("environment-failure-diagnostic.json");
    expect(source).toContain("tracked_state=clean");
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

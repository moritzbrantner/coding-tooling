import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { repositoryEnvironmentConformance } from "../src/environment-conformance.ts";

function repository(packageManager?: string): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-environment-"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", ...(packageManager ? { packageManager } : {}) }, null, 2)}\n`,
  );
  return root;
}

function adoptEnvironment(root: string, extraConfig = ""): void {
  writeFileSync(
    join(root, ".repository-environment.toml"),
    `schema_version = 1

[policy]
track = "latest-stable"

[system]
apt = []

[compatibility_holds]
${extraConfig}`,
  );
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "codex-environment.sh"),
    '#!/usr/bin/env bash\nmode="${1:-setup}"\n[[ "$mode" == "setup" || "$mode" == "maintenance" ]]\n',
  );
}

describe("repository environment conformance", () => {
  test("reports exact observed Bun pins as passed", () => {
    const version = Bun.version;
    const root = repository(`bun@${version}`);
    adoptEnvironment(root);

    const result = repositoryEnvironmentConformance(root);

    expect(result.findings).toEqual([]);
    expect(result.data).toEqual(
      expect.objectContaining({
        adopted: true,
        toolchains: [
          expect.objectContaining({
            tool: "bun",
            declaredVersion: version,
            observedVersion: version,
            status: "passed",
          }),
        ],
      }),
    );
  });

  test("blocks floating Bun pins", () => {
    const root = repository("bun@latest");
    const result = repositoryEnvironmentConformance(root);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "environment-toolchain-pin-floating",
        status: "failed",
        severity: "error",
        path: "package.json",
      }),
    );
  });

  test("distinguishes an installed-version mismatch", () => {
    const root = repository("bun@0.0.1");
    adoptEnvironment(root);
    const result = repositoryEnvironmentConformance(root);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "environment-toolchain-mismatch",
        status: "failed",
        severity: "error",
      }),
    );
  });

  test("reports compatibility holds separately without making the repository fail", () => {
    const root = repository(`bun@${Bun.version}`);
    adoptEnvironment(
      root,
      `
[compatibility_holds.bun]
candidate = "9.9.9"
tested_revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
reason = "candidate failed the full gate"
`,
    );

    const result = repositoryEnvironmentConformance(root);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "environment-compatibility-hold",
        severity: "advisory",
      }),
    );
    expect(result.data.compatibilityHolds).toEqual([
      {
        tool: "bun",
        candidate: "9.9.9",
        testedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        reason: "candidate failed the full gate",
      },
    ]);
  });

  test("blocks partial or malformed environment-v1 adoption", () => {
    const root = repository();
    writeFileSync(
      join(root, ".repository-environment.toml"),
      'schema_version = 2\ntrack = "manual"\n',
    );

    const result = repositoryEnvironmentConformance(root);
    const codes = result.findings.map((finding) => finding.code);

    expect(codes).toContain("environment-script-missing");
    expect(codes).toContain("environment-config-invalid");
    expect(codes).toContain("environment-track-invalid");
  });
});

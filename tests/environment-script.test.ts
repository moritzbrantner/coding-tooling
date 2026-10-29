import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { repositoryEnvironmentConformance } from "../src/environment-conformance.ts";
import {
  canonicalEnvironmentScript,
  environmentScriptState,
  generateEnvironmentScript,
} from "../src/environment-script.ts";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-environment-script-"));
  writeFileSync(
    join(root, ".repository-environment.toml"),
    'schema_version = 1\n[policy]\ntrack = "latest-stable"\n',
  );
  return root;
}

describe("canonical environment script", () => {
  test("coding-tooling commits the canonical copy itself", () => {
    expect(environmentScriptState(resolve(import.meta.dir, ".."))).toBe("current");
  });

  test("generate writes an executable canonical copy and is a no-op when current", () => {
    const root = repository();
    const first = generateEnvironmentScript(root);
    expect(first.status).toBe("passed");
    expect(first.data).toMatchObject({ previous: "missing", state: "current", written: true });
    const path = join(root, "scripts", "codex-environment.sh");
    expect(readFileSync(path, "utf8")).toBe(canonicalEnvironmentScript());
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(generateEnvironmentScript(root).data).toMatchObject({ written: false });
  });

  test("check reports drift without writing and conformance flags it", () => {
    const root = repository();
    mkdirSync(join(root, "scripts"));
    const path = join(root, "scripts", "codex-environment.sh");
    writeFileSync(path, "#!/usr/bin/env bash\n# local variant\n");
    const check = generateEnvironmentScript(root, { check: true });
    expect(check.status).toBe("failed");
    expect(check.diagnostics.map((item) => item.code)).toEqual(["environment-script-drift"]);
    expect(readFileSync(path, "utf8")).toBe("#!/usr/bin/env bash\n# local variant\n");
    expect(
      repositoryEnvironmentConformance(root).findings.map((finding) => finding.code),
    ).toContain("environment-script-drift");

    generateEnvironmentScript(root);
    expect(generateEnvironmentScript(root, { check: true }).status).toBe("passed");
    expect(
      repositoryEnvironmentConformance(root).findings.map((finding) => finding.code),
    ).not.toContain("environment-script-drift");
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  inspectConsumerVerification,
  resolveDependencies,
} from "../src/dependency-resolution.ts";
import type { CommandResult } from "../src/shared.ts";

function fixture(options: {
  verifier?: string;
  lockfile?: boolean;
  peers?: Record<string, string>;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-dependency-resolution-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "@example/storytelling",
        version: "1.0.0",
        private: false,
        scripts: options.verifier ? { "test:consumer": "node scripts/verify-consumer.mjs" } : {},
        peerDependencies: options.peers ?? {
          react: "^19.0.0",
          "react-dom": "^19.0.0",
          "@react-three/fiber": "^9.4.0",
        },
        devDependencies: {
          react: "^19.2.6",
          "react-dom": "^19.2.6",
          "@react-three/fiber": "^9.6.1",
        },
      },
      null,
      2,
    ),
  );
  if (options.verifier) writeFileSync(join(root, "scripts", "verify-consumer.mjs"), options.verifier);
  if (options.lockfile) writeFileSync(join(root, "bun.lock"), "lockfileVersion = 1\n");
  return root;
}

function result(
  command: string,
  args: string[],
  status: number,
  stderr = "",
  stdout = "",
): CommandResult {
  return { command: [command, ...args], status, stdout, stderr };
}

function packOrInstall(
  install: (args: string[]) => CommandResult,
): (command: string, args?: string[], cwd?: string) => CommandResult {
  return (command, args = []) => {
    if (command === "npm" && args[0] === "pack") {
      return result(command, args, 0, "", '[{"filename":"example-storytelling-1.0.0.tgz"}]');
    }
    return install(args);
  };
}

describe("dependency resolution evidence", () => {
  test("detects the storytelling-style floating consumer verifier", () => {
    const root = fixture({
      verifier: `
        import { execFileSync } from "node:child_process";
        execFileSync("npm", ["install", "--ignore-scripts", "react@^19.0.0", "react-dom@^19.0.0", "@react-three/fiber@^9.4.0"]);
      `,
    });

    const findings = inspectConsumerVerification(root);
    expect(findings.map((finding) => finding.code)).toEqual([
      "consumer-verification-floats-dependencies",
    ]);
    expect(findings[0]?.message).toContain("react@^19.0.0");
  });

  test("accepts a verifier that derives exact peer versions instead of floating installs", () => {
    const root = fixture({
      verifier: `
        import { execFileSync } from "node:child_process";
        const exactPeer = (name, manifest) => name + "@" + manifest.peerDependencies[name].slice(1);
        execFileSync("npm", ["install", "--ignore-scripts", exactPeer("react", packageJson), exactPeer("react-dom", packageJson)]);
      `,
    });

    expect(inspectConsumerVerification(root)).toEqual([]);
  });

  test("rejects a direct full-consumer install that bypasses peer resolution", () => {
    const root = fixture();
    const packageJson = JSON.parse(Bun.file(join(root, "package.json")).text() as never);
    packageJson.scripts = { "test:consumer": "npm install --legacy-peer-deps ./package.tgz" };
    writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));

    expect(inspectConsumerVerification(root).map((finding) => finding.code)).toContain(
      "consumer-verification-bypasses-peer-resolution",
    );
  });

  test("classifies fresh registry drift when minimum peers resolve but floating ranges conflict", () => {
    const root = fixture({ lockfile: true });
    const runner = packOrInstall((args) => {
      const fresh = args.some((argument) => argument === "react@^19.0.0");
      if (!fresh) return result("npm", args, 0);
      return result(
        "npm",
        args,
        1,
        [
          "npm error code ERESOLVE",
          "npm error ERESOLVE unable to resolve dependency tree",
          "npm error Found: react@19.3.0",
          'npm error peer react@">=19 <19.3" from @react-three/fiber@9.7.0',
        ].join("\n"),
      );
    });

    const output = resolveDependencies(root, { runner, npmAvailable: true });
    const codes = (output.data.findings as Array<{ code: string }>).map((finding) => finding.code);
    expect(output.status).toBe("failed");
    expect(codes).toContain("fresh-peer-resolution-drift");
    expect(codes).toContain("locked-development-graph-masks-consumer-failure");
    const report = (output.data.packages as Array<{ minimum: { status: string }; fresh: { status: string } }>)[0]!;
    expect(report.minimum.status).toBe("passed");
    expect(report.fresh.status).toBe("failed");
  });

  test("classifies a peer contract that is already unsatisfiable at its minimum point", () => {
    const root = fixture();
    const runner = packOrInstall((args) =>
      result(
        "npm",
        args,
        1,
        "npm error ERESOLVE unable to resolve dependency tree\nnpm error Could not resolve dependency",
      ),
    );

    const output = resolveDependencies(root, { runner, npmAvailable: true });
    const codes = (output.data.findings as Array<{ code: string }>).map((finding) => finding.code);
    expect(codes).toContain("declared-peer-contract-unsatisfiable");
  });

  test("keeps registry outages unavailable instead of converting them into compatibility failures", () => {
    const root = fixture();
    const runner = packOrInstall((args) =>
      result("npm", args, 1, "npm error code EAI_AGAIN\nnpm error request to registry failed"),
    );

    const output = resolveDependencies(root, { runner, npmAvailable: true });
    const codes = (output.data.findings as Array<{ code: string }>).map((finding) => finding.code);
    expect(output.status).toBe("unavailable");
    expect(codes).toContain("registry-resolution-unavailable");
    expect(codes).not.toContain("fresh-peer-resolution-drift");
  });

  test("static mode never claims registry resolution evidence", () => {
    const root = fixture();
    const output = resolveDependencies(root, { execute: false });

    expect(output.status).toBe("passed");
    expect(output.data.runtimeEvidence).toBe("not-run");
    expect(output.data.packages).toEqual([]);
  });
});

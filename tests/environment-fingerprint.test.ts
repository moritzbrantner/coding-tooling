import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { expectedEnvironmentFingerprint } from "../src/environment-fingerprint.ts";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-fingerprint-"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", packageManager: "bun@1.4.0" }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "rust-toolchain.toml"),
    '[toolchain]\nchannel = "1.98.0"\ncomponents = ["rustfmt", "clippy"]\n',
  );
  writeFileSync(
    join(root, ".repository-environment.toml"),
    `schema_version = 1

[policy]
track = "latest-stable"

[system]
apt = ["tesseract-ocr", "ffmpeg"]

[compatibility_holds]
`,
  );
  writeFileSync(join(root, "bun.lock"), "bun-lock-v1\n");
  writeFileSync(join(root, "Cargo.lock"), "cargo-lock-v1\n");
  return root;
}

function passedData(root: string, profile: "default" | "source-development" = "default") {
  const result = expectedEnvironmentFingerprint(root, profile);
  expect(result.status).toBe("passed");
  return result.data as {
    fingerprint: string;
    layers: Record<string, { digest: string; inputs: unknown }>;
  };
}

describe("expected environment fingerprint", () => {
  test("is stable across irrelevant repository formatting and ambient files", () => {
    const root = repository();
    const before = passedData(root);

    writeFileSync(join(root, "package.json"), '{"packageManager":"bun@1.4.0","name":"fixture"}\n');
    writeFileSync(join(root, "README.md"), "unrelated documentation\n");
    const after = passedData(root);

    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.layers).toEqual(before.layers);
  });

  test("changes only toolchain and combined identity when an exact toolchain pin changes", () => {
    const root = repository();
    const before = passedData(root);

    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "fixture", packageManager: "bun@1.4.1" }, null, 2)}\n`,
    );
    const after = passedData(root);

    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.layers.toolchain.digest).not.toBe(before.layers.toolchain.digest);
    expect(after.layers.native.digest).toBe(before.layers.native.digest);
    expect(after.layers.dependencies.digest).toBe(before.layers.dependencies.digest);
    expect(after.layers.sources.digest).toBe(before.layers.sources.digest);
    expect(after.layers.config.digest).toBe(before.layers.config.digest);
  });

  test("uses .bun-version as exact Bun toolchain identity without a packageManager", () => {
    const root = repository();
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(join(root, ".bun-version"), "1.4.0\n");

    const data = passedData(root);

    expect(data.layers.toolchain.inputs).toEqual(
      expect.objectContaining({
        bun: {
          version: "1.4.0",
          declarations: { packageManager: null, versionFile: "1.4.0" },
        },
      }),
    );
  });

  test("accepts matching dual Bun declarations", () => {
    const root = repository();
    writeFileSync(join(root, ".bun-version"), "1.4.0\n");

    const data = passedData(root);

    expect(data.layers.toolchain.inputs).toEqual(
      expect.objectContaining({
        bun: {
          version: "1.4.0",
          declarations: { packageManager: "1.4.0", versionFile: "1.4.0" },
        },
      }),
    );
  });

  test("rejects conflicting Bun declarations", () => {
    const root = repository();
    writeFileSync(join(root, ".bun-version"), "1.3.14\n");

    const result = expectedEnvironmentFingerprint(root);

    expect(result.status).toBe("failed");
    expect(result.data.fingerprint).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "environment-fingerprint-toolchain-conflict",
        path: ".bun-version",
      }),
    );
  });

  test("includes an exact Node pin in toolchain identity", () => {
    const root = repository();
    const before = passedData(root);

    writeFileSync(join(root, ".node-version"), "24.20.0\n");
    const after = passedData(root);

    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.layers.toolchain.digest).not.toBe(before.layers.toolchain.digest);
    expect(after.layers.toolchain.inputs).toEqual(
      expect.objectContaining({ node: { version: "24.20.0" } }),
    );
  });

  test("changes only dependency and combined identity when a lockfile changes", () => {
    const root = repository();
    const before = passedData(root);

    writeFileSync(join(root, "Cargo.lock"), "cargo-lock-v2\n");
    const after = passedData(root);

    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.layers.dependencies.digest).not.toBe(before.layers.dependencies.digest);
    expect(after.layers.toolchain.digest).toBe(before.layers.toolchain.digest);
    expect(after.layers.native.digest).toBe(before.layers.native.digest);
    expect(after.layers.sources.digest).toBe(before.layers.sources.digest);
    expect(after.layers.config.digest).toBe(before.layers.config.digest);
  });

  test("includes nested committed lockfiles in dependency identity", () => {
    const root = repository();
    mkdirSync(join(root, "backend"), { recursive: true });
    writeFileSync(join(root, "backend", "Cargo.lock"), "backend-lock-v1\n");
    const before = passedData(root);

    writeFileSync(join(root, "backend", "Cargo.lock"), "backend-lock-v2\n");
    const after = passedData(root);

    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.layers.dependencies.digest).not.toBe(before.layers.dependencies.digest);
    expect(after.layers.toolchain.digest).toBe(before.layers.toolchain.digest);
    expect(after.layers.native.digest).toBe(before.layers.native.digest);
    expect(
      (after.layers.dependencies.inputs as Array<{ path: string }>).map((input) => input.path),
    ).toContain("backend/Cargo.lock");
  });

  test("does not fingerprint compatibility-hold explanations", () => {
    const root = repository();
    const before = passedData(root);
    writeFileSync(
      join(root, ".repository-environment.toml"),
      `schema_version = 1

[policy]
track = "latest-stable"

[system]
apt = ["ffmpeg", "tesseract-ocr"]

[compatibility_holds.bun]
candidate = "9.9.9"
tested_revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
reason = "a human explanation that is not environment identity"
`,
    );
    const after = passedData(root);

    expect(after.fingerprint).toBe(before.fingerprint);
  });

  test("gives explicit source development a distinct identity without hashing local paths", () => {
    const root = repository();
    writeFileSync(
      join(root, ".coding-tooling.source-deps.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          cargo: {
            localOnly: true,
            patches: [
              {
                package: "foundation-a",
                git: "https://example.invalid/foundation",
                rev: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                localPath: "../foundation-a",
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const ordinary = passedData(root, "default");
    const source = passedData(root, "source-development");
    expect(source.fingerprint).not.toBe(ordinary.fingerprint);

    writeFileSync(
      join(root, ".coding-tooling.source-deps.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          cargo: {
            localOnly: true,
            patches: [
              {
                package: "foundation-a",
                git: "https://example.invalid/foundation",
                rev: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                localPath: "../some-other-checkout-location",
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    const moved = passedData(root, "source-development");
    expect(moved.fingerprint).toBe(source.fingerprint);
  });

  test("refuses floating packageManager toolchain declarations", () => {
    const root = repository();
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "fixture", packageManager: "bun@latest" }, null, 2)}\n`,
    );

    const result = expectedEnvironmentFingerprint(root);

    expect(result.status).toBe("failed");
    expect(result.data.fingerprint).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "environment-fingerprint-toolchain-floating",
        path: "package.json",
      }),
    );
  });

  test("refuses floating .bun-version declarations", () => {
    const root = repository();
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(join(root, ".bun-version"), "latest\n");

    const result = expectedEnvironmentFingerprint(root);

    expect(result.status).toBe("failed");
    expect(result.data.fingerprint).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "environment-fingerprint-toolchain-floating",
        path: ".bun-version",
      }),
    );
  });

  test("refuses floating Node declarations", () => {
    const root = repository();
    writeFileSync(join(root, ".node-version"), "24\n");

    const result = expectedEnvironmentFingerprint(root);

    expect(result.status).toBe("failed");
    expect(result.data.fingerprint).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "environment-fingerprint-toolchain-floating",
        path: ".node-version",
      }),
    );
  });
});

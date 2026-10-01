import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sizeEvidence } from "../src/size-evidence.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "size-evidence-"));
  roots.push(root);
  mkdirSync(join(root, ".performance"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/index.js"), "12345");
  writeFileSync(join(root, "dist/chunk.js"), "123");
  writeFileSync(join(root, "dist/index.js.map"), "not selected");
  writeFileSync(join(root, "build.config.json"), "{}");
  return root;
}
function declaration(root: string, overrides: Record<string, unknown> = {}) {
  writeFileSync(
    join(root, ".performance/size.json"),
    JSON.stringify({
      schemaVersion: 1,
      targets: [
        {
          id: "public-js",
          kind: "web",
          entrypoint: "dist/index.js",
          artifacts: [{ path: "dist", extensions: [".js"] }],
          target: "browser",
          profile: "production",
          features: [],
          minification: "minified",
          toolchains: [[process.execPath, "--version"]],
          buildInputs: ["build.config.json"],
          maxBytes: 12,
          maxIncreaseBytes: 2,
          ...overrides,
        },
      ],
    }),
  );
}
function baseline(root: string) {
  const report = sizeEvidence(root);
  const path = join(root, "baseline.json");
  writeFileSync(path, JSON.stringify(report));
  return path;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
test("selects real built bytes in stable order without changing inputs", () => {
  const root = fixture();
  declaration(root);
  const before = readFileSync(join(root, ".performance/size.json"), "utf8");
  const report = sizeEvidence(root);
  expect(report.status).toBe("passed");
  expect(report.data.schemaVersion).toBe("coding-tooling/size-evidence/v1");
  expect(report.data.targets[0]?.bytes).toBe(8);
  expect(report.data.targets[0]?.artifacts.map((value) => value.path)).toEqual([
    "dist/chunk.js",
    "dist/index.js",
  ]);
  expect(report.data.targets[0]?.comparison.state).toBe("not-requested");
  expect(readFileSync(join(root, ".performance/size.json"), "utf8")).toBe(before);
});
test("compares compatible versions and enforces declared absolute and increase budgets", () => {
  const root = fixture();
  declaration(root);
  const path = baseline(root);
  writeFileSync(join(root, "dist/index.js"), "123456789");
  const report = sizeEvidence(root, { baseline: path });
  expect(report.status).toBe("failed");
  expect(report.data.targets[0]?.comparison).toMatchObject({
    state: "comparable",
    baselineBytes: 8,
    deltaBytes: 4,
  });
  expect(report.data.targets[0]?.failures).toContain("Size increase 4 exceeds 2 bytes.");
});
test("changed target, features, mode, selection or toolchain is incomparable", () => {
  const root = fixture();
  declaration(root);
  const path = baseline(root);
  for (const overrides of [
    { target: "wasm32" },
    { features: ["simd"] },
    { profile: "development" },
    { minification: "none" },
    { artifacts: [{ path: "dist/index.js" }] },
    { toolchains: [[process.execPath, "-e", 'console.log("different compiler")']] },
  ]) {
    declaration(root, overrides);
    const report = sizeEvidence(root, { baseline: path });
    expect(report.status).toBe("unavailable");
    expect(report.data.targets[0]?.comparison.state).toBe("incomparable");
  }
});
test("missing tool, built output or requested baseline cannot pass", () => {
  const root = fixture();
  declaration(root, { toolchains: [["nonexistent-size-collector-160", "--version"]] });
  expect(sizeEvidence(root).status).toBe("unavailable");
  declaration(root, { artifacts: [{ path: "missing.bin" }] });
  expect(sizeEvidence(root).status).toBe("unavailable");
  declaration(root);
  expect(sizeEvidence(root, { baseline: "missing.json" }).status).toBe("unavailable");
});
test("rejects invalid versioned baselines and invalid declarations", () => {
  const root = fixture();
  declaration(root);
  writeFileSync(join(root, "baseline.json"), JSON.stringify({ schemaVersion: 2 }));
  expect(sizeEvidence(root, { baseline: "baseline.json" }).status).toBe("error");
  for (const overrides of [
    { maxBytes: -1 },
    { features: ["a", "a"] },
    { unknown: true },
    { entrypoint: "../outside.js" },
  ]) {
    declaration(root, overrides);
    expect(sizeEvidence(root).status).toBe("error");
  }
});
test("native artifact identity includes exact binary bytes", () => {
  const root = fixture();
  declaration(root, {
    kind: "native",
    entrypoint: "dist/index.js",
    target: "x86_64-unknown-linux-gnu",
    profile: "release",
    minification: "not-applicable",
    artifacts: [{ path: "dist/index.js" }],
  });
  const report = sizeEvidence(root);
  expect(report.status).toBe("passed");
  expect(report.data.targets[0]?.bytes).toBe(5);
  expect(report.data.targets[0]?.artifacts[0]?.sha256).toHaveLength(64);
});

test("changed build inputs are incomparable even if output bytes match", () => {
  const root = fixture();
  declaration(root);
  const path = baseline(root);
  writeFileSync(join(root, "build.config.json"), '{"minify":false}');
  expect(sizeEvidence(root, { baseline: path }).data.targets[0]?.comparison.state).toBe(
    "incomparable",
  );
});
test("rejects forged baseline identity and inconsistent byte totals", () => {
  const root = fixture();
  declaration(root);
  const path = baseline(root);
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.data.targets[0].inputs.profile = "forged";
  writeFileSync(path, JSON.stringify(value));
  expect(sizeEvidence(root, { baseline: path }).status).toBe("error");
  const valid = sizeEvidence(root);
  valid.data.targets[0]!.bytes = 999;
  writeFileSync(path, JSON.stringify(valid));
  expect(sizeEvidence(root, { baseline: path }).status).toBe("error");
});

test.skipIf(process.platform === "win32")(
  "rejects a symlink ancestor of a declared artifact",
  () => {
    const root = fixture();
    symlinkSync(join(root, "dist"), join(root, "linked"), "dir");
    declaration(root, { entrypoint: "linked/index.js", artifacts: [{ path: "linked/index.js" }] });
    expect(sizeEvidence(root).status).toBe("error");
  },
);
test("package CLI exposes structured results and nonzero unavailable exit codes", () => {
  const root = fixture();
  declaration(root);
  const command = [
    process.execPath,
    join(import.meta.dir, "../src/router.ts"),
    "performance",
    "size",
    "--root",
    root,
    "--json",
  ];
  const passed = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", timeout: 10000 });
  expect(passed.status).toBe(0);
  expect(JSON.parse(passed.stdout).operation).toBe("size-evidence");
  const missing = spawnSync(command[0]!, [...command.slice(1), "--baseline", "missing.json"], {
    encoding: "utf8",
    timeout: 10000,
  });
  expect(missing.status).toBe(2);
  expect(JSON.parse(missing.stdout).status).toBe("unavailable");
});

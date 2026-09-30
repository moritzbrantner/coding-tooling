import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPagesArtifact } from "../scripts/check-pages.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function artifact(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-pages-acceptance-"));
  roots.push(root);
  writeFileSync(join(root, "index.html"), '<script type="module" src="./app.js"></script>');
  writeFileSync(join(root, "app.js"), "export const value = 1;");
  return root;
}

test("checks owned resources in the actual artifact and fingerprints its exact bytes", () => {
  const root = artifact();
  const first = checkPagesArtifact(root, ["index.html"]);
  expect(first.ownedResources).toEqual(["app.js"]);
  expect(first.artifacts).toHaveLength(2);
  expect(checkPagesArtifact(root, ["index.html"]).fingerprint).toBe(first.fingerprint);
  writeFileSync(join(root, "app.js"), "export const value = 2;");
  expect(checkPagesArtifact(root, ["index.html"]).fingerprint).not.toBe(first.fingerprint);
});

test("rejects missing entrypoints, broken resource paths, and traversal", () => {
  const root = artifact();
  expect(() => checkPagesArtifact(root, ["missing.html"])).toThrow();
  writeFileSync(join(root, "index.html"), '<script src="missing.js"></script>');
  expect(() => checkPagesArtifact(root, ["index.html"])).toThrow();
  writeFileSync(join(root, "index.html"), "<script data-src=app.js src=missing.js></script>");
  expect(() => checkPagesArtifact(root, ["index.html"])).toThrow();
  writeFileSync(join(root, "index.html"), '<script src="../outside.js"></script>');
  expect(() => checkPagesArtifact(root, ["index.html"])).toThrow();
});

test("resolves nested entrypoints and keeps external references explicitly unverified", () => {
  const root = artifact();
  mkdirSync(join(root, "analysis.json"));
  writeFileSync(
    join(root, "analysis.json/index.html"),
    '<script src="../app.js"></script><link href="https://example.invalid/style.css" rel="stylesheet">',
  );
  const result = checkPagesArtifact(root, ["analysis.json/index.html"]);
  expect(result.ownedResources).toEqual(["app.js"]);
  expect(result.unverifiedExternalResources).toEqual(["https://example.invalid/style.css"]);
});

test("rejects symlinked artifacts instead of borrowing external bytes", () => {
  const root = artifact();
  symlinkSync(root, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  expect(() => checkPagesArtifact(root, ["index.html"])).toThrow("symlink");
});

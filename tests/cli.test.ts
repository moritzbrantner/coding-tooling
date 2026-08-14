import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  affected,
  inspectRepository,
} from "../src/tooling.ts";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      packageManager: "bun@1.3.0",
      scripts: {
        format: "oxfmt --check .",
        lint: "oxlint .",
        typecheck: "tsc --noEmit",
        test: "bun test",
        check: "bun run lint && bun test",
      },
      devDependencies: { typescript: "1.0.0" },
    }),
  );
  return root;
}

test(
  "inspect exposes declared package capabilities and the final gate",
  () => {
    const result = inspectRepository(repository());
    assert.deepEqual(
      result.components[0].capabilities["gate:final"],
      ["bun", "run", "check"],
    );
    assert.deepEqual(
      result.components[0].capabilities["format:check"],
      ["bun", "run", "format"],
    );
  },
);

test(
  "affected accepts an explicit run-owned change manifest",
  () => {
    const root = repository();
    const manifest = join(root, "changes.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        files: ["src/example.ts", "src/example.ts"],
      }),
    );
    const result = affected(inspectRepository(root), {
      changeManifest: manifest,
    });
    assert.equal(result.status, "passed");
    assert.deepEqual(result.data.changedFiles, [
      "src/example.ts",
    ]);
    assert.deepEqual(result.data.affectedComponents, ["fixture"]);
    assert.ok(
      !result.data.recommendedCapabilities.includes("gate:final"),
    );
  },
);

test(
  "affected rejects manifest paths outside the repository",
  () => {
    const root = repository();
    const manifest = join(root, "changes.json");
    writeFileSync(manifest, JSON.stringify(["../outside.ts"]));
    assert.equal(
      affected(inspectRepository(root), {
        changeManifest: manifest,
      }).status,
      "error",
    );
  },
);

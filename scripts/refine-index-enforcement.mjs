import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`missing patch target: ${label}`);
  return source.replace(before, after);
}

const sourcePath = "src/convention-enforcement.ts";
let source = readFileSync(sourcePath, "utf8");
source = replaceOnce(
  source,
  `function repositoryFiles(root: string): RepositoryFile[] {\n  const tracked = trackedRepositoryFiles(root);\n  if (tracked) {\n    return tracked.filter((file) => !file.relativePath.startsWith(".conventions/"));\n  }\n\n  return sortRepositoryFiles(\n    walkFiles(root, 20)\n      .map((absolutePath) => ({\n        absolutePath,\n        relativePath: relative(root, absolutePath).replaceAll("\\\\", "/"),\n      }))\n      .filter((file) => !file.relativePath.startsWith(".conventions/")),\n  );\n}\n`,
  `function repositoryFiles(root: string): RepositoryFile[] {\n  const walked = walkFiles(root, 20)\n    .map((absolutePath) => ({\n      absolutePath,\n      relativePath: relative(root, absolutePath).replaceAll("\\\\", "/"),\n    }))\n    .filter((file) => !file.relativePath.startsWith(".conventions/"));\n  const tracked = trackedRepositoryFiles(root);\n  if (!tracked) return sortRepositoryFiles(walked);\n\n  const files = new Map(walked.map((file) => [file.relativePath, file]));\n  for (const file of tracked) {\n    if (!file.relativePath.startsWith(".conventions/")) files.set(file.relativePath, file);\n  }\n  return sortRepositoryFiles([...files.values()]);\n}\n`,
  "repository union",
);
writeFileSync(sourcePath, source);

const testPath = "tests/convention-enforcement.test.ts";
let tests = readFileSync(testPath, "utf8");
tests = replaceOnce(
  tests,
  `  test("checks tracked case collisions inside ignored output directories", () => {\n`,
  `  test("still checks untracked working-tree paths after Git initialization", () => {\n    const root = repository();\n    enforce(root, "REPO-013", { kind: "builtin", check: "case-portability" });\n    execFileSync("git", ["init", "-q"], { cwd: root });\n    mkdirSync(join(root, "foo"), { recursive: true });\n    try {\n      mkdirSync(join(root, "Foo"));\n    } catch (error) {\n      if ((error as { code?: string }).code === "EEXIST") return;\n      throw error;\n    }\n    writeFileSync(join(root, "Foo", "a.ts"), "export {};\\n");\n    writeFileSync(join(root, "foo", "b.ts"), "export {};\\n");\n\n    const failed = runConventionChecks(root, discoverComponents(root));\n    expect(failed.status).toBe("failed");\n    expect(failed.diagnostics[0]?.message).toContain("Foo and foo");\n  });\n\n  test("checks tracked case collisions inside ignored output directories", () => {\n`,
  "untracked git regression",
);
writeFileSync(testPath, tests);

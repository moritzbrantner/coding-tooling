import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`missing patch target: ${label}`);
  const next = source.replace(before, after);
  if (next === source) throw new Error(`patch did not change: ${label}`);
  return next;
}

const sourcePath = "src/convention-enforcement.ts";
let source = readFileSync(sourcePath, "utf8");

source = replaceOnce(
  source,
  `type RepositoryFile = { absolutePath: string; relativePath: string };\n`,
  `type RepositoryFile = {\n  absolutePath: string;\n  relativePath: string;\n  gitMode?: string;\n};\n`,
  "repository file metadata",
);

source = replaceOnce(
  source,
  `function repositoryFiles(root: string): RepositoryFile[] {\n  return sortRepositoryFiles(\n    walkFiles(root, 20)\n      .map((absolutePath) => ({\n        absolutePath,\n        relativePath: relative(root, absolutePath).replaceAll("\\\\", "/"),\n      }))\n      .filter((file) => !file.relativePath.startsWith(".conventions/")),\n  );\n}\n\nfunction textHygieneFiles(root: string): RepositoryFile[] {\n  const tracked = runCommand("git", ["ls-files", "-z"], root);\n  if (tracked.status === 0) {\n    return sortRepositoryFiles(\n      tracked.stdout\n        .split("\\0")\n        .filter((relativePath) => relativePath.length > 0)\n        .map((relativePath) => ({\n          absolutePath: join(root, ...relativePath.split("/")),\n          relativePath,\n        }))\n        .filter((file) => existsSync(file.absolutePath)),\n    );\n  }\n\n  return sortRepositoryFiles(\n    walkFiles(root, 20, {\n      includeIgnoredDirectories: ["bin", "build", "dist", "fixtures", "obj", "target"],\n    }).map((absolutePath) => ({\n      absolutePath,\n      relativePath: relative(root, absolutePath).replaceAll("\\\\", "/"),\n    })),\n  );\n}\n`,
  `function trackedRepositoryFiles(root: string): RepositoryFile[] | undefined {\n  const tracked = runCommand("git", ["ls-files", "--stage", "-z"], root);\n  if (tracked.status !== 0) return undefined;\n\n  const files: RepositoryFile[] = [];\n  for (const entry of tracked.stdout.split("\\0")) {\n    if (!entry) continue;\n    const match = entry.match(/^(\\d{6}) [0-9a-f]+ \\d+\\t(.+)$/);\n    if (!match) continue;\n    const [, gitMode, relativePath] = match;\n    files.push({\n      absolutePath: join(root, ...relativePath.split("/")),\n      relativePath,\n      gitMode,\n    });\n  }\n  return sortRepositoryFiles(files);\n}\n\nfunction repositoryFiles(root: string): RepositoryFile[] {\n  const tracked = trackedRepositoryFiles(root);\n  if (tracked) {\n    return tracked.filter((file) => !file.relativePath.startsWith(".conventions/"));\n  }\n\n  return sortRepositoryFiles(\n    walkFiles(root, 20)\n      .map((absolutePath) => ({\n        absolutePath,\n        relativePath: relative(root, absolutePath).replaceAll("\\\\", "/"),\n      }))\n      .filter((file) => !file.relativePath.startsWith(".conventions/")),\n  );\n}\n\nfunction textHygieneFiles(root: string): RepositoryFile[] {\n  const tracked = trackedRepositoryFiles(root);\n  if (tracked) return tracked.filter((file) => !file.relativePath.startsWith(".conventions/"));\n\n  return sortRepositoryFiles(\n    walkFiles(root, 20, {\n      includeIgnoredDirectories: ["bin", "build", "dist", "fixtures", "obj", "target"],\n    }).map((absolutePath) => ({\n      absolutePath,\n      relativePath: relative(root, absolutePath).replaceAll("\\\\", "/"),\n    })),\n  );\n}\n`,
  "tracked repository traversal",
);

source = replaceOnce(
  source,
  `  for (const file of textHygieneFiles(root)) {\n    let stats;\n    try {\n      stats = lstatSync(file.absolutePath);\n    } catch {\n      continue;\n    }\n    if (stats.isSymbolicLink() || stats.size > 5_000_000) continue;\n\n    const buffer = readFileSync(file.absolutePath);\n`,
  `  for (const file of textHygieneFiles(root)) {\n    if (file.gitMode === "160000" || file.gitMode === "120000") continue;\n\n    let stats;\n    try {\n      stats = lstatSync(file.absolutePath);\n    } catch {\n      continue;\n    }\n    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 5_000_000) continue;\n\n    const buffer = readFileSync(file.absolutePath);\n`,
  "text hygiene file type guard",
);

source = replaceOnce(
  source,
  `    if (!workflowLike) continue;\n\n    for (const [index, line] of readFileSync(file.absolutePath, "utf8").split(/\\r?\\n/).entries()) {\n`,
  `    if (!workflowLike || file.gitMode === "160000") continue;\n\n    let content: string;\n    try {\n      content = readFileSync(file.absolutePath, "utf8");\n    } catch {\n      continue;\n    }\n    for (const [index, line] of content.split(/\\r?\\n/).entries()) {\n`,
  "workflow content guard",
);

writeFileSync(sourcePath, source);

const testPath = "tests/convention-enforcement.test.ts";
let tests = readFileSync(testPath, "utf8");

tests = replaceOnce(
  tests,
  `    expect(trackedOutputFailed.diagnostics[0]?.message).toContain(\n      "dist/index.js: use LF line endings",\n    );\n  });\n`,
  `    expect(trackedOutputFailed.diagnostics[0]?.message).toContain(\n      "dist/index.js: use LF line endings",\n    );\n\n    writeFileSync(join(dist, "index.js"), "export const built = true;\\n");\n    const submodule = join(root, "vendor", "module");\n    mkdirSync(submodule, { recursive: true });\n    execFileSync("git", ["init", "-q"], { cwd: submodule });\n    writeFileSync(join(submodule, "README.md"), "fixture\\n");\n    execFileSync("git", ["add", "."], { cwd: submodule });\n    execFileSync(\n      "git",\n      [\n        "-c",\n        "user.name=Fixture",\n        "-c",\n        "user.email=fixture@example.invalid",\n        "commit",\n        "-qm",\n        "fixture",\n      ],\n      { cwd: submodule },\n    );\n    const submoduleSha = execFileSync("git", ["rev-parse", "HEAD"], {\n      cwd: submodule,\n      encoding: "utf8",\n    }).trim();\n    execFileSync(\n      "git",\n      ["update-index", "--add", "--cacheinfo", `160000,${submoduleSha},vendor/module`],\n      { cwd: root },\n    );\n\n    expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");\n  });\n`,
  "gitlink text hygiene regression",
);

tests = replaceOnce(
  tests,
  `  test("rejects case-colliding directory segments with stable diagnostic ordering", () => {\n    const root = repository();\n    enforce(root, "REPO-013", { kind: "builtin", check: "case-portability" });\n    mkdirSync(join(root, "foo"), { recursive: true });\n    try {\n      mkdirSync(join(root, "Foo"));\n    } catch (error) {\n      if ((error as { code?: string }).code === "EEXIST") return;\n      throw error;\n    }\n    writeFileSync(join(root, "Foo", "a.ts"), "export {};\\n");\n    writeFileSync(join(root, "foo", "b.ts"), "export {};\\n");\n\n    const failed = runConventionChecks(root, discoverComponents(root));\n    expect(failed.status).toBe("failed");\n    expect(failed.diagnostics[0]?.message).toContain("Foo and foo");\n  });\n`,
  `  test("rejects case-colliding directory segments with stable diagnostic ordering", () => {\n    const root = repository();\n    enforce(root, "REPO-013", { kind: "builtin", check: "case-portability" });\n    mkdirSync(join(root, "foo"), { recursive: true });\n    try {\n      mkdirSync(join(root, "Foo"));\n    } catch (error) {\n      if ((error as { code?: string }).code === "EEXIST") return;\n      throw error;\n    }\n    writeFileSync(join(root, "Foo", "a.ts"), "export {};\\n");\n    writeFileSync(join(root, "foo", "b.ts"), "export {};\\n");\n\n    const failed = runConventionChecks(root, discoverComponents(root));\n    expect(failed.status).toBe("failed");\n    expect(failed.diagnostics[0]?.message).toContain("Foo and foo");\n  });\n\n  test("checks tracked case collisions inside ignored output directories", () => {\n    const root = repository();\n    enforce(root, "REPO-013", { kind: "builtin", check: "case-portability" });\n    const dist = join(root, "dist");\n    mkdirSync(join(dist, "foo"), { recursive: true });\n    try {\n      mkdirSync(join(dist, "Foo"));\n    } catch (error) {\n      if ((error as { code?: string }).code === "EEXIST") return;\n      throw error;\n    }\n    writeFileSync(join(dist, "Foo", "a.ts"), "export {};\\n");\n    writeFileSync(join(dist, "foo", "b.ts"), "export {};\\n");\n    execFileSync("git", ["init", "-q"], { cwd: root });\n    execFileSync("git", ["add", "."], { cwd: root });\n\n    const failed = runConventionChecks(root, discoverComponents(root));\n    expect(failed.status).toBe("failed");\n    expect(failed.diagnostics[0]?.message).toContain("dist/Foo and dist/foo");\n  });\n`,
  "tracked output case collision regression",
);

writeFileSync(testPath, tests);

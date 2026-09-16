import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`missing patch target: ${label}`);
  return source.replace(before, after);
}

const sourcePath = "src/convention-enforcement.ts";
let source = readFileSync(sourcePath, "utf8");
source = replaceOnce(
  source,
  `  for (const entry of tracked.stdout.split("\\0")) {\n    if (!entry) continue;\n    const match = entry.match(/^(\\d{6}) [0-9a-f]+ \\d+\\t(.+)$/);\n    if (!match) continue;\n    const [, gitMode, relativePath] = match;\n    files.push({\n`,
  `  for (const entry of tracked.stdout.split("\\0")) {\n    if (!entry) continue;\n    const separator = entry.indexOf("\\t");\n    if (separator < 0) continue;\n    const metadata = entry.slice(0, separator);\n    const relativePath = entry.slice(separator + 1);\n    const match = metadata.match(/^(\\d{6}) [0-9a-f]+ \\d+$/);\n    if (!match || !relativePath) continue;\n    const [, gitMode] = match;\n    files.push({\n`,
  "NUL index parser",
);
source = replaceOnce(
  source,
  `    if (!workflowLike || file.gitMode === "160000") continue;\n\n    let content: string;\n    try {\n      content = readFileSync(file.absolutePath, "utf8");\n    } catch {\n      continue;\n    }\n`,
  `    if (!workflowLike) continue;\n    if (file.gitMode === "160000" || file.gitMode === "120000") {\n      failures.push(\`${'${file.relativePath}'}: tracked workflow must be a regular file\`);\n      continue;\n    }\n\n    let content: string;\n    try {\n      content = readFileSync(file.absolutePath, "utf8");\n    } catch {\n      failures.push(\`${'${file.relativePath}'}: tracked workflow could not be read\`);\n      continue;\n    }\n`,
  "fail-closed workflow read",
);
writeFileSync(sourcePath, source);

const testPath = "tests/convention-enforcement.test.ts";
let tests = readFileSync(testPath, "utf8");
tests = replaceOnce(
  tests,
  `  test("requires immutable external CI action revisions", () => {\n`,
  `  test("parses tracked workflow paths containing newlines", () => {\n    const root = repository();\n    enforce(root, "SEC-005", { kind: "builtin", check: "ci-action-pins" });\n    execFileSync("git", ["init", "-q"], { cwd: root });\n    const workflow = join(root, ".github", "workflows", "bad\\nname.yml");\n    mkdirSync(dirname(workflow), { recursive: true });\n    writeFileSync(workflow, "steps:\\n  - uses: actions/checkout@v6\\n");\n    execFileSync("git", ["add", "."], { cwd: root });\n\n    const failed = runConventionChecks(root, discoverComponents(root));\n    expect(failed.status).toBe("failed");\n    expect(failed.diagnostics[0]?.message).toContain("external action must use a full commit SHA");\n  });\n\n  test("fails closed when a tracked workflow cannot be read", () => {\n    const root = repository();\n    enforce(root, "SEC-005", { kind: "builtin", check: "ci-action-pins" });\n    execFileSync("git", ["init", "-q"], { cwd: root });\n    const workflow = join(root, ".github", "workflows", "missing.yml");\n    mkdirSync(dirname(workflow), { recursive: true });\n    writeFileSync(workflow, "steps:\\n  - uses: actions/checkout@v6\\n");\n    execFileSync("git", ["add", "."], { cwd: root });\n    rmSync(workflow);\n\n    const failed = runConventionChecks(root, discoverComponents(root));\n    expect(failed.status).toBe("failed");\n    expect(failed.diagnostics[0]?.message).toContain("tracked workflow could not be read");\n  });\n\n  test("requires immutable external CI action revisions", () => {\n`,
  "Git index workflow edge regressions",
);
writeFileSync(testPath, tests);

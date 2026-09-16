from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match in {path}, found {count}: {old!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "site/execution-evidence.js",
    '''    const actionMatch = workflowEvidence.codingToolingAction && step.codingToolingAction;
    if (!commandMatch && !actionMatch) continue;''',
    '''    const wrapperMatch = (workflowEvidence.matchedPackageScriptEvidence ?? []).some(
      (wrapper) =>
        step.workingDirectory === wrapper.workingDirectory &&
        step.commands.some((candidate) => shellCommandMatches(candidate, wrapper.command)),
    );
    const actionMatch = workflowEvidence.codingToolingAction && step.codingToolingAction;
    if (!commandMatch && !wrapperMatch && !actionMatch) continue;''',
)

replace_once(
    "site/evidence-model.js",
    '''  if (!value || /[;|`\\n\\r]/.test(value) || value.includes("$(")) return [];''',
    '''  if (
    !value ||
    /[;|`\\n\\r]/.test(value) ||
    /(^|[^&])&([^&]|$)/.test(value) ||
    value.includes("$(")
  )
    return [];''',
)

replace_once(
    "tests/scoped-remote-validation.test.js",
    '''  test("cyclic package-script wrappers remain non-validating", () => {''',
    '''  test("backgrounded package-script validation remains non-validating", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: npm run verify\\n`,
      [{ command: "npm run test:unit", workingDirectory: "." }],
      [
        {
          workingDirectory: ".",
          manager: "npm",
          scripts: { verify: "npm run test:unit & true", "test:unit": "vitest run" },
        },
      ],
    );

    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].matchedPackageScriptEvidence).toEqual([]);
  });

  test("cyclic package-script wrappers remain non-validating", () => {''',
)

replace_once(
    "tests/remote-execution-evidence.test.js",
    '''import { remoteExecutionEvidence } from "../site/execution-evidence.js";''',
    '''import { remoteValidationOutcome } from "../site/evidence-model.js";
import { remoteExecutionEvidence } from "../site/execution-evidence.js";''',
)

replace_once(
    "tests/remote-execution-evidence.test.js",
    '''  test("keeps matrix lists outside step evidence", () => {''',
    '''  test("maps resolved wrappers into continue-on-error fail-closed evidence", () => {
    const path = ".github/workflows/validate.yml";
    const content = `on: [pull_request]\\njobs:\\n  validate:\\n    steps:\\n      - name: Verify\\n        run: npm run verify\\n        continue-on-error: true\\n`;
    const evidence = remoteExecutionEvidence({
      validationEvidence: wrapperValidation(path, content),
      workflows: [{ path, content }],
    });

    expect(evidence.failClosed).toEqual(
      expect.objectContaining({
        status: "finding",
        reason: "all-proven-validation-is-fail-open",
      }),
    );
  });

  test("maps resolved wrappers into shell-suppression fail-closed evidence", () => {
    const path = ".github/workflows/validate.yml";
    const content = `on: [pull_request]\\njobs:\\n  validate:\\n    steps:\\n      - name: Verify\\n        run: npm run verify || true\\n`;
    const evidence = remoteExecutionEvidence({
      validationEvidence: wrapperValidation(path, content),
      workflows: [{ path, content }],
    });

    expect(evidence.failClosed.status).toBe("finding");
  });

  test("keeps matrix lists outside step evidence", () => {''',
)

replace_once(
    "tests/remote-execution-evidence.test.js",
    '''function validation(path, matchedCommands) {''',
    '''function wrapperValidation(path, content) {
  const result = remoteValidationOutcome({
    workflowPaths: [path],
    workflows: [{ path, content }],
    externalCiPaths: [],
    workflowFetchTruncated: false,
    defaultBranch: "main",
    declaredCommands: [{ command: "npm run test:unit", workingDirectory: "." }],
    packageScripts: [
      {
        workingDirectory: ".",
        manager: "npm",
        scripts: { verify: "npm run test:unit", "test:unit": "vitest run" },
      },
    ],
  });
  if (result.status !== "satisfied") {
    throw new Error(`wrapper validation fixture must be satisfied, got ${result.status}`);
  }
  return result;
}

function validation(path, matchedCommands) {''',
)

replace_once(
    "docs/github-pages-analysis.md",
    '''Remote preflight distinguishes automation presence from mechanically evidenced validation. GitHub Actions workflow names do not count as validation by themselves. A workflow satisfies the v1 signal only when its inspected YAML text shows a pull-request or default-branch trigger and also invokes a repository validation command discovered from component capabilities or the coding-tooling Action seam.''',
    '''Remote preflight distinguishes automation presence from mechanically evidenced validation. GitHub Actions workflow names do not count as validation by themselves. A workflow satisfies the v1 signal only when its inspected YAML text shows a pull-request or default-branch trigger and also invokes a repository validation command discovered from component capabilities, a bounded same-component Bun/npm package-script wrapper proven from fetched `package.json` evidence, or the coding-tooling Action seam.

Schema-v1 `workflowEvidence` keeps direct declared-command matches in `matchedCommandEvidence` and records bounded wrapper provenance separately in `matchedPackageScriptEvidence`. Each wrapper entry names the invoked wrapper command, package working directory, script key, and the declared commands reached through that bounded chain. The field is additive within v1 and exists so downstream evidence can distinguish the workflow step that actually ran from the underlying declared validation commands it proves.''',
)

replace_once(
    "docs/execution-evidence.md",
    '''If another recognized validation path still propagates failure normally, that independent path remains valid evidence. Complex shell control flow, expressions, traps, wrappers, and indirect scripts are not interpreted.''',
    '''If another recognized validation path still propagates failure normally, that independent path remains valid evidence. Complex shell control flow, expressions, traps, and unbounded indirect scripts are not interpreted. A bounded same-component Bun/npm package-script chain may be resolved from fetched `package.json` evidence; fail-closed mapping still uses the invoked wrapper step so `continue-on-error` and obvious shell suppression cannot become false-green validation.''',
)

from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match in {path}, found {count}: {old!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "site/evidence-model.js",
    '''      !workflowRunsCommand(content, {
        command: wrapperCommand,
        workingDirectory: packageEvidence.workingDirectory,
      })''',
    '''      !workflowRunsCommand(
        content,
        {
          command: wrapperCommand,
          workingDirectory: packageEvidence.workingDirectory,
        },
        packageScriptInvocationMatchesInDirectory,
      )''',
)

replace_once(
    "site/evidence-model.js",
    '''function workflowRunsCommand(content, declaredCommand) {''',
    '''function workflowRunsCommand(
  content,
  declaredCommand,
  matchesInDirectory = shellCommandMatchesInDirectory,
) {''',
)

replace_once(
    "site/evidence-model.js",
    '''        shellCommandMatchesInDirectory(inline, needle, workingDirectory, requiredWorkingDirectory)''',
    '''        matchesInDirectory(inline, needle, workingDirectory, requiredWorkingDirectory)''',
)

replace_once(
    "site/evidence-model.js",
    '''        shellCommandMatchesInDirectory(
          shellLine,
          needle,
          workingDirectory,
          requiredWorkingDirectory,
        )''',
    '''        matchesInDirectory(shellLine, needle, workingDirectory, requiredWorkingDirectory)''',
)

replace_once(
    "site/evidence-model.js",
    '''function normalizeWorkingDirectory(value) {''',
    '''function packageScriptInvocationMatchesInDirectory(
  value,
  command,
  workingDirectory,
  requiredDirectory,
) {
  if (
    workingDirectory === requiredDirectory &&
    packageScriptInvocationMatches(value, command)
  )
    return true;
  if (workingDirectory !== "." || requiredDirectory === ".") return false;
  const normalized = normalizeCommand(value);
  const prefix = `cd ${requiredDirectory} && `;
  return (
    normalized.startsWith(prefix) &&
    packageScriptInvocationMatches(normalized.slice(prefix.length), command)
  );
}

function packageScriptInvocationMatches(value, command) {
  const normalized = normalizeCommand(value);
  if (normalized === command) return true;
  if (!normalized.startsWith(`${command} `)) return false;
  const suffix = normalized.slice(command.length).trimStart();
  return (
    suffix === "--" ||
    suffix.startsWith("-- ") ||
    suffix.startsWith("#") ||
    /^(?:&&|\\|\\|)(?:\\s|$)/.test(suffix) ||
    /^&(?:\\s|$)/.test(suffix)
  );
}

function normalizeWorkingDirectory(value) {''',
)

replace_once(
    "site/execution-evidence.js",
    '''function obviousShellSuppression(value) {
  const normalized = normalizeCommand(value);
  return /\\|\\|\\s*(?:true|:)\\s*$/.test(normalized);
}''',
    '''function obviousShellSuppression(value) {
  const normalized = normalizeCommand(value);
  return (
    /\\|\\|\\s*(?:true|:)\\s*$/.test(normalized) ||
    /(?:^|\\s)&(?:\\s|$)/.test(normalized)
  );
}''',
)

replace_once(
    "tests/scoped-remote-validation.test.js",
    '''  test("backgrounded package-script validation remains non-validating", () => {''',
    '''  test("workspace-scoped wrapper invocation cannot satisfy root package evidence", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: npm run verify --workspace child\\n`,
      [{ command: "npm run test:unit", workingDirectory: "." }],
      [
        {
          workingDirectory: ".",
          manager: "npm",
          scripts: { verify: "npm run test:unit", "test:unit": "vitest run" },
        },
      ],
    );

    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].matchedPackageScriptEvidence).toEqual([]);
  });

  test("backgrounded package-script validation remains non-validating", () => {''',
)

replace_once(
    "tests/remote-execution-evidence.test.js",
    '''  test("maps resolved wrappers into shell-suppression fail-closed evidence", () => {''',
    '''  test("maps backgrounded wrapper steps into fail-closed evidence", () => {
    const path = ".github/workflows/validate.yml";
    const content = `on: [pull_request]\\njobs:\\n  validate:\\n    steps:\\n      - name: Verify\\n        run: npm run verify & true\\n`;
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

  test("maps resolved wrappers into shell-suppression fail-closed evidence", () => {''',
)

replace_once(
    "docs/github-pages-analysis.md",
    '''The bounded chain accepts only same-component package-script references and declared validation commands joined by failure-propagating `&&`; any other shell segment leaves the wrapper unproven rather than being interpreted.''',
    '''The bounded chain accepts only same-component package-script references and declared validation commands joined by failure-propagating `&&`; any other package-script segment leaves the wrapper unproven rather than being interpreted. Workflow wrapper invocations must target that component directly: npm/Bun execution-scope options such as `--workspace` are not attached to the current component, while arguments after an explicit `--` passthrough remain part of the selected script invocation.''',
)

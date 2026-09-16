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
    '''  const matches = new Set();
  for (const segment of boundedPackageScriptSegments(source)) {
    for (const declared of declaredCommands) {
      if (shellCommandMatches(segment, declared.command)) matches.add(declared.command);
    }
    const referencedScript = packageScriptReference(segment, manager);
    if (!referencedScript) continue;''',
    '''  const segments = boundedPackageScriptSegments(source);
  if (segments.length === 0) return [];
  const matches = new Set();
  for (const segment of segments) {
    let bounded = false;
    for (const declared of declaredCommands) {
      if (!shellCommandMatches(segment, declared.command)) continue;
      matches.add(declared.command);
      bounded = true;
    }
    const referencedScript = packageScriptReference(segment, manager);
    if (!referencedScript) {
      if (!bounded) return [];
      continue;
    }
    bounded = true;''',
)

replace_once(
    "site/execution-evidence.js",
    '''    const commandMatch =
      matchedCommandEvidence.length > 0
        ? matchedCommandEvidence.some(
            (command) =>
              step.workingDirectory === command.workingDirectory &&
              step.commands.some((candidate) => shellCommandMatches(candidate, command.command)),
          )
        : (workflowEvidence.matchedCommands ?? []).some((command) =>
            step.commands.some((candidate) => shellCommandMatches(candidate, command)),
          );
    const wrapperMatch = (workflowEvidence.matchedPackageScriptEvidence ?? []).some(
      (wrapper) =>
        step.workingDirectory === wrapper.workingDirectory &&
        step.commands.some((candidate) => shellCommandMatches(candidate, wrapper.command)),
    );''',
    '''    const commandMatch =
      matchedCommandEvidence.length > 0
        ? matchedCommandEvidence.some((command) =>
            stepRunsCommandInDirectory(step, command.command, command.workingDirectory),
          )
        : (workflowEvidence.matchedCommands ?? []).some((command) =>
            step.commands.some((candidate) => shellCommandMatches(candidate, command)),
          );
    const wrapperMatch = (workflowEvidence.matchedPackageScriptEvidence ?? []).some((wrapper) =>
      stepRunsCommandInDirectory(step, wrapper.command, wrapper.workingDirectory),
    );''',
)

replace_once(
    "site/execution-evidence.js",
    '''function obviousShellSuppression(value) {''',
    '''function stepRunsCommandInDirectory(step, command, requiredWorkingDirectory) {
  if (
    step.workingDirectory === requiredWorkingDirectory &&
    step.commands.some((candidate) => shellCommandMatches(candidate, command))
  )
    return true;
  if (step.workingDirectory !== "." || requiredWorkingDirectory === ".") return false;
  const prefix = `cd ${requiredWorkingDirectory} && `;
  return step.commands.some((candidate) => {
    const normalized = normalizeCommand(candidate);
    return (
      normalized.startsWith(prefix) &&
      shellCommandMatches(normalized.slice(prefix.length), command)
    );
  });
}

function obviousShellSuppression(value) {''',
)

replace_once(
    "tests/scoped-remote-validation.test.js",
    '''  test("cyclic package-script wrappers remain non-validating", () => {''',
    '''  test("early-exit package-script segments remain non-validating", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: npm run verify\\n`,
      [{ command: "npm run test:unit", workingDirectory: "." }],
      [
        {
          workingDirectory: ".",
          manager: "npm",
          scripts: { verify: "exit 0 && npm run test:unit", "test:unit": "vitest run" },
        },
      ],
    );

    expect(result.status).toBe("finding");
    expect(result.workflowEvidence[0].matchedPackageScriptEvidence).toEqual([]);
  });

  test("unbounded shell segments keep wrapper evidence unavailable", () => {
    const result = validation(
      `${pullRequestPrefix}      - run: npm run verify\\n`,
      [{ command: "npm run test:unit", workingDirectory: "." }],
      [
        {
          workingDirectory: ".",
          manager: "npm",
          scripts: { verify: "echo setup && npm run test:unit", "test:unit": "vitest run" },
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
    '''  test("keeps matrix lists outside step evidence", () => {''',
    '''  test("maps explicit-cd wrapper steps into fail-closed evidence", () => {
    const path = ".github/workflows/validate.yml";
    const content = `on: [pull_request]\\njobs:\\n  validate:\\n    steps:\\n      - name: Verify app\\n        run: cd packages/app && npm run verify || true\\n`;
    const evidence = remoteExecutionEvidence({
      validationEvidence: wrapperValidation(path, content, "packages/app"),
      workflows: [{ path, content }],
    });

    expect(evidence.failClosed).toEqual(
      expect.objectContaining({
        status: "finding",
        reason: "all-proven-validation-is-fail-open",
      }),
    );
  });

  test("keeps matrix lists outside step evidence", () => {''',
)

replace_once(
    "tests/remote-execution-evidence.test.js",
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
        manager: "npm",''',
    '''function wrapperValidation(path, content, workingDirectory = ".") {
  const result = remoteValidationOutcome({
    workflowPaths: [path],
    workflows: [{ path, content }],
    externalCiPaths: [],
    workflowFetchTruncated: false,
    defaultBranch: "main",
    declaredCommands: [{ command: "npm run test:unit", workingDirectory }],
    packageScripts: [
      {
        workingDirectory,
        manager: "npm",''',
)

replace_once(
    "docs/github-pages-analysis.md",
    '''Schema-v1 `workflowEvidence.matchedCommandEvidence` contains the declared validation commands mechanically proven by the workflow, whether they appear literally in the workflow or are reached through a bounded package-script chain. `matchedPackageScriptEvidence` records the wrapper provenance separately: each entry names the invoked wrapper command, package working directory, script key, and the declared commands reached through that bounded chain. The field is additive within v1 and lets downstream evidence distinguish the workflow step that actually ran from the underlying declared validation commands it proves.''',
    '''Schema-v1 `workflowEvidence.matchedCommandEvidence` contains the declared validation commands mechanically proven by the workflow, whether they appear literally in the workflow or are reached through a bounded package-script chain. `matchedPackageScriptEvidence` records the wrapper provenance separately: each entry names the invoked wrapper command, package working directory, script key, and the declared commands reached through that bounded chain. The bounded chain accepts only same-component package-script references and declared validation commands joined by failure-propagating `&&`; any other shell segment leaves the wrapper unproven rather than being interpreted. The field is additive within v1 and lets downstream evidence distinguish the workflow step that actually ran from the underlying declared validation commands it proves.''',
)

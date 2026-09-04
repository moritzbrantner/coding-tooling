from pathlib import Path

path = Path("src/entry.ts")
source = path.read_text()

import_anchor = 'import { repositoryProgressScoreCommand } from "./repository-progress-score.ts";\n'
import_replacement = import_anchor + 'import { repositoryEvidenceCommand } from "./repository-evidence.ts";\n'
if source.count(import_anchor) != 1:
    raise SystemExit("unexpected repository import anchor")
source = source.replace(import_anchor, import_replacement, 1)

usage_anchor = '  coding-tooling repository metadata [--root <path>] [--json]\n'
usage_replacement = usage_anchor + '  coding-tooling repository evidence [--root <path>] [--validation-report <path>] [--contract-report <path>] [--json]\n'
if source.count(usage_anchor) != 1:
    raise SystemExit("unexpected repository usage anchor")
source = source.replace(usage_anchor, usage_replacement, 1)

old = '''  if (command === "repository") {
    if (argv[1] !== "metadata") return expectationUsage();
    const knownFlags = new Set(["--json", "--root"]);
    for (let index = 2; index < argv.length; index += 1) {
      const value = argv[index]!;
      if (!value.startsWith("--") || !knownFlags.has(value)) return expectationUsage();
      if (value === "--root") {
        if (!argv[index + 1] || argv[index + 1]!.startsWith("--")) return expectationUsage();
        index += 1;
      }
    }
    const targetRoot = resolve(option(argv, "root") ?? repositoryRoot());
    const result = repositoryMetadataCommand(targetRoot);
    console.log(JSON.stringify(result, null, argv.includes("--json") ? 0 : 2));
    return resultExitCode(result.status);
  }
'''
new = '''  if (command === "repository") {
    const action = argv[1];
    if (action !== "metadata" && action !== "evidence") return expectationUsage();
    const knownFlags = new Set(
      action === "evidence"
        ? ["--json", "--root", "--validation-report", "--contract-report"]
        : ["--json", "--root"],
    );
    for (let index = 2; index < argv.length; index += 1) {
      const value = argv[index]!;
      if (!value.startsWith("--") || !knownFlags.has(value)) return expectationUsage();
      if (
        value === "--root" ||
        value === "--validation-report" ||
        value === "--contract-report"
      ) {
        if (!argv[index + 1] || argv[index + 1]!.startsWith("--")) return expectationUsage();
        index += 1;
      }
    }
    const targetRoot = resolve(option(argv, "root") ?? repositoryRoot());
    const result =
      action === "metadata"
        ? repositoryMetadataCommand(targetRoot)
        : repositoryEvidenceCommand(targetRoot, {
            validationReportPath: option(argv, "validation-report"),
            publicContractReportPath: option(argv, "contract-report"),
          });
    console.log(JSON.stringify(result, null, argv.includes("--json") ? 0 : 2));
    return resultExitCode(result.status);
  }
'''
if source.count(old) != 1:
    raise SystemExit("unexpected repository command block")
path.write_text(source.replace(old, new, 1))

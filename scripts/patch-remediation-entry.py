from pathlib import Path

path = Path("src/entry.ts")
source = path.read_text()

import_anchor = 'import { publicContractCommand } from "./public-contract.ts";\n'
import_replacement = import_anchor + 'import { remediationPlanCommand } from "./remediation-plan.ts";\n'
if source.count(import_anchor) != 1:
    raise SystemExit("unexpected remediation import anchor")
source = source.replace(import_anchor, import_replacement, 1)

usage_anchor = '  coding-tooling score [--validation-report <path>] [--json]\n'
usage_replacement = usage_anchor + '  coding-tooling remediation plan [--include-baseline] [--json]\n'
if source.count(usage_anchor) != 1:
    raise SystemExit("unexpected remediation usage anchor")
source = source.replace(usage_anchor, usage_replacement, 1)

command_anchor = '  if (command === "foundation") {\n'
block = '''  if (command === "remediation") {
    if (argv[1] !== "plan") return expectationUsage();
    const unknown = argv.slice(2).filter((value) => !["--include-baseline", "--json"].includes(value));
    if (unknown.length > 0) return expectationUsage();
    const result = remediationPlanCommand(repositoryRoot(), {
      includeBaseline: argv.includes("--include-baseline"),
    });
    console.log(JSON.stringify(result, null, argv.includes("--json") ? 0 : 2));
    return resultExitCode(result.status);
  }

'''
if source.count(command_anchor) != 1:
    raise SystemExit("unexpected remediation command anchor")
source = source.replace(command_anchor, block + command_anchor, 1)
path.write_text(source)

# CLI contract

The CLI is a deterministic interface for humans, CI, coding agents, and higher-level orchestration.

## Commands

\`\`\`bash
coding-tooling inspect [--root <path>] [--json]
coding-tooling check <capability> [--component <name>] [--root <path>] [--json]
coding-tooling affected [--base <git-ref> | --change-manifest <file>] [--root <path>] [--json]
coding-tooling doctor [--root <path>] [--json]
\`\`\`

## Stable capability names

\`\`\`text
format:check
lint
typecheck
build
test
test:unit
test:integration
test:e2e
gate:final
\`\`\`

\`gate:final\` is available only when a component declares a \`check\` script. It represents the complete applicable pre-handoff gate. Changed-surface recommendations are intentionally narrower and do not include it.

## JSON envelope

Every command invoked with \`--json\` returns exactly one JSON object:

\`\`\`json
{
"schemaVersion": 1,
"operation": "check",
"status": "passed",
"durationMs": 123,
"data": {},
"diagnostics": []
}
\`\`\`

\`status\` is one of \`passed\`, \`failed\`, \`unavailable\`, or \`error\`. Do not encode an unavailable capability as passed and do not treat an environment/tool failure as a product-code failure.

## Exit codes

\`\`\`text
0 passed
1 failed
2 unavailable or invalid CLI usage
3 tooling/environment error
\`\`\`

The JSON status remains canonical.

Invalid CLI usage uses operation \`cli\`, status \`error\`, and exit code 2.

## \`inspect\`

\`inspect\` performs non-mutating discovery of repository structure, manifests, lockfiles, declared scripts, and mechanically safe ecosystem capabilities.

## \`check\`

\`check\` executes one deterministic validation capability. Results include component, path, argv command, status, exit code, duration, stdout, and stderr. Verification capabilities such as \`format:check\` are separate from explicit mutation commands.

## \`affected\`

\`affected\` accepts either a Git baseline or an explicit change manifest. The options are mutually exclusive.

A change manifest may be a JSON array of repository-relative paths or an object with a \`files\` (or \`changedFiles\`) array. Paths outside the repository are rejected. This lets a writer such as \`local-refactor\` identify exactly the files it owns without conflating them with a pre-existing dirty worktree.

\`recommendedCapabilities\` is deterministic early feedback. The development workflow still decides validation progression and must run the complete applicable final gate before handoff.

## \`doctor\`

\`doctor\` diagnoses repository access, Git, and runtimes required by discovered capabilities. It does not repair or mutate the environment.

## Boundary with orchestration

This CLI does not create agent runs, retry models, schedule work, choose candidate branches, or own worktree lifecycle.

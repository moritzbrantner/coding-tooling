# Automated-test capabilities

Stable names:

- \`test\` — repository-declared default automated test gate.
- \`test:unit\` — focused, network-free behavior tests.
- \`test:integration\` — tests crossing process, database, filesystem, or service boundaries.
- \`test:component\` — rendered component behavior below the full browser workflow.

Discovery is declaration-first: inspect package scripts or ecosystem manifests and report \`unavailable\` when no matching capability exists. Do not invent a test command from installed dependencies.

Tests should emit a non-zero exit status on failure. Coverage is evidence, not a substitute for behavior assertions, and is collected only when the repository declares it.

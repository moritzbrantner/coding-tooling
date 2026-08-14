# Playwright capability

Stable name: \`test:e2e\`.

The capability maps only to a repository-declared non-interactive \`test:e2e\` script. UI mode remains a human development command.

Expected failure artifacts:

- \`test-results\`
- \`playwright-report\`

The repository owns browser installation, server and service startup, fixtures, ports, setup, and teardown. \`coding-tooling\` executes and reports the declared command; it does not guess or manage that topology.

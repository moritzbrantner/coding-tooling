# Storybook capabilities

Stable executable names:

- `storybook:check` — run the repository-declared Storybook validation gate.
- `test:visual` — run deterministic visual-regression or visual-contract checks when the repository declares them separately.

The tool does not map the interactive `storybook` development script or a build script to a passing validation capability by inference. Repositories with a differently named authoritative Storybook command can map it explicitly through `capabilityCommands` without introducing another semantic capability name.

Expected failure artifacts may include:

- `storybook-static`
- `.generated/storybook`

Generated output must not be committed unless the repository explicitly treats it as a published artifact.

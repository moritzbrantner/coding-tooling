# Storybook capabilities

Stable names:

- \`storybook:build\` — produce a static, non-interactive Storybook build.
- \`test:storybook\` — run the repository's complete Storybook gate, including accessibility when declared.

Recognized declared scripts are listed in \`../catalog.json\`. The tool does not map the interactive \`storybook\` development script to a passing validation capability.

Expected failure artifacts:

- \`storybook-static\`
- \`.generated/storybook\`

Generated output must not be committed unless the repository explicitly treats it as a published artifact.

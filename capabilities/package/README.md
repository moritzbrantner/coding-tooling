# Package validation capability

Stable name: \`package:check\`.

This capability validates package or release shape without publishing. A repository may use it for packaging metadata, a pack or dry run, API/package-surface validation, or another deterministic package qualification check.

The repository declares the command and owns all package-manager-specific behavior. \`coding-tooling\` does not infer a package command from installed dependencies or perform publication.

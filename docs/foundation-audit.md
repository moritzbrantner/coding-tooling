# Foundation audit

`coding-tooling foundation audit --json` is the read-only mechanical audit for repository-foundation adoption.

It deliberately does not execute repository checks, install dependencies, inspect test adequacy, or mix in heuristic findings. The report classifies each audited surface as one of:

- `adopted` — the repository-owned state is present and structurally valid;
- `missing` — the foundation surface has not been adopted;
- `invalid` — the surface is present but violates its deterministic contract;
- `unsupported` — the surface is present in a form this audit cannot verify without broader execution or parsing.

The first report version covers:

- `.coding-tooling.json` schema and required capability declarations;
- repository-owned capability commands that can be resolved from supported components and explicit overrides;
- environment-v1 config/script shape and exact declared toolchain pins;
- installed convention manifest/lock/snapshot integrity;
- Renovate JSON consumer configuration and the shared `coding-agent-conventions` preset.

This result is intended as the stable read-only input for fleet reporting and `platform-upgrader boring-foundation-v1`. Mutation remains owned by the upgrader; heuristic repository analysis remains a separate capability.

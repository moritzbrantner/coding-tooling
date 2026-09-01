# Deterministic rule mechanics — batch 2

This batch adds mechanics only where the corresponding convention is cheap and unambiguous to check without replacing ecosystem-native tools:

- UTF-8/LF repository text hygiene;
- immutable external GitHub Action revisions;
- repository-bounded symlinks;
- case-collision detection.

Secret scanning, ShellCheck, vulnerability/license auditing, container digest policy, schema validation, sanitizers/race detectors, and similar concerns remain delegated to their established ecosystem-native tools and normal `coding-tooling` capabilities/tiers.

# Executable repository contracts

Extend the existing `.repository.toml` with declared authority and lifecycle commands. `summary` is the repository's purpose; existing repository IDs, relationships and schema version remain unchanged. The optional tables let repositories adopt the contract incrementally without inventing a site or an ownership boundary.

```toml
[architecture]
owns = ["corpus/transcript-index"]
consumes = ["media/asr", "foundation/storage"]
must_not_own = ["media/asr", "interpretation/inference"]

[bootstrap]
command = ["bun", "install", "--frozen-lockfile"]
check = ["bun", "run", "build"]
timeout_seconds = 300

[pages]
status = "enabled"
command = ["bun", "run", "pages:build"]
check = ["bun", "run", "pages:check"]
timeout_seconds = 300
```

A repository without Pages declares `[pages]`, `status = "not-applicable"` and a nonempty `reason`; it cannot also declare build commands. Lifecycle commands are argument arrays, run without a shell. Timeouts are bounded to 1–1800 seconds, defaulting to 300. Tables reject unsupported keys and invalid types. Metadata uses native TOML parsing, including quoted strings and comments.

```sh
coding-tooling repository contract --root . --json
coding-tooling repository contract --root . --execute --json
coding-tooling fleet contracts --root .. --json
coding-tooling fleet contracts --root .. --execute --json
```

Without `--execute`, lifecycle declarations have `not-run` status. A successful declaration check does not claim bootstrap or Pages acceptance passed. Missing purpose, architecture, bootstrap and Pages declarations are listed separately as adoption gaps. Explicit Pages N/A retains its reason.

With `--execute`, the source must be clean and committed. Verification captures its exact commit, clones it into a disposable workspace without local Git object sharing, and checks out that commit detached. Bootstrap runs before its acceptance command; Pages build and acceptance run only after bootstrap passes. Each successful command must preserve HEAD and leave committed source and unignored files unchanged. Ignored generated artifacts are permitted. Temporary checkouts are removed, and the original repository is not used as the execution directory.

Source-dependency declarations retain exact revisions and their existing verification report. Bootstrap must materialize declared source dependencies inside the disposable workspace: external local roots are rejected. PATH entries inside source or sibling Git checkouts are removed. Installed toolchains remain available; working-directory isolation is not a filesystem or network sandbox, and absolute command arguments are not rewritten.

The versioned data contracts are `coding-tooling/repository-contract/v1` and `coding-tooling/fleet-repository-contracts/v1`, within the usual CLI envelope. Reports retain command arguments, phase, exit code, signal/error, captured revision, runtime/platform and cleanup provenance. Failed commands are `failed`; unavailable tools and bounded timeouts are `unavailable`; dependent Pages execution is `blocked`. The fleet report separates `missingDeclarations`, `ownershipConflicts`, `sourceRevisionConflicts`, `bootstrapFailures` and `pagesFailures`, with detailed per-repository results for unavailable or unexecuted work.

Ownership constrains authority, not legitimate dependencies. A corpus may consume ASR and own a corpus adapter while explicitly excluding canonical ASR ownership. Exclusions cover the named capability and its `/` descendants. Machine ownership must agree with an existing AGENTS `Owns` declaration; AGENTS `Non-authoritative` boundaries also constrain claims. The fleet reports competing owners of an identical capability, including existing Markdown declarations, without choosing an architectural winner. Different exact source revisions of the same dependency remain a conflict rather than being silently collapsed.

Task-packet reading checks `ownedCapability` against repository and AGENTS exclusions before verification or handoff, and exposes the declared purpose and boundaries. It does not infer authority from implementation text, forbid adapter dependencies, or change the task-packet wire schema. Missing declarations remain visible; architecture decisions stay with repository owners.

This repository's pilot installs its frozen Bun dependencies, starts its actual discovery CLI, builds Pages and runs `pages:check` against `.artifacts/pages`. The acceptance command fingerprints the exact built bytes, checks source-owned HTML entrypoints and relative script/link/image resources, rejects symlinks and escaping paths, and reports external resources as unverified. CI runs the clean-checkout contract and checks the artifact before Pages upload. These structural checks make no browser-behavior, security, coverage or runtime-performance claim.

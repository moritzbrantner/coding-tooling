# GitHub Pages repository preflight

The Pages site is the zero-install remote entry point for `coding-tooling`. A human or coding agent can provide `owner/repository` or a public GitHub URL and receive deterministic structural evidence before cloning the repository.

## Boundary

GitHub Pages is static hosting. The browser therefore reads anonymous GitHub API data only: repository metadata, a recursive Git tree, and a bounded set of text manifests. It does not execute repository code, request a GitHub token, call an LLM, or claim semantic correctness.

The local CLI remains authoritative for `inspect`, `bootstrap plan`, conformance, environment verification, deterministic findings, validation execution, and mutations. Private repositories are intentionally local-only in this first version.

## Output contract

The page returns a `schemaVersion: 1`, `operation: "remote-preflight"` JSON result containing repository provenance, discovered package/Rust/.NET components, declared capabilities, findings, limitations, and an agent handoff with the local command sequence.

Remote findings cover conservative signals such as missing `.coding-tooling.json`, CI, exact Node/Rust pins, dependency-update automation, structural test evidence, and package validation scripts. They do not claim behavioral coverage, security, or runtime performance.

If GitHub truncates the recursive tree, the bounded manifest budget cannot cover all package manifests, or selected text blobs cannot be read, the result is explicitly `incomplete`.

A repository can be deep-linked with `?repo=owner/repository` so a human or agent can share the same preflight entry point.

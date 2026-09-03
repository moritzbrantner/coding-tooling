# GitHub Pages repository preflight

The Pages site is the zero-install remote entry point for `coding-tooling`. A human or coding agent can provide `owner/repository` or a public GitHub URL and receive deterministic structural evidence before cloning the repository.

## Boundary

GitHub Pages is static hosting. The browser therefore reads anonymous GitHub API data only: repository metadata, a recursive Git tree, and a bounded set of text manifests. It does not execute repository code, request a GitHub token, call an LLM, or claim semantic correctness.

The local CLI remains authoritative for `inspect`, `bootstrap plan`, conformance, environment verification, deterministic findings, validation execution, and mutations. Private repositories are intentionally local-only in this first version.

## Output contract

The page returns a `schemaVersion: 1`, `operation: "remote-preflight"` JSON result containing repository provenance, discovered package/Rust/.NET components, declared capabilities, findings, limitations, and an agent handoff with the local command sequence.

Remote findings cover conservative signals such as missing `.coding-tooling.json`, CI, exact Node/Bun/Rust pins, dependency-update automation, structural test evidence, and package validation scripts. Fixture, generated, vendor, build-output, and dependency trees are excluded from component discovery so test data and derived files cannot masquerade as repository toolchains. They do not claim behavioral coverage, security, or runtime performance.

If GitHub truncates the recursive tree, the bounded manifest budget cannot cover all package manifests, or selected text blobs cannot be read, the result is explicitly `incomplete`.

A repository can be deep-linked with `?repo=owner/repository` so a human or agent can share the same preflight entry point.

## `analysis.json` machine interface

The shared browser implementation exports an async `analysisJson(repository, options?)` function from `site/github-analysis.js`. The normal UI and the machine view both call this function, so there is one analysis path rather than duplicated logic.

The Pages machine view is available at:

```text
https://moritzbrantner.github.io/coding-tooling/analysis.json/?repo=owner/repository
```

It renders only the JSON envelope and is intended for browser-capable agents and tools that can execute the page JavaScript.

This is deliberately not described as a conventional HTTP JSON API. GitHub Pages cannot execute server-side code, so a plain `curl` request receives the static HTML shell rather than a dynamically generated `application/json` response. A true HTTP `analysis.json?repo=...` endpoint would require a separate serverless/runtime deployment and should be introduced only if that additional operational dependency is justified.

## `test-coverage.json` observation

The Pages site also exposes an observation-only coverage view:

```text
https://moritzbrantner.github.io/coding-tooling/test-coverage.json/?repo=owner/repository
```

Schema version 1 looks for recognized coverage reports committed on the repository default branch. It currently reads Istanbul `coverage-summary.json` and LCOV `lcov.info` from their common root or `coverage/` locations and normalizes available line, statement, function, and branch totals.

The browser never runs the repository test suite and never treats missing coverage evidence as `0%`. If no recognized report exists, the result is `unavailable`; if a discovered report cannot be read or parsed, or GitHub truncates the repository tree, the result is `incomplete`.

This keeps the first Pages coverage contract conservative. CI-generated but ephemeral GitHub Actions artifacts are intentionally outside schema version 1 because the static browser path does not yet have a deterministic, zero-token artifact-content transport. A later producer protocol can publish a stable machine-readable coverage snapshot without weakening this observation boundary.

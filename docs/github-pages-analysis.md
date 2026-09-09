# GitHub Pages repository preflight

The Pages site is the zero-install remote entry point for `coding-tooling`. A human or coding agent can provide `owner/repository` or a public GitHub URL and receive deterministic structural evidence before cloning the repository.

## Boundary

GitHub Pages is static hosting. The browser therefore reads anonymous GitHub API data only: repository metadata, a recursive Git tree, and a bounded set of text manifests. It does not execute repository code, request a GitHub token, call an LLM, or claim semantic correctness.

The local CLI remains authoritative whenever a command needs repository execution, mutation, local Git history, local environment state, full source analysis, or convention execution. Private repositories remain local-only for this browser surface.

## CLI-style `run.json` interface

The generic Pages command view accepts the same argv shape a caller would pass after the `coding-tooling` executable:

```text
https://moritzbrantner.github.io/coding-tooling/run.json/?repo=owner/repository&argv=inspect%20--json
https://moritzbrantner.github.io/coding-tooling/run.json/?repo=owner/repository&argv=findings%20--json
https://moritzbrantner.github.io/coding-tooling/run.json/?repo=owner/repository&argv=bootstrap%20plan%20--json
https://moritzbrantner.github.io/coding-tooling/run.json/?repo=owner/repository&argv=plan%20--tier%20fast%20--json
https://moritzbrantner.github.io/coding-tooling/run.json/?repo=owner/repository&argv=repository%20metadata%20--json
```

Callers that do not want shell-style quoting can pass repeated `arg` query parameters instead:

```text
https://moritzbrantner.github.io/coding-tooling/run.json/?repo=owner/repository&arg=plan&arg=--tier&arg=fast&arg=--json
```

The browser returns the normal `schemaVersion: 1` CLI result envelope with `operation`, `status`, `durationMs`, `data`, and `diagnostics`. The `coding-tooling` binary prefix is optional in `argv`, and `--json` is accepted even though the view always renders JSON.

The first remote-safe command set is deliberately narrow:

- `inspect --json` mirrors mechanical component, technology, and capability discovery from the GitHub snapshot.
- `findings --json` returns conservative remote structural findings. High-priority remote findings make the command fail, matching the CLI convention that blocking findings are not a passing result.
- `bootstrap plan --json` turns those structural findings into a non-mutating remote action plan.
- `plan --tier <name> [--component <name>] --json` resolves repository-declared/default validation capabilities without executing them. It honors root `.coding-tooling.json` tiers, required/optional capabilities, and capability-command overrides. Installed convention execution remains local-only and is called out in diagnostics.
- `repository metadata --json` returns GitHub/default-branch repository metadata plus discovered components and technologies.

Every other CLI argv is still accepted by the URL surface, but fails closed with `status: "unavailable"`, a `remote-command-unavailable` diagnostic, the exact local command to run, and the supported remote alternatives. This makes the URL a stable entry point without pretending that static hosting can run builds, tests, Git operations, dependency installation, environment checks, PR integration, code generation, or mutations.

The generic browser implementation lives in `site/remote-command.js`. `remoteCommand(repository, argv, options?)` performs GitHub loading, while `remoteCommandFromSnapshot(snapshot, argv, now?)` is the deterministic pure dispatcher used by tests.

## Remote preflight output contract

The original repository analysis page returns a `schemaVersion: 1`, `operation: "remote-preflight"` JSON result containing repository provenance, discovered package/Rust/.NET components, declared capabilities, findings, limitations, and an agent handoff with the local command sequence.

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

This is deliberately not described as a conventional HTTP JSON API. GitHub Pages cannot execute server-side code, so a plain `curl` request receives the static HTML shell rather than a dynamically generated `application/json` response. The same limitation applies to `run.json`. A true HTTP endpoint would require a separate serverless/runtime deployment and should be introduced only if that additional operational dependency is justified.

## `test-coverage.json` observation

The Pages site also exposes an observation-only coverage view:

```text
https://moritzbrantner.github.io/coding-tooling/test-coverage.json/?repo=owner/repository
```

Schema version 1 looks for recognized coverage reports committed on the repository default branch. It currently reads Istanbul `coverage-summary.json` and LCOV `lcov.info` from their common root or `coverage/` locations and normalizes available line, statement, function, and branch totals.

The browser never runs the repository test suite and never treats missing coverage evidence as `0%`. If no recognized report exists, the result is `unavailable`; if a discovered report cannot be read or parsed, or GitHub truncates the repository tree, the result is `incomplete`.

This keeps the first Pages coverage contract conservative. CI-generated but ephemeral GitHub Actions artifacts are intentionally outside schema version 1 because the static browser path does not yet have a deterministic, zero-token artifact-content transport. A later producer protocol can publish a stable machine-readable coverage snapshot without weakening this observation boundary.

## Remote CI validation evidence

Remote preflight distinguishes automation presence from mechanically evidenced validation. GitHub Actions workflow names do not count as validation by themselves. A workflow satisfies the v1 signal only when its inspected YAML text shows a pull-request or default-branch trigger and also invokes a repository validation command discovered from component capabilities or the coding-tooling Action seam.

Deployment/release-only workflows therefore remain automation without proven validation. Supported external CI configuration is reported as `unsupported`/external rather than as missing CI because Pages does not execute or interpret those providers. If the bounded GitHub workflow evidence cannot be inspected completely, validation evidence is `incomplete`, never satisfied or absent.

This check is structural and non-executing. Hosted check conclusions, branch protection, and whether CI actually passed remain separate evidence.

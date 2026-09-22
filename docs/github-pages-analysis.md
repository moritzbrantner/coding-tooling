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

Remote findings cover conservative signals such as missing `.coding-tooling.json`, CI, exact Node/Bun/Rust pins, dependency-update automation, structural test evidence, and package validation scripts. They also flag Pages workflows that explicitly build a production-only public runtime/base-path variant without browser/runtime validation consuming the produced artifact. Fixture, generated, vendor, build-output, and dependency trees are excluded from component discovery so test data and derived files cannot masquerade as repository toolchains. They do not claim behavioral coverage, security, or runtime performance.

If GitHub truncates the recursive tree, the bounded manifest budget cannot cover all package manifests, or selected text blobs cannot be read, the result is explicitly `incomplete`.

A repository can be deep-linked with `?repo=owner/repository` so a human or agent can share the same preflight entry point.

## `analysis.json` machine interface

The shared browser implementation exports an async `analysisJson(repository, options?)` function from `site/github-analysis.js`. The normal UI and the machine view both call this function, so there is one analysis path rather than duplicated logic.

The Pages machine view is available at:

```text
https://moritzbrantner.github.io/coding-tooling/analysis.json/?repo=owner/repository
```

It renders only the JSON envelope and is intended for browser-capable agents and tools that can execute the page JavaScript.

### Exact revision pinning

Repository-backed Pages operations accept an optional `ref=<branch|tag|sha>` source selector. The ref is resolved through GitHub to one exact 40-character commit SHA before repository tree evidence is read. Responses expose the requested ref, resolved SHA, and—when available—a canonical URL pinned to that SHA.

`ref` changes only the repository revision being observed. It does not select a different analyzer, increase evidence authority, or replace exact-head repository CI. Omitting `ref` preserves the existing default-branch behavior.

The machine discovery document now describes operation parameters structurally, including requiredness, repeatability, enum values, bounds, authority, and completeness. Agents should consume those fields rather than parsing prose or URL templates.

### Canonical result envelope

Registry-driven agents should use the canonical URLs from `agent-tool.json`, which opt into `envelope=1`. These views return the shared `coding-tooling/result-envelope/v1` shape:

```text
schemaVersion
operation
status
durationMs
data
diagnostics
```

The transport status remains one of `passed | failed | unavailable | error`. Domain evidence state stays inside `data`, with `data.evidence.complete` distinguishing complete evidence from bounded or incomplete observation. Existing browser URLs without `envelope=1` retain their legacy payload shapes for compatibility.

### Parameterized analysis projection

The unparameterized `analysis.json/?repo=owner/repository` path remains the original `remote-preflight` contract. Tailoring begins only when an analysis parameter is present, at which point the view returns `operation: "remote-preflight-query"`.

Supported parameters are deliberately bounded:

- `view=full|agent` selects the original rich evidence shape or a compact agent-first projection.
- repeated `focus=` values select deterministic evidence families: `architecture`, `automation`, `browser`, `dependencies`, `environment`, `governance`, `mobile`, `performance`, or `testing`;
- repeated `component=` values select discovered components by exact name or path; `scope=` remains a compatibility alias;
- `min-severity=low|medium|high` and `limit=1..100` bound the finding surface;
- `finding=REMOTE-...` drills into one existing remote finding;
- `base=`, optional `head=`, repeated `changed-file=`, and optional `tier=` compose the existing change-aware Pages analyzer into the result rather than duplicating compare/component logic.

Examples:

```text
https://moritzbrantner.github.io/coding-tooling/analysis.json/?repo=owner/repository&view=agent&focus=testing&min-severity=medium
https://moritzbrantner.github.io/coding-tooling/analysis.json/?repo=owner/repository&view=agent&component=packages/app&limit=5
https://moritzbrantner.github.io/coding-tooling/analysis.json/?repo=owner/repository&view=agent&base=main&head=feature&tier=fast
https://moritzbrantner.github.io/coding-tooling/analysis.json/?repo=owner/repository&view=agent&changed-file=src/app.ts&changed-file=tests/app.test.ts
```

The projection never creates a new finding or evidence oracle. Focus values classify existing remote finding families, component filters only exact discovered components and does not guess finding ownership, and change context is delegated to the existing `affected` implementation. Unknown parameters, focus values, components, or invalid bounds fail closed.

The compact agent view retains the source repository/revision, selected findings, compact component capabilities, explicit limitations, local handoff, optional change-aware evidence, and canonical drill-down links back to the full analysis, the strongest finding, and `affected.json`.

This is deliberately not described as a conventional HTTP JSON API. GitHub Pages cannot execute server-side code, so a plain `curl` request receives the static HTML shell rather than a dynamically generated `application/json` response. The same limitation applies to `run.json`. A true HTTP endpoint would require a separate serverless/runtime deployment and should be introduced only if that additional operational dependency is justified.


## Conventional HTTP analysis transport

GitHub Pages remains the browser presentation surface, but plain HTTP clients should not depend on
the client-rendered `analysis.json/` route. The deployable Cloudflare Worker in
`worker/analysis-worker.js` exposes the same analysis through a conventional
`application/json` response at `/analysis.json`.

The Worker imports `analysisQueryJson` and therefore reuses the existing `analysis-query.js`,
`github-analysis.js`, and result-envelope code. It is a transport adapter rather than a second
analyzer or evidence authority.

Callers discover the production transport through the static contract:

```text
https://moritzbrantner.github.io/coding-tooling/analysis-endpoint.json
```

When that document reports `status: "available"`, its `hrefTemplate` is the preferred
machine-to-machine entry point. Until a permanent Worker URL is configured, browser-capable callers
may continue to use the Pages view and plain HTTP agents should fall back to direct repository
inspection rather than treating browser HTML as JSON.

The HTTP adapter deliberately does not reuse caller authentication. Incoming `Cookie` and
`Authorization` values are never forwarded. Public repositories work with anonymous GitHub API
access; deployments may optionally configure a server-side Worker secret named `GITHUB_TOKEN` to
raise GitHub API limits. That secret is attached only to requests whose hostname is
`api.github.com`.

Deployment is configured by `wrangler.jsonc`:

```text
bun run analysis:worker:check
bun run analysis:worker:deploy
```

The main-branch deployment workflow uses repository secrets `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`. `ANALYSIS_GITHUB_TOKEN` is optional and, when present, is stored as the
Worker's `GITHUB_TOKEN` secret. After deployment, Wrangler's structured output is used to discover
the public `workers.dev` base URL, the live endpoint is smoke-tested, and the workflow dispatches
the Pages workflow with that URL. Pages then publishes `analysis-endpoint.json` with
`status: "available"` and the conventional HTTP `hrefTemplate`. A repository variable named
`ANALYSIS_API_BASE_URL` remains an optional manual override/fallback for the Pages build.

For a first private preview, Wrangler 4.102.0 or newer can provision a temporary Worker account
without existing Cloudflare credentials:

```text
bun run analysis:worker:deploy:temporary
```

The printed claim URL is a bearer credential and must not be copied into public CI logs, issues, or
repository files. Temporary deployments must be claimed before their deadline to become permanent.


## `test-coverage.json` observation

The Pages site also exposes an observation-only coverage view:

```text
https://moritzbrantner.github.io/coding-tooling/test-coverage.json/?repo=owner/repository
```

Schema version 1 looks for recognized coverage reports committed on the repository default branch. It currently reads Istanbul `coverage-summary.json` and LCOV `lcov.info` from their common root or `coverage/` locations and normalizes available line, statement, function, and branch totals.

The browser never runs the repository test suite and never treats missing coverage evidence as `0%`. If no recognized report exists, the result is `unavailable`; if a discovered report cannot be read or parsed, or GitHub truncates the repository tree, the result is `incomplete`.

This keeps the first Pages coverage contract conservative. CI-generated but ephemeral GitHub Actions artifacts are intentionally outside schema version 1 because the static browser path does not yet have a deterministic, zero-token artifact-content transport. A later producer protocol can publish a stable machine-readable coverage snapshot without weakening this observation boundary.

## Remote CI validation evidence

Remote preflight distinguishes automation presence from mechanically evidenced validation. GitHub Actions workflow names do not count as validation by themselves. A workflow satisfies the v1 signal only when its inspected YAML text shows a pull-request or default-branch trigger and also invokes a repository validation command discovered from component capabilities, a bounded same-component Bun/npm package-script wrapper proven from fetched `package.json` evidence, or the coding-tooling Action seam.

Reusable-workflow discovery keeps caller inputs scoped to the job's `with` mapping. Its `inputs` record retains expression strings and uses `null` for values the bounded scalar parser cannot resolve, such as block scalars. These explicit inputs suppress callee defaults; only absent inputs inherit defaults. Materialization substitutes known literal values and reports referenced unresolved names in `unresolvedInputs`, keeping an unresolved command from being credited as validation. YAML comments and sibling mappings such as `secrets` do not supply input values.

Schema-v1 `workflowEvidence.matchedCommandEvidence` contains the declared validation commands mechanically proven by the workflow, whether they appear literally in the workflow or are reached through a bounded package-script chain. `matchedPackageScriptEvidence` records the wrapper provenance separately: each entry names the invoked wrapper command, package working directory, script key, and the declared commands reached through that bounded chain. The bounded chain accepts only same-component package-script references and declared validation commands joined by failure-propagating `&&`; any other package-script segment leaves the wrapper unproven rather than being interpreted. Workflow wrapper invocations must target that component directly: npm/Bun execution-scope options such as `--workspace` are not attached to the current component, while arguments after an explicit `--` passthrough remain part of the selected script invocation. The field is additive within v1 and lets downstream evidence distinguish the workflow step that actually ran from the underlying declared validation commands it proves.

Deployment/release-only workflows therefore remain automation without proven validation. Supported external CI configuration is reported as `unsupported`/external rather than as missing CI because Pages does not execute or interpret those providers. If the bounded GitHub workflow evidence cannot be inspected completely, validation evidence is `incomplete`, never satisfied or absent.

This check is structural and non-executing. Hosted check conclusions, branch protection, and whether CI actually passed remain separate evidence.

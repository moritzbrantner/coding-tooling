# Language analysis providers

`coding-tooling` should reuse authoritative deterministic language tooling instead of reimplementing language semantics. The analysis layer normalizes evidence from those tools; it does not make their diagnostics into repository policy automatically.

## Boundary

The analysis pipeline has three deliberately separate concepts:

1. **Provider facts and diagnostics** come from a language-native engine such as the TypeScript compiler, Roslyn, rustc/Clippy, rust-analyzer, or a syntax-only parser such as Tree-sitter.
2. **Expectations/findings** are `coding-tooling` repository checks. A provider diagnostic becomes a `CT-*` finding only through an explicit, versioned adapter with known semantics.
3. **Actions** are deterministic remediations. A provider code action is exposed or applied only when its edit contract can be validated, previewed, applied idempotently, and re-analyzed.

This keeps language understanding delegated to the strongest trustworthy implementation while preserving `coding-tooling` as the stable machine-readable interface for agents and CI.

## Analysis depth

Providers advertise capabilities rather than implying that all analysis is equally strong:

- `syntax`: parsed source structure is available;
- `semantic`: names/types/symbol relationships are resolved by the language implementation;
- `diagnostics`: the provider emits deterministic diagnostics;
- `code-actions`: the provider can offer deterministic source edits.

A provider also reports `applied`, `not-applicable`, `unavailable`, or `failed`. Unsupported or unavailable semantic analysis must never be reported as a clean result.

## TypeScript provider

The current TypeScript provider uses the repository's pinned TypeScript 7 native compiler. TypeScript 7.0 does not expose the previous stable Compiler API, so the provider invokes the pinned compiler with no-emit/non-pretty output and normalizes its diagnostics. This avoids silently analyzing TypeScript 7 projects with TypeScript 6 semantics or depending on the transitional unstable API.

The normalized provider contract is independent of that transport choice, so the implementation can move to the new stable TypeScript API when it is available without changing consumers.

The TypeScript provider currently advertises no `code-actions` capability. A type error can be deterministic evidence without there being one mechanically correct repair.

## Roslyn-backed .NET provider

`dotnet-roslyn` discovers SDK-style C# project files and delegates project-aware semantic analysis to the installed .NET SDK/MSBuild/Roslyn build pipeline. It invokes each project with `--no-restore`, deterministic compilation, full diagnostic paths, and no provider-owned package installation.

The provider normalizes compiler and analyzer diagnostics into the same provider/code/severity/project/location envelope as TypeScript. Its reported provider version is the installed .NET SDK version that owns the invoked Roslyn toolchain.

The boundary is conservative:

- no `.csproj` means `not-applicable`;
- missing `dotnet`, an unsupported target SDK, or a missing `project.assets.json` means `unavailable`, not clean;
- a nonzero build that yields normal compiler/analyzer diagnostics remains an `applied` analysis result carrying those diagnostics;
- an unexplained build failure with no normalizable diagnostics is `failed`;
- the provider uses `--no-restore`, so analysis never decides to contact package sources or repair dependency state;
- it advertises no code actions yet. A direct Roslyn workspace bridge is deferred until richer symbol queries or provider-native fixes justify that dependency and lifecycle.

Running the compiler can update ordinary ignored build artifacts such as `bin/` and `obj/`; it does not modify authored source files.

## Diagnostic-to-finding adapters

Provider diagnostics enter the `CT-*` finding stream only through explicit, versioned mappings.

`typescript-type-assignability@1` promotes only TypeScript `TS2322` assignment-compatibility diagnostics. `dotnet-type-assignability@1` is its Roslyn counterpart and promotes only `CS0029` implicit-conversion diagnostics.

Both adapters follow the same contract:

- one advisory `CT-*` finding is emitted per affected file;
- repeated matching diagnostics in a file are aggregated as analysis evidence;
- the finding ID depends on the file and versioned requirement, not source line numbers, so unrelated line movement does not renumber it;
- provider ID, provider version, diagnostic code, message, project, and source location remain attached as `analysisEvidence`;
- unrelated provider diagnostics remain visible through `coding-tooling analyze` but are not silently promoted into repository findings;
- the finding remains a warning unless a repository explicitly chooses stronger enforcement.

Coverage for each semantic adapter is based on whether its provider actually analyzed projects, not merely on the presence of source files. An unrestored .NET project therefore counts as a discovered project with `unavailable` semantic coverage rather than as not applicable or clean.

## Prepared calibration

Compiler-backed detectors may need deterministic environment preparation before the provider can run while the provider itself must remain conservative. Calibration supports a small closed preparation set rather than arbitrary shell hooks.

The first preparation is `dotnet-restore`. A calibration case names one project inside its committed fixture. Calibration copies the fixture to a temporary directory, restores that copy with the installed SDK, evaluates findings there, and removes the temporary copy afterward. The committed fixture remains source-only; generated `obj/`/`bin/` state is never checked in, and normal `dotnet-roslyn` analysis still uses `--no-restore`.

If the SDK or restore preparation is unavailable, the calibration case is reported as unavailable rather than being scored as a false negative. Overall calibration becomes `unavailable` when no correctness regression exists but one or more required prepared cases cannot run in the current environment.

Calibration now performs one full finding analysis per case and derives active findings from their dispositions instead of analyzing the same fixture twice. This keeps compiler-backed calibration bounded without weakening evidence.

## Deterministic action contract

Provider actions are separate from diagnostics and findings. An `AnalysisAction` has a stable `CTA-*` semantic identity and one or more whole-file replacements. Each replacement carries:

- repository-relative path;
- SHA-256 of the exact source state the provider analyzed;
- SHA-256 of the proposed result;
- complete replacement content.

Application is guarded and transactional:

- if the file still has the `beforeSha256`, the replacement may be applied;
- if it already has the `afterSha256`, the replacement is an idempotent no-op;
- any other content is a conflict rather than an overwrite;
- escaping paths and symbolic-link traversal are rejected;
- all replacements are preflighted before any write;
- a later write failure rolls back earlier writes;
- an optional `diagnostic-absent` postcondition re-runs the originating provider and rolls the action back if the declared diagnostic remains.

This contract intentionally uses whole-file guarded replacements rather than naked line/offset edits. Provider-native edits can still be converted into a desired document, but the mutation boundary is anchored to exact before/after content rather than stale source coordinates.

`coding-tooling analyze` exposes an `actions` collection in its machine-readable result. Providers should leave it empty unless they can produce a deterministic repair; the existence of a diagnostic does not imply that an action exists.

## Next independently implementable slices

### 1. First provider-native action

Once a provider can expose a mechanically unambiguous native fix, translate it into the guarded action contract and dogfood preview/apply/re-analyze behavior. Do not synthesize missing business logic merely because a declaration is incomplete.

### 2. Rust provider

Prefer Cargo/rustc/Clippy facts for batch verification and introduce rust-analyzer only for semantic queries that those interfaces do not expose cleanly. Keep existing conservative structural Rust expectations until a richer provider proves stronger evidence.

### 3. Syntax fallback

Introduce Tree-sitter only for portable, syntax-level facts where no richer provider is available. Syntax-derived evidence must remain distinguishable from compiler-resolved semantic evidence.

## Extraction criterion

Keep this layer inside `coding-tooling` while its primary consumer is repository analysis and findings. Extract a separate code-analysis component only when multiple independent consumers need the raw normalized facts/providers without the rest of `coding-tooling`.

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

## First diagnostic-to-finding adapter

`typescript-type-assignability@1` is the first explicit provider-to-expectation mapping. It promotes only TypeScript `TS2322` assignment-compatibility diagnostics.

The adapter is deliberately narrow:

- one advisory `CT-*` finding is emitted per affected file;
- repeated `TS2322` diagnostics in a file are aggregated as analysis evidence;
- the finding ID depends on the file and versioned requirement, not source line numbers, so unrelated line movement does not renumber it;
- provider ID, provider version, diagnostic code, message, project, and source location remain attached as `analysisEvidence`;
- unrelated TypeScript diagnostics remain visible through `coding-tooling analyze` but are not silently promoted into repository findings;
- the finding remains a warning unless a repository explicitly chooses stronger enforcement.

Coverage for the adapter is based on whether the TypeScript provider actually analyzed projects, not merely on the presence of `.ts` files.

## Next independently implementable slices

### 1. Deterministic code-action contract

Add normalized action metadata separately from diagnostics. Start only with provider-native edits that can be previewed without mutation, applied idempotently, and verified by re-running the originating diagnostic. Never synthesize missing business logic merely because a declaration is incomplete.

### 2. Roslyn provider

Add a narrow .NET bridge that loads the repository solution/project with Roslyn and emits the same normalized envelope. Start with compiler diagnostics and analyzer diagnostics; add Roslyn code fixes only after the action contract exists.

### 3. Rust provider

Prefer Cargo/rustc/Clippy facts for batch verification and introduce rust-analyzer only for semantic queries that those interfaces do not expose cleanly. Keep existing conservative structural Rust expectations until a richer provider proves stronger evidence.

### 4. Syntax fallback

Introduce Tree-sitter only for portable, syntax-level facts where no richer provider is available. Syntax-derived evidence must remain distinguishable from compiler-resolved semantic evidence.

## Extraction criterion

Keep this layer inside `coding-tooling` while its primary consumer is repository analysis and findings. Extract a separate code-analysis component only when multiple independent consumers need the raw normalized facts/providers without the rest of `coding-tooling`.

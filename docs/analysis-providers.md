# Language analysis providers

`coding-tooling` should reuse authoritative deterministic language tooling instead of reimplementing language semantics. The analysis layer normalizes evidence from those tools; it does not make their diagnostics into repository policy automatically.

## Boundary

The analysis pipeline has three deliberately separate concepts:

1. **Provider facts and diagnostics** come from a language-native engine such as the TypeScript Compiler API, Roslyn, rustc/Clippy, rust-analyzer, or a syntax-only parser such as Tree-sitter.
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

## First slice

The initial implementation adds:

- a language-provider contract with capability, status, version, project, and diagnostic provenance;
- a TypeScript provider using the repository's pinned TypeScript Compiler API directly;
- normalized TypeScript diagnostics with `TS*` codes, severity, project, file, and source span;
- `coding-tooling analyze [--json]` / `bun run analyze`;
- tests proving semantic compiler errors, clean projects, and not-applicable projects.

The command fails when the compiler reports an error diagnostic, but it does not change `findings` or normal validation tiers yet.

## Next independently implementable slices

### 1. Diagnostic-to-finding adapters

Add a small explicit registry mapping selected provider diagnostics to versioned expectations. Do not convert every compiler diagnostic blindly. Preserve provider ID/version/code and source span as finding evidence, and calibrate each mapping against real repositories before enforcement.

### 2. Deterministic code-action contract

Add normalized action metadata separately from diagnostics. Start only with provider-native edits that can be previewed without mutation, applied idempotently, and verified by re-running the originating diagnostic. Never synthesize missing business logic merely because a declaration is incomplete.

### 3. Roslyn provider

Add a narrow .NET bridge that loads the repository solution/project with Roslyn and emits the same normalized envelope. Start with compiler diagnostics and analyzer diagnostics; add Roslyn code fixes only after the action contract exists.

### 4. Rust provider

Prefer Cargo/rustc/Clippy facts for batch verification and introduce rust-analyzer only for semantic queries that those interfaces do not expose cleanly. Keep existing conservative structural Rust expectations until a richer provider proves stronger evidence.

### 5. Syntax fallback

Introduce Tree-sitter only for portable, syntax-level facts where no richer provider is available. Syntax-derived evidence must remain distinguishable from compiler-resolved semantic evidence.

## Extraction criterion

Keep this layer inside `coding-tooling` while its primary consumer is repository analysis and findings. Extract a separate code-analysis component only when multiple independent consumers need the raw normalized facts/providers without the rest of `coding-tooling`.

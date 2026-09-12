# Convergence rule registry

`coding-tooling` exposes every deterministic convergence mutation through a first-class rule identity. The registry makes mechanical code generation, scaffolding, refactoring, and normalization inspectable and independently controllable without hiding the detector or evidence that motivated the mutation.

## Commands

```sh
coding-tooling convergence rules list --json
coding-tooling convergence rules describe normalizer.oxlint-safe-fix --json
coding-tooling convergence rules disable normalizer.oxlint-safe-fix --json
coding-tooling convergence rules suggest scaffold.typescript-source-test --json
coding-tooling convergence rules disable refactor.typescript-barrel-export --json
coding-tooling convergence rules enable normalizer.oxlint-safe-fix --json
```

The explicit form is also available:

```sh
coding-tooling convergence rules set <id> <disabled|suggest|apply> --json
```

`list` is the canonical machine-readable inventory for CLI consumers, agents, and the GitHub Pages explorer. It reports the rule kind, source, implementation location, technologies, applicability, default mode, effective mode, and rule-specific details.

## Modes

Every rule has one of three modes:

- `apply` — deterministic mutation is permitted. This is the default and preserves existing convergence behavior.
- `suggest` — detection and deterministic planning remain available, but mutation is withheld.
- `disabled` — automatic mutation is withheld. The underlying detector remains active and its finding remains visible.

`disabled` is intentionally not a suppression mechanism. A repository that disables automatic missing-test scaffolding still receives the missing-test finding. Convergence reaches a partial fixed point and returns that finding as explicit handoff work rather than pretending the repository is clean.

## Configuration

Rule modes live in the ordinary schema-v1 `.coding-tooling.json` policy file:

```json
{
  "schemaVersion": 1,
  "convergence": {
    "rules": {
      "normalizer.oxlint-safe-fix": "disabled",
      "scaffold.typescript-source-test": "suggest",
      "refactor.typescript-barrel-export": "disabled"
    }
  }
}
```

Unknown mode values and malformed rule IDs fail configuration validation. Unconfigured rules use `apply`.

Configured IDs must also resolve to real convergence rules. The closed scaffold, structured-refactor, and normalizer namespaces reject unknown IDs directly. Generator IDs are dynamic because convention and repository-local generators contribute to the effective catalog, so generator policy is reconciled against that catalog before direct generator mutation. A typo such as `generator.sampl = disabled` therefore cannot silently leave `generator.sample` at the default `apply` mode: generation fails closed instead.

`coding-tooling convergence rules list --json` reports dynamic stale entries in `reconciliation.unknownConfiguredRuleIds` and returns a failing result until the policy is corrected. A rule may still be configured when it is currently not applicable; applicability and rule identity are deliberately separate concepts.

## Rule namespaces

The registry currently has four mutation namespaces:

- `generator.<generator-id>` — installed convention generators and repository-local generators. The effective generator catalog remains the source of truth for available generator IDs.
- `scaffold.<expectation-id>` — deterministic scaffolds emitted by findings. The detector remains authoritative for whether the condition exists.
- `refactor.<operation-id>` — closed structured source transformations that can also be used inside generators.
- `normalizer.<adapter-id>` — closed canonicalization/refactoring adapters.

The first structured refactor rule is `refactor.typescript-barrel-export`. It controls the existing narrow operation that inserts one exact TypeScript re-export into an export-only barrel. A generator may remain enabled while this refactor is separately set to `suggest` or `disabled`; in that case generation planning succeeds but application is withheld before any mutation occurs.

The built-in normalizer IDs are:

- `normalizer.oxfmt`
- `normalizer.oxlint-safe-fix`
- `normalizer.rustfmt`
- `normalizer.dotnet-format`

The current deterministic Bun/TypeScript missing-test scaffold is `scaffold.typescript-source-test`.

## Execution boundary

Rule configuration controls mutation, not observation.

```text
repository evidence
  -> detectors / findings
  -> rule lookup
     apply    -> deterministic mutation
     suggest  -> exact plan / handoff only
     disabled -> finding / handoff only
  -> re-observe repository state
  -> permitted normalization rules
  -> verification
```

Generators in `suggest` or `disabled` mode still support deterministic planning through `coding-tooling generate plan`; direct generation refuses to mutate and reports `convergence-rule-withheld`. The same pre-mutation gate applies when a generator plan requires a structured `refactor.*` rule that is not in `apply` mode.

Scaffold rules in `suggest` or `disabled` mode are removed from automatic deterministic-scaffold execution but remain in remediation output with their exact scaffold command and effective rule mode.

Normalizer rules are discovered normally in every mode. Only `apply` normalizers participate in the two-pass idempotence proof. Withheld normalizers remain visible in normalization evidence rather than being silently omitted.

## Safety properties

The registry does not add an arbitrary plugin execution surface. Generator descriptors remain restricted, scaffold implementations remain detector-owned, structured refactors remain the closed allowlisted source mutations, and normalizers remain the closed allowlisted adapters already accepted by deterministic normalization.

Malformed, unknown, or stale mutation policy fails closed at the relevant execution boundary rather than falling through to `apply`. Registry reconciliation remains observational: it reports stale policy but does not rewrite or suppress findings automatically.

Generated application files remain ordinary user-owned repository code. Disabling a generator later does not reclaim or rewrite files that were generated earlier.

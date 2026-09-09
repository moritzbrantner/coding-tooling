# Evidence quality

`coding-tooling` should improve trust by strengthening the evidence behind existing checks, not by multiplying checks that restate the same fact.

Every registered expectation publishes an `evidenceContract` through `coding-tooling findings --json`.

The contract contains:

- `basis` — `configuration`, `syntax`, `structural`, or `semantic`;
- `oracle` — the concrete deterministic source that owns the fact, such as the TypeScript compiler, Roslyn, Cargo metadata plus the filesystem, or a bounded static graph;
- `independenceKey` — the evidence family used to identify correlated checks;
- `proves` — the narrow property the detector can establish;
- `limitations` — properties that the detector explicitly does not establish.

## Do not double-count correlated evidence

Two green signals are not two independent confirmations when both derive from the same oracle or evidence family. Consumers should treat matching `independenceKey` values as correlated evidence and must not increase confidence merely because the same underlying fact is exposed through several views.

For example, a compiler diagnostic and a `CT-*` finding adapted from that same compiler diagnostic are one semantic observation with two representations. The finding adds policy identity and lifecycle metadata; it does not create a second oracle.

## Confidence comes from evidence, not adjectives

The trusted finding stream does not assign a universal `high` / `medium` / `low` confidence score to a detector. Evidence quality is inspectable instead:

1. the basis and authoritative oracle describe how strong the observation can be;
2. calibration records known false positives and false negatives for the detector contract;
3. coverage records whether the detector actually ran over the relevant subjects;
4. limitations prevent structural or syntactic evidence from being presented as behavioral proof.

Autonomous remediation should remain conservative: effectively zero known false positives for the relevant calibrated contract is more important than maximizing recall.

## Determinism of the analyzer

Determinism is a property of the validator itself. Re-analyzing the same repository state with the same configuration and toolchain/provider state must produce the same semantic detector output. Incidental telemetry such as duration is not semantic evidence and must not affect finding identity or ordering.

The detector registry contract therefore re-runs the detector set against the same fixture and compares the complete raw findings, not merely their counts or IDs.

## Convergence boundary

This evidence model is intended to make later autonomous convergence simpler rather than larger. A convergence loop should consume the strongest unresolved evidence, repair one bounded problem, re-run the authoritative checks, and stop when the remaining state is clean, explicitly unsupported, unavailable, or deliberately accepted. It should not create additional checks merely to manufacture more green signals.

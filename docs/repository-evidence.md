# Repository evidence envelope v1

`coding-tooling repository evidence` composes existing repository evidence into one machine-readable document without creating a new score, threshold, or merge authority.

The envelope version is `coding-tooling/repository-evidence/v1`.

## Sources

The document references four existing evidence producers:

- **foundation** — the repository foundation audit and its component statuses;
- **merge** — repository merge readiness, blockers, and protection evidence;
- **validation** — an optional existing `coding-tooling run` report;
- **public contract** — an optional existing `coding-tooling contract` report.

Repository metadata and the current Git revision are included as identity/provenance evidence.

## Usage

```sh
coding-tooling repository evidence --json

coding-tooling repository evidence \
  --validation-report .artifacts/coding-tooling/full.json \
  --contract-report .artifacts/coding-tooling/public-contract.json \
  --json
```

Supplying neither report is valid. The corresponding source is emitted as `state: "not-supplied"`; absence is never converted to passing evidence.

## Provenance and stale evidence

Supplied report files are hashed with SHA-256 and retain their report path. Validation reports must identify the same repository root as the envelope. Public-contract reports record a Git revision, so when both the current checkout and report have revisions, they must match exactly. A stale public-contract report makes envelope composition fail rather than silently describing old evidence as current.

The current `coding-tooling run` report does not yet carry a Git revision. The envelope therefore records its root binding and immutable report digest but does not claim revision binding that the producer does not provide. Adding exact validation revision provenance belongs in the run-report producer rather than being guessed here.

## Status semantics

The command status answers only whether the evidence document could be composed correctly. A successfully composed envelope can contain a failed foundation audit, `not-ready` merge readiness, or a failed validation report. Those remain source facts for consumers to interpret.

This distinction is deliberate: `repository-evidence/v1` is an evidence transport contract, not a second policy engine. `pr eligibility`, merge readiness, public-contract enforcement, and repository validation retain ownership of their existing decisions.

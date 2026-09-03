# Repository score history

`coding-tooling/score-history/v1` retains the repository progress score by commit without writing generated evidence back to `main`.

## Storage boundary

The `Publish Score History` workflow runs for `main` and persists `history.json` on the dedicated `score-history` branch. The persistence branch is data-only: `history.json` is the only tracked file, and the workflow verifies that invariant after every publication.

`score-history` has an independent root rather than inheriting the authored repository tree or `main` history. When the workflow encounters a legacy persistence branch that still contains repository files, it preserves the updated history document, rewrites the branch once as an orphan root containing only `history.json`, and then resumes ordinary non-force history commits on later runs.

This keeps generated history structurally isolated from authored source while making it durable, reviewable, and directly readable by GitHub Pages and coding agents. The workflow is triggered only by `main` pushes or explicit dispatch, so persistence commits do not recursively invoke repository validation or history publication.

Each main commit appears at most once. Re-running the workflow for the same commit replaces that entry instead of appending a duplicate. The document retains the latest 1,000 commit snapshots by chronological instant. Commit timestamps are normalized to UTC when history is written, and equal instants are ordered deterministically by commit SHA.

## Snapshot semantics

Each normal score entry records:

- commit SHA and canonical UTC commit timestamp;
- score-profile version for comparable historical trends;
- provenance identifying the exact coding-tooling producer commit, GitHub Actions run and attempt, and validation tier;
- overall score, rating, and completeness;
- structural and verification component scores;
- latest category scores;
- verification status and passed/failed/error/blocked check counts;
- active, suppressed, and verified finding counts.

Provenance describes how a snapshot was produced; it does not participate in the score formula or score-profile identity. Existing historical entries created before provenance was introduced remain valid and are not backfilled with inferred values. A rerun for an existing main commit replaces both the score evidence and provenance so the retained entry points to the exact attempt that produced its current value.

The workflow deliberately runs scoring even when repository validation fails. A failed or blocked validation therefore lowers the verification pillar and remains visible in history rather than causing the commit to disappear from the trend.

If score production itself fails after producing a machine-readable score error envelope, history retains an explicit tombstone for that commit instead of omitting it. A tombstone has `score: null`, `verification.status: error`, the active score-profile version, the same production provenance, and compact diagnostics describing the score-production failure. The workflow publishes that tombstone first and then fails red so the history remains durable while Actions still surfaces the infrastructure failure. A later successful rerun for the same commit replaces the tombstone through the normal commit-SHA deduplication path.

## Pages surface

`/score/` reads the raw `history.json` document from the `score-history` branch and renders:

- the latest overall, structural, and verification scores;
- change from the previous scored commit within the same score profile;
- a 60-commit score chart that does not connect incompatible score profiles;
- the latest category breakdown;
- a recent commit evidence table with verification status, passed/failed/error/blocked counts, and score-production diagnostics when present.

Unscored error tombstones remain visible in the recent-commit table but do not become chart points or borrow a delta from an older scored commit. The raw history JSON additionally exposes provenance for agents and deeper debugging.

The page is static and performs no repository execution. Local or CI `coding-tooling run` plus `coding-tooling score` remains authoritative for producing each score snapshot.

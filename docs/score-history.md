# Repository score history

`coding-tooling/score-history/v1` retains the repository progress score by commit without writing generated evidence back to `main`. The history is a provenance trail, not just a list of numbers: every new snapshot records enough information to reproduce where the evidence came from, decide whether it is numerically comparable with the previous snapshot, and, when it is comparable, identify what evidence moved.

## Storage boundary

The `Publish Score History` workflow runs for `main` and persists `history.json` on the dedicated `score-history` branch. The persistence branch is data-only: `history.json` is the only tracked file, and the workflow verifies that invariant after every publication.

`score-history` has an independent root rather than inheriting the authored repository tree or `main` history. When the workflow encounters a legacy persistence branch that still contains repository files, it preserves the updated history document, rewrites the branch once as an orphan root containing only `history.json`, and then resumes ordinary non-force history commits on later runs.

This keeps generated history structurally isolated from authored source while making it durable, reviewable, and directly readable by GitHub Pages and coding agents. The workflow is triggered only by `main` pushes or explicit dispatch, so persistence commits do not recursively invoke repository validation or history publication.

Each main commit appears at most once. Re-running the workflow for the same commit replaces that entry instead of appending a duplicate. Attribution is then recomputed in chronological order so replacing an older entry cannot leave the next entry with stale change data. The document retains the latest 1,000 commit snapshots by chronological instant. Commit timestamps are normalized to UTC, and equal instants are ordered deterministically by commit SHA.

## Producer provenance

Every new snapshot records the producer commit, workflow run ID, workflow run attempt, and validation tier that generated it. This provenance is required for both scored entries and score-production error tombstones. A rerun for the same repository commit replaces the existing entry and therefore also replaces its provenance with the evidence producer that won deduplication.

Provenance identifies how a snapshot was produced; it is not part of the score definition. A new workflow run or producer commit does not by itself make two otherwise identical scores incomparable.

## Two levels of score identity

Repository scores carry two complementary identities.

`coding-tooling/repository-score-profile/v1` is the coarse, human-managed compatibility contract. It is deliberately bumped when maintainers intentionally change what the score means.

`coding-tooling/repository-score-definition/v1` is the exact, mechanically derived measuring stick. It includes the coarse profile version and a SHA-256 fingerprint over score-affecting semantics:

- detector IDs and versions;
- detector categories and default severities;
- severity weights;
- detector score-model IDs;
- the structural audit formula and aggregation rule;
- the verification obligation formula;
- structural/verification overall weighting and fallback behavior;
- rating boundaries.

Descriptions, current findings, coverage state, subject counts, current scores, and producer provenance are evidence rather than score-definition inputs, so they do not change the fingerprint.

The two layers provide defense in depth. The profile makes intentional scoring eras easy to communicate. The fingerprint catches effective definition drift even if a maintainer forgets to bump the profile. Adjacent scores are comparable only when both profile and fingerprint match.

Distinct full score definitions are stored once in the top-level `definitions` map and referenced from entries by fingerprint. Existing legacy snapshots without a profile or fingerprint remain visible, but they form an explicit comparison boundary; the history writer does not guess which modern definition produced them.

## Snapshot semantics

Each normal score entry records:

- commit SHA and canonical UTC commit timestamp;
- producer provenance;
- coarse score-profile version and exact score-definition fingerprint;
- overall score, rating, and completeness;
- structural and verification component scores;
- category scores;
- verification status and passed/failed/error/blocked check counts;
- active, suppressed, and verified repository finding counts;
- every structural audit's detector version, category, severity, coverage state, score model, score subjects, failed subjects, finding counts, and audit score.

The workflow deliberately runs scoring even when repository validation fails. A failed or blocked validation therefore lowers the verification pillar and remains visible in history rather than causing the commit to disappear from the trend.

If score production itself fails after producing a machine-readable score error envelope, history retains an explicit tombstone for that commit. The tombstone keeps producer provenance, the coarse score-profile version, compact diagnostics, `score: null`, error verification state, no fabricated exact definition, and no fabricated audit evidence. The workflow publishes the tombstone first and then fails red. A later successful rerun for the same commit replaces the tombstone through normal commit-SHA deduplication.

Because an error tombstone has no exact score-definition fingerprint, it is also a comparison boundary. A later scored commit does not borrow a delta from an older score across the missing evidence.

## Deterministic change attribution

A comparable entry records:

- overall and structural score deltas;
- verification score and obligation-count deltas;
- category score deltas;
- audit score, subject, failed-subject, and finding-count deltas.

When the coarse profile changes, the exact definition changes, either identity is unknown, or an unscored error tombstone intervenes, raw evidence remains retained but `comparable` is false and the dashboard suppresses the numeric headline delta. Trend lines also break at that boundary. This prevents a detector expansion, weighting change, profile transition, or missing score-production interval from appearing as an unexplained repository regression.

Automatic attribution explains changes in measured evidence. It does not claim that an audit movement was caused by a particular source-code edit unless a future evidence contract proves that relationship.

## Pages surface

`/score/` reads the raw `history.json` document from the `score-history` branch and renders:

- the latest overall, structural, and verification scores;
- the active coarse score profile and exact definition fingerprint;
- change from the previous comparable commit;
- a 60-commit score chart segmented at identity and error boundaries;
- deterministic verification and audit-level change drivers;
- the latest category breakdown;
- the latest structural audit evidence;
- a recent commit evidence table with both identities, verification counts, and score-production diagnostics when present.

Unscored error tombstones remain visible in the recent-commit table but do not become chart points or borrow a delta from an older scored commit.

The page is static and performs no repository execution. Local or CI `coding-tooling run` plus `coding-tooling score` remains authoritative for producing each score snapshot.

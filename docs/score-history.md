# Repository score history

`coding-tooling/score-history/v1` retains the repository progress score by commit without writing generated evidence back to `main`.

## Storage boundary

The `Publish Score History` workflow runs for `main` and writes `history.json` to the dedicated `score-history` branch. The branch is created from the first scored `main` commit when it does not already exist. Subsequent workflow runs update only the history document.

This keeps generated history outside the authored source branch while making it durable, reviewable, and directly readable by GitHub Pages and coding agents.

Each commit appears at most once. Re-running the workflow for the same commit replaces that entry instead of appending a duplicate. The document retains the latest 1,000 commit snapshots.

## Snapshot semantics

Each entry records:

- commit SHA and commit timestamp;
- overall score, rating, and completeness;
- structural and verification component scores;
- latest category scores;
- verification status and passed/failed/error/blocked check counts;
- active, suppressed, and verified finding counts.

The workflow deliberately runs scoring even when repository validation fails. A failed or blocked validation therefore lowers the verification pillar and remains visible in history rather than causing the commit to disappear from the trend.

## Pages surface

`/score/` reads the raw `history.json` document from the `score-history` branch and renders:

- the latest overall, structural, and verification scores;
- change from the previous scored commit;
- a 60-commit score chart;
- the latest category breakdown;
- a recent commit evidence table.

The page is static and performs no repository execution. Local or CI `coding-tooling run` plus `coding-tooling score` remains authoritative for producing each score snapshot.

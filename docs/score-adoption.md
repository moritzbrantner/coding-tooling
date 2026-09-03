# Score adoption registry

`score-adoption.json` is the desired-state inventory for repositories participating in repository score history.

It deliberately does not contain changing observations such as the latest score, CI state, last successful workflow run, or most recent snapshot. Those belong to each repository's persisted `score-history/history.json` evidence and, later, to a portfolio projection over that evidence.

## Ownership

The registry records rollout intent only:

- the immutable `reusable-workflows` revision used for the current rollout;
- the reusable score-history workflow path;
- repositories included in a rollout wave;
- the expected coarse score-profile identity;
- the reserved history branch;
- a stable dashboard grouping for later portfolio presentation.

Consumer repositories still own their validation tier and repository configuration. `reusable-workflows` owns GitHub-hosted orchestration and transport. `coding-tooling` owns score formulas, exact definition fingerprints, attribution, history retention, tombstones, and comparison semantics.

The registry must not become a second location for per-repository validation commands, detector weights, quality thresholds, or release policy.

## First calibration wave

Wave 1 intentionally spans different repository shapes before broader rollout:

- `moritzbrantner/audio-analysis`
- `moritzbrantner/collision-lab`
- `moritzbrantner/moenarch-foundation`
- `moritzbrantner/nlp-stack`
- `moritzbrantner/rust-kernels`

The purpose of this wave is calibration. A repository may expose a low score, unavailable evidence, or an unexpected definition boundary without failing adoption. Those observations are evidence to improve the scoring model before fleet-wide rollout.

## Contract

The v1 registry schema is `coding-tooling/score-adoption-registry/v1`.

`src/score-adoption.ts` validates the checked-in registry and future consumers can use the same parser. The contract requires:

- an exact lowercase 40-character reusable-workflow commit SHA;
- a `.github/workflows/*.yml` or `.yaml` reusable workflow path;
- unique repository names in deterministic lexical order;
- positive rollout-wave numbers;
- the current `coding-tooling/repository-score-profile/v1` coarse score identity;
- conservative history branch names;
- one of the supported stable dashboard groups.

Runtime discovery and portfolio aggregation should consume this inventory and then read live/persisted evidence from the repositories. They should not write observations back into `score-adoption.json`.

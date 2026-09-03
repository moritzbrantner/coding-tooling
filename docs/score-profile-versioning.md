# Repository score profile versioning

`coding-tooling/repository-score/v1` is the score document schema. `coding-tooling/repository-score-profile/v1` identifies the current measuring stick used to produce comparable numeric repository scores.

The profile version is emitted on every repository progress score and persisted on every new score-history entry. Historical deltas and trend lines must not cross a profile boundary. A profile version must be bumped when a change can alter the meaning of an otherwise identical repository score, including changes to the overall formula, structural audit weighting, or the set or semantics of modeled score subjects.

Adding fields that do not affect numeric interpretation does not require a profile bump. Existing legacy history entries without a profile remain readable, but they are treated as a separate profile boundary rather than being compared with profiled snapshots.

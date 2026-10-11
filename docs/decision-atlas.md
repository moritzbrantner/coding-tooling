# Decision Atlas v1: read-only indexes

The [Decision Atlas for the Decision Atlas](decisions/atlas.md) is the owner-approved specification for this capability. This guide describes the current implementation, not a second source of product decisions.

The **owning repository** is authoritative. This tool reads a committed document under `docs/decisions/`, validates it, and emits a deterministic `index.json` and offline `preview.html`. It does not update decisions, source issues, repositories, or a fleet index.

## Product semantics: Decisions and Questions only

The source Atlas exists to answer **what the product should be**. Its semantic leaf entries are deliberately limited to two kinds:

- **Decision:** owner-selected product intent. Agents follow it until a later Decision explicitly supersedes it.
- **Question:** a consequential unresolved choice. It remains visible and is not automatically blocking; an agent asks the owner one at a time only when that Question materially affects current work.

Navigation branches are not entries. Do not derive extra semantic kinds such as constraint, deferred decision, assumption, principle, proposal, or implementation state. Those may be expressed in entry text, relationships, or separate evidence metadata. Answering a Question preserves it and appends a Decision with an `answers` relationship; changing intent preserves the old Decision and appends a Decision with `supersedes`.

The owner-source model is authoritative. The indexer preserves Question leaves distinctly using `kind: "question"`, `choice: null`, and `decisionStatus: null`; Question is not an implementation state or an unapproved Decision.

## Source contracts and stable identifiers

- **`numbered-list`** reads explicit nested Markdown list identifiers (`1`, `1.2`, `1.2.3`) without reordering or allocating IDs. A list branch is navigation; a leaf must have an implementation-status label and owning-repository GitHub source links. This is the authoring format of the MMORPG PR #150 Atlas and, since its October 11 migration, the [My Farm Atlas](https://github.com/moritzbrantner/my-farm/blob/main/docs/decisions/atlas.md). The latter preserves all older `my-farm/...` IDs as **legacy aliases**, which are indexed and remain addressable.
- **`my-farm-tree`** is the read-only compatibility adapter for the original dated My Farm tree, when indexing a commit where that path contained the actual decisions. The **current** dated file is merely a redirect and is not a valid decision source.
The normalized derived index is validated against [decision-atlas-decision.schema.json](../schemas/decision-atlas-decision.schema.json) and [decision-atlas-index.schema.json](../schemas/decision-atlas-index.schema.json). These are **JSON output contracts**, not instructions to create extra authoritative per-decision Markdown or YAML files. A schema change must be explicit and versioned.

Question syntax within the same numbered Markdown list:
```md
- **8** Duels
  - **8.1** Duel outcome
    - **8.1.1** [question] Should duels be nonlethal? ([#150](https://github.com/moritzbrantner/mmorpg/pull/150))
    - **8.1.2** [owner decision; implementation pending] Duels are nonlethal. Answers 8.1.1. ([#150](https://github.com/moritzbrantner/mmorpg/pull/150))
```

`[question]` is an unresolved Question without an owner choice. A later numbered Decision may explicitly `Answers` or `Supersedes` an earlier entry; these are typed directed relationships, not hierarchy edges. Other dotted references become `references` edges. The validator rejects dangling IDs.

Every semantic entry has a stable ID; legacy aliases have unique identities of their own and may not shadow IDs. Parent edges define hierarchy, while independently typed `relations` edges describe references, requirements, or supersession. Neither sort order nor source line number becomes an identifier. An accepted Decision or unanswered Question must remain in future editions; a new decision can explicitly supersede its ID. Changing a branch label must not force an ID change.

## Pinned My Farm pilot

Use a **checkout of the exact owner source revision**. The first v1 pilot pins the observed 25-decision source at `e66ab2b327334fe5ba9b0941cdfbcaf6be8627b3`. It remains reproducible even when My Farm's main branch advances:

```sh
bun src/router.ts decision-atlas index \
  --root ../my-farm \
  --repository moritzbrantner/my-farm \
  --source docs/decisions/atlas.md \
  --format numbered-list \
  --revision e66ab2b327334fe5ba9b0941cdfbcaf6be8627b3 \
  --min-decisions 25 \
  --output .artifacts/decision-atlas-my-farm
```

The example requires `../my-farm` checked out at the specified commit (not just the current main branch). Output is disposable. Opening `.artifacts/decision-atlas-my-farm/preview.html` locally shows expandable tree navigation, ID/tag search, choice, source citations and typed relationships. The `index.json` records the source commit, source-content SHA-256, paths and source lines. The command fails if `HEAD` differs, the checked-out decision source is dirty, the repository identity is wrong, or parsing/validation fails. No network lookups happen during indexing.

For the **open MMORPG PR #150**, check out its _specific_ head and index its `docs/decisions/atlas.md` with `--format numbered-list`, `--repository moritzbrantner/mmorpg`, and `--revision "$(git -C ../mmorpg rev-parse HEAD)"`. The adapter does not convert the file, reassign dotted IDs, or treat a source claim of `implemented` as independently verified.

The optional `--previous-index path/to/index.json` compares stable IDs, choices and decision text against a prior **validated artifact**. It rejects disappearance/reuse and in-place historical changes while allowing category relabeling without ID changes. A source revision by itself cannot prove that old decisions were preserved without a prior baseline; publish consumers must carry forward their last known valid index externally when needed.

## Validation boundaries

Validation covers duplicate/missing identifiers, duplicate aliases, invalid status/choice, broken parents and cycles, dangling/colliding relationship edges, absent or malformed owning-repository issue/PR/immutable-blob citations, malformed list entries or Question-specific fields, missing source, unexpected uncommitted edits, and stale commit revisions. GitHub issue links are treated as **declared specification anchors**, not remote existence or acceptance evidence. Published code symbols, executable acceptance tests, and behavior are always `unverified` until a future deterministic provenance-checking capability establishes them.

The local output is a **preview**, not a deployed GitHub Pages Atlas. Cross-repository aggregation, reusable-workflows CI publication, verification of actual code/test symbols and automatic decision capture remain separate follow-ups. This does **not** choose Decision Atlas question 12's publishing/synchronization policy. Indexing only reads owner records and requires no synchronization write-back.

# Decision Atlas v1: read-only indexes

The **owning repository** is authoritative. This tool reads a committed document under `docs/decisions/`, validates it, and emits a deterministic `index.json` and offline `preview.html`. It does not update decisions, source issues, repositories, or a fleet index.

## Source contracts and stable identifiers

- **`numbered-list`** reads explicit nested Markdown list identifiers (`1`, `1.2`, `1.2.3`) without reordering or allocating IDs. A list branch is navigation; a leaf must have an implementation-status label and owning-repository GitHub source links. This is the authoring format of the MMORPG PR #150 Atlas and, since its October 11 migration, the [My Farm Atlas](https://github.com/moritzbrantner/my-farm/blob/main/docs/decisions/atlas.md). The latter preserves all older `my-farm/...` IDs as **legacy aliases**, which are indexed and remain addressable.
- **`my-farm-tree`** is the read-only compatibility adapter for the original dated My Farm tree, when indexing a commit where that path contained the actual decisions. The **current** dated file is merely a redirect and is not a valid decision source.
- **`canonical`** reads a directory of one Markdown file per decision or an individual Markdown file, with the versioned restricted YAML frontmatter shown below. This is an available option for _new owner-authored sources_, not a demand to convert the other two formats. The schema describes normalized fields, not a competing writable database.

Example of the **canonical per-decision Markdown/YAML v1 source** (`path` contains navigational categories; `id` is not derived from their names):

```md
---
atlas_version: 1
id: my-farm/control/direct-control
aliases: []
parent: null
path: ["Residents", "Control"]
choice: C
decision_status: accepted
implementation_status: not-verified
tags: ["input", "authority"]
relations: [{ "type": "requires", "target": "my-farm/control/paused-task" }]
links: ["https://github.com/moritzbrantner/my-farm/issues/126"]
---

Optional direct control uses the same authoritative Farm.
```

The canonical metadata parser deliberately supports a small, deterministic YAML subset: `key: value` scalars, `null`, numbers, and JSON-compatible inline arrays/objects (valid YAML). It rejects unsupported/ambiguous YAML features rather than silently guessing. The normalized contracts are [decision-atlas-decision.schema.json](../schemas/decision-atlas-decision.schema.json) and [decision-atlas-index.schema.json](../schemas/decision-atlas-index.schema.json); changes to their contract require a new `schemaVersion`.

Every decision has a stable ID; legacy aliases have unique identities of their own and may not shadow IDs. Parent edges define hierarchy, while independently typed `relations` edges describe references, requirements, or supersession. Neither sort order nor source line number becomes an identifier. An accepted or otherwise recorded historical decision must remain in future editions; a new decision can explicitly supersede its ID. Changing a branch label must not force an ID change.

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

Validation covers duplicate/missing identifiers, duplicate aliases, invalid status/choice, broken parents and cycles, dangling/colliding relationship edges, absent or malformed owning-repository issue/PR/immutable-blob citations, malformed canonical metadata, missing source, unexpected uncommitted edits, and stale commit revisions. GitHub issue links are treated as **declared specification anchors**, not remote existence or acceptance evidence. Published code symbols, executable acceptance tests, and behavior are always `unverified` until a future deterministic provenance-checking capability establishes them.

The local output is a **preview**, not a deployed GitHub Pages Atlas. Cross-repository aggregation, reusable-workflows CI publication, verification of actual code/test symbols and automatic decision capture remain separate follow-ups. This does **not** choose Decision Atlas question 12's publishing/synchronization policy. Indexing only reads owner records and requires no synchronization write-back.

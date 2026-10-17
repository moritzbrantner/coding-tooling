# Decision Atlas: read-only indexes

The [Decision Atlas for the Decision Atlas](decisions/atlas.md) is the owner-approved specification for this capability. This guide describes the current implementation, not a second source of product decisions.

The **owning repository** is authoritative. This tool reads a committed Markdown document under `docs/`, validates it, and emits a deterministic `index.json` and offline `preview.html`. It does not update decisions, source issues, repositories, or a fleet index.

## Product semantics: Decisions and Questions only

The source Atlas exists to answer **what the product should be**. Its semantic leaf entries are deliberately limited to two kinds:

- **Decision:** owner-selected product intent. Agents follow its active text; struck-through decisions are inactive.
- **Question:** a consequential unresolved choice. It remains visible and is not automatically blocking; an agent asks the owner one at a time only when that Question materially affects current work.

Navigation branches are not entries. Do not derive extra semantic kinds such as constraint, deferred decision, assumption, principle, proposal, or implementation state. Those may be expressed in entry text, relationships, or separate evidence metadata. Answering a Question can append a linked Decision (`answers`). To change a Decision, strike the outdated wording and write its replacement after it on the same line. Fully struck text retires the Decision. Existing `supersedes` links remain supported; IDs stay stable.

The owner-source model is authoritative. The indexer preserves Question leaves distinctly using `kind: "question"`, `choice: null`, and `decisionStatus: null`; Question is not an implementation state or an unapproved Decision.

## Source contracts and stable identifiers

- **`numbered-list`** reads explicit nested Markdown list identifiers (`1`, `1.2`, `1.2.3`) without reordering or allocating IDs. A list branch is navigation; a leaf has a `[decision]` or `[question]` label and substantive text. External GitHub links and implementation labels are optional; the committed file and line supply provenance. This is the authoring format of the MMORPG PR #150 Atlas and, since its October 11 migration, the [My Farm Atlas](https://github.com/moritzbrantner/my-farm/blob/main/docs/decisions/atlas.md). The latter preserves all older `my-farm/...` IDs as **legacy aliases**, which are indexed and remain addressable.
- **`my-farm-tree`** is the read-only compatibility adapter for the original dated My Farm tree, when indexing a commit where that path contained the actual decisions. The **current** dated file is merely a redirect and is not a valid decision source.
  The normalized derived index is validated against [decision-atlas-decision.schema.json](../schemas/decision-atlas-decision.schema.json) and [decision-atlas-index.schema.json](../schemas/decision-atlas-index.schema.json). These are **JSON output contracts**, not instructions to create extra authoritative per-decision Markdown or YAML files. A schema change must be explicit and versioned. Indexes are now emitted with `schemaVersion: 2`, which adds `evidence` to every entry. Earlier validated `schemaVersion: 1` indexes, which have no `evidence`, remain accepted as `--previous-index` baselines and by `daq --index`, where their Decisions report `not-audited`. Any other version, or an index whose evidence is malformed (for example a non-boolean `checked`), is rejected.

Question syntax within the same numbered Markdown list:

```md
- **8** Duels
  - **8.1** Duel outcome
    - **8.1.1** [question] Should duels be nonlethal? ([#150](https://github.com/moritzbrantner/mmorpg/pull/150))
    - **8.1.2** [owner decision; implementation pending] Duels are nonlethal. Answers 8.1.1. ([#150](https://github.com/moritzbrantner/mmorpg/pull/150))
```

The same `numbered-list` adapter also reads the owner approval checklist used by Video-to-3D's `docs/DECISION-ATLAS.md`. Numbered level-two headings provide topics; indented checkbox entries preserve their authored IDs and multiline descriptions. Topic placement does not change an ID, and nested entries follow authored indentation. A checked Decision records owner approval, never verified implementation. A `[question]` stays a Question even when checked: its checkbox must agree with a linked Decision's `Answers <ID>` relation. Unchecked Decisions, unknown entry kinds, malformed checkboxes and dangling references fail validation. The byte-preserved owner source and its revision are recorded in [the fixture provenance](../fixtures/decision-atlas/video-to-3d/README.md).

Pass `--source docs/DECISION-ATLAS.md` to select that committed source for indexing or local daq queries. The JSON schemas explicitly extend accepted source paths from `docs/decisions/` to `docs/`; format names are unchanged. General resource URLs remain authored statement text; v1 structured citations still contain only GitHub issues, PRs and immutable source files.

### Implementation evidence checkboxes

A `numbered-list` Decision may own nested **binary implementation evidence** children. Each child states one narrow, observable behavior and is either checked or unchecked:

```md
- **1** Product
  - **1.1** Checkout
    - **1.1.1** [decision] **B** — Checkout supports guest buyers.
      - [x] Guest cart persists across reloads.
      - [ ] Guest email is validated before payment.
        - [x] Invalid email shows an inline error.
      - [ ] Guest order appears in the admin list.
      - [ ] Admin export includes guest orders.
    - **1.1.2** [decision] Payments use one provider.
    - **1.1.3** [question] Should saved cards be offered?
```

- Children keep authored order and belong to the **nearest owning Decision**, including checkboxes nested under another checkbox. The indexed `evidence` array holds `{ text, checked }`, where `text` is the trimmed Markdown after the marker. The Decision's `statement`, `choice`, links, relations, ID and aliases are unaffected.
- Progress is **derived**, never stored: `daq` reports `progress` as `{ status: "audited", completed, total, percent }` (`percent` is display-only, `Math.round(completed / total * 100)`), `{ status: "not-audited" }` for a Decision with no children, or `{ status: "not-applicable" }` for a Question. In the example, 1.1.1 is `2/5` (40%), 1.1.2 is **not audited** (unknown, never 0%), and 1.1.3 is not applicable.
- There are only two states. Partial, almost, draft and similar states do not exist; split the behavior into smaller children instead.
- `[x]` applies **only to that child's stated behavior**. It never marks the parent Decision implemented or verified, even when every child is checked or links a merged PR. `implementation.verification` stays `unverified` and `provenance.implementation` stays `not-verified`; verifying code symbols or tests is a separate capability.
- Adding, toggling, rewording or removing evidence is not a historical Decision rewrite, so `--previous-index` accepts it. Choice and ID changes stay guarded as before.
- Checkboxes outside the entries list, such as a checklist under a separate `## Notes` heading or an inline `[x]` in prose, are ignored. The Video-to-3D approval-checklist variant is selected only by approval lines with a bold ID (`- [x] **1.2** ...`); its boxes mean owner approval and it carries no evidence children.

Evidence fails closed. Each of these errors carries `<path>:<line>`:

- a malformed marker (`[X]`, `[-]`, `[~]`, `[x ]`, `[ x]`, `[]`, `[  ]`, `[partial]`), or a marker without child text
- the same child text twice under one Decision, whatever its state (the same text under different Decisions is allowed)
- a checkbox under a Question; evidence does not apply to unresolved Questions
- a checkbox in the entries list that no Decision owns, for example one directly under a navigation branch

`daq get` prints `completed/total`, the percentage and one `[x]` / `[ ]` line per child, or `not audited`. The offline preview renders read-only (`disabled`) checkboxes, the count on the tree node, and "not audited" for Decisions without children.

Simple inline editing:

```md
- **8** Combat
  - **8.1** Blocking
    - **8.1.1** [decision] ~~Always block.~~ Block only while the shield is raised.
    - **8.1.2** [decision] ~~Parry is automatic.~~
```

The first entry uses its replacement; the second is retired. `[question]` remains a separate entry kind. Existing `answers` / `supersedes` references are still supported as typed edges; IDs and aliases remain stable. The index rejects dangling IDs and malformed strikethrough.

Every semantic entry has a stable ID; legacy aliases have unique identities of their own and may not shadow IDs. Parent edges define hierarchy, while independently typed `relations` edges describe references, requirements, or supersession. Neither sort order nor source line number becomes an identifier. IDs and known aliases must remain in future editions. Source text may be shortened; striking retired wording makes replacements explicit. Changing a branch label must not force an ID change.

## Query with daq

`daq` retrieves a small selection from an Atlas without making an agent read the entire Markdown document. It uses the **existing deterministic indexer**, never semantic inference, network discovery, or a second editable decision database.

```sh
# From the coding-tooling checkout; --root selects the owning project:
bun src/daq-cli.ts get 2.2.1
bun src/daq-cli.ts find "decision provenance" --limit 5
bun src/daq-cli.ts questions --root ../mmorpg --json
bun src/daq-cli.ts list --topic "Combat" --root ../arpg
bun src/daq-cli.ts find "combat" --index .artifacts/my-farm-decision-atlas/index.json --json
```

The package also exposes a `daq` executable when linked as a Bun package, or use `coding-tooling daq ...` through the existing router.

`get` accepts a stable ID or legacy alias, optionally prefixed with the repo name. `find` matches all space-separated terms against current text, ID, tags and topics using fixed deterministic scoring. `questions` lists unanswered questions only; `--include-inactive` also includes retired decisions and answered questions. `--kind` filters entry kinds. Results default to **12 entries**, with `--limit` capped at 100. `--json` returns only matches, source lines, relationships and the revision for scripts.

Without `--index`, daq reads the canonical **committed** `docs/decisions/atlas.md` in the selected checkout, rejecting stale/uncommitted source edits. `--index <file>` (or `--index -` for standard input) queries a previously validated disposable JSON index offline without rescanning the Markdown. It does not claim that a cached index is fresh.

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

The optional `--previous-index path/to/index.json` checks stable IDs, aliases and entry kinds against a prior **validated artifact**. Wording may be shortened; changed A/B/C choices must preserve the previous choice in struck-through text. A source revision by itself cannot prove that old decisions were preserved without a prior baseline; publish consumers must carry forward their last known valid index externally when needed.

## Validation boundaries

Validation covers duplicate/missing identifiers, duplicate aliases, invalid status/choice, broken parents and cycles, dangling/colliding relationship edges, malformed declared GitHub issue/PR/immutable-blob citations (external links are optional), malformed list entries or Question-specific fields, missing source, unexpected uncommitted edits, and stale commit revisions. GitHub issue links are treated as **declared specification anchors**, not remote existence or acceptance evidence. Published code symbols, executable acceptance tests, and behavior are always `unverified` until a future deterministic provenance-checking capability establishes them.

The local output is a **preview**, not a deployed GitHub Pages Atlas. Cross-repository aggregation, reusable-workflows CI publication, verification of actual code/test symbols and automatic decision capture remain separate follow-ups. This does **not** choose Decision Atlas question 12's publishing/synchronization policy. Indexing only reads owner records and requires no synchronization write-back.

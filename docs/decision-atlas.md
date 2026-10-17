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
  The normalized derived index is validated against [decision-atlas-decision.schema.json](../schemas/decision-atlas-decision.schema.json) and [decision-atlas-index.schema.json](../schemas/decision-atlas-index.schema.json). These are **JSON output contracts**, not instructions to create extra authoritative per-decision Markdown or YAML files. A schema change must be explicit and versioned. Indexes are now emitted with `schemaVersion: 2`, which adds `evidence` to every entry. Earlier validated `schemaVersion: 1` indexes, which have no `evidence`, remain accepted as `--previous-index` baselines and by `daq --index`, where their Decisions report `not-audited`. Any other version, or an index whose evidence is malformed (for example a non-boolean `checked`), is rejected; `--previous-index` baselines get the same full validation.

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
- `[x]` applies **only to that child's stated behavior**. It never marks the parent Decision implemented or verified, even when every child is checked or links a merged PR. `implementation.verification` stays `unverified` and `provenance.implementation` stays `not-verified`. Evidence anchors (below) can show that a named symbol or test exists, which is still not verification.
- Adding, toggling, rewording or removing evidence is not a historical Decision rewrite, so `--previous-index` accepts it. Choice and ID changes stay guarded as before.
- Checkboxes outside the entries list, such as a checklist under a separate `## Notes` heading or an inline `[x]` in prose, are ignored. The Video-to-3D approval-checklist variant is selected only when a file has top-level approval items with a bold ID (`- [x] **1.2** ...`) and no plain numbered `- **1.2** ...` entries. Its boxes mean owner approval, and it carries no evidence children. In a numbered Atlas, evidence text may itself begin with bold numbers.

Evidence fails closed. Each of these errors carries `<path>:<line>`:

- a malformed marker (`[X]`, `[-]`, `[~]`, `[x ]`, `[ x]`, `[]`, `[  ]`, `[partial]`), or a marker without child text
- the same child text twice under one Decision, whatever its state (the same text under different Decisions is allowed)
- a checkbox under a Question; evidence does not apply to unresolved Questions
- a checkbox in the entries list that no Decision owns, for example one directly under a navigation branch, under a non-entry list item such as `- Notes` (which ends the preceding Decision's ownership), or inside a `Cross-decision references` block

`daq get` prints `completed/total`, the percentage and one `[x]` / `[ ]` line per child, or `not audited`. The offline preview renders read-only (`disabled`) checkboxes, the count on the tree node, and "not audited" for Decisions without children.

### Evidence anchors

An evidence checkbox may end with an **anchor tail** that names the code and acceptance test behind it ([Atlas 4.3.1–4.3.5](decisions/atlas.md)). The tail starts at the first `—` (space, em dash, space) immediately followed by `src:`, `test:` or `proof:`, and is a `; `-separated list on the same line. There is no sidecar file and no sub-bullet syntax:

```md
- [x] Queue oven recipe — src: crates/farm/src/engine.rs::FarmCommand::QueueOvenRecipe; test: crates/farm/tests/oven.rs::queues_recipe; proof: https://github.com/<owner>/<repo>/blob/<40-hex>/docs/proof.md
- [ ] Client oven bakes — src: src/oven.ts::Oven.bake; test: tests/oven.test.ts::Oven > bakes bread
- [x] Legacy queue existed — src: crates/farm/src/engine.rs::legacy_queue@<40-hex>
```

- `src:` and `test:` take `<repository-relative path>::<symbol>`, split at the first `::`. **Rust** symbols are item paths relative to the file: inline `mod` blocks add a segment, enum variants are `Enum::Variant`, and associated items of `impl Type`, `impl Trait for Type` and `trait Trait` are `Type::item`. Struct fields and `use` re-exports are not declarations. **TypeScript** symbols use `.`: `fn`, `Class`, `Class.method` (static or instance), `Namespace.member`, `Enum.Member`, a top-level `const`.
- A Rust `test:` names a `#[test]` (or `#[<path>::test]`, e.g. `tokio::test`) fn by item path; a plain helper fn is not a test. A TypeScript `test:` names a literal `test(...)` / `it(...)` call; enclosing `describe("X", ...)` names are joined with `>`, and the bare inner name does not match.
- A trailing `@<40-hex sha>` pins the anchor's **revision**. Otherwise it is checked at the checkout's committed `HEAD`.
- `proof:` must be an immutable `https://github.com/<owner>/<repo>/blob/<40-hex>/<path>` URL. It is kept verbatim with that commit as `revision`, and it is never fetched.
- `<owner>/<repo>:<path>::<symbol>` names another repository. It is indexed but reported `unresolved` (cross-repository resolution is a successor capability).

The index keeps `{ text, checked }` with the tail removed from `text`, and adds `anchors: [{ kind, path?, symbol?, revision?, url? }]` in authored order (see [the decision schema](../schemas/decision-atlas-decision.schema.json)). Items without a tail are unchanged, and an em dash in prose that is not followed by a kind token stays text. Anchors carry **no line numbers**: identity is path + symbol. A malformed anchor fails closed with `<path>:<line>`. This covers a missing `::symbol` or test case, an empty path or symbol, an unknown kind (`tst:`), a short or non-hex `@sha`, an absolute or `..` path, and a mutable or non-URL `proof:`.

**Resolution** is a separate, report-only step: `daq get <ID> --root <checkout> --resolve-anchors [--json]` (`resolveAtlasAnchors(root, index)` in `src/decision-atlas-anchors.ts`). It reads committed git objects (`git ls-tree` / `git cat-file`) at `HEAD` or at the pinned commit, never the working tree, and parses each file with a real parser. TypeScript uses the TypeScript compiler API (`@typescript/typescript6`, syntax only). Rust uses an item parser built on the repository's shared Rust lexer (`src/rust-lexer.ts`), which already drops comments, strings, raw strings and char literals. Each anchor gets exactly one status:

| Status       | Meaning                                                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolved`   | Supported language, file present at the revision, exactly one matching declaration or test. Carries `revision`, the `line` of the name and a `https://github.com/<repo>/blob/<revision>/<path>#L<line>` link.                 |
| `stale`      | The file is missing at the revision, or no declaration matches: it was renamed, moved to another file, or removed, or the name appears only in a comment or string, or only a longer or shorter identifier exists.            |
| `ambiguous`  | Two or more matching declarations, such as `#[cfg]` twins or duplicate test names. TypeScript overloads, get/set pairs and interface or namespace merges count once.                                                          |
| `unresolved` | The anchor cannot be checked here. This covers an unsupported language, another repository, a pinned SHA that is not a commit here, a Rust file with unbalanced delimiters, a symlink, a file over 2 MiB, and every `proof:`. |

Non-resolved results carry a `reason` and no line or link. The line and link are **derived display output**. Moving code within a file changes only the line, and the anchor stays `resolved`. A rename or move to another file makes it `stale`. In JSON, each `entries[].evidence[].anchors[]` gains `resolution: { status, reason?, revision?, line?, link? }`. The text output prints each anchor's status and link under its checkbox. `--resolve-anchors` cannot be combined with `--index`, because it needs the checkout's git objects.

**Resolvable is not verified.** A `resolved` anchor shows only that the named declaration or test exists at that revision. Resolution never runs tests, never fetches proof URLs, never toggles `[x]` / `[ ]`, and never changes `completed/total`, `implementation.verification` (`unverified`) or `provenance.implementation` (`not-verified`). A proof keeps its immutable revision as recorded evidence, not as verification. Out of scope: out-of-line `mod x;` file contents, macro-generated items, `use` re-exports, items nested in function bodies, cross-repository anchors and running the referenced tests.

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

Validation covers duplicate/missing identifiers, duplicate aliases, invalid status/choice, broken parents and cycles, dangling/colliding relationship edges, malformed declared GitHub issue/PR/immutable-blob citations (external links are optional), malformed list entries or Question-specific fields, missing source, unexpected uncommitted edits, and stale commit revisions. GitHub issue links are treated as **declared specification anchors**, not remote existence or acceptance evidence. Code symbols and tests named by evidence anchors can be checked for existence (`daq --resolve-anchors`), but behavior is always `unverified`; anchor resolution is never verification.

The local output is a **preview**, not a deployed GitHub Pages Atlas. Cross-repository aggregation, reusable-workflows CI publication, running referenced acceptance tests, cross-repository anchor resolution and automatic decision capture remain separate follow-ups. This does **not** choose Decision Atlas question 12's publishing/synchronization policy. Indexing only reads owner records and requires no synchronization write-back.

# Decision Atlas for the Decision Atlas

This is the repository-owned record of **owner-approved product decisions** for the Decision Atlas, made on 2026-10-11. It records **what the Atlas should do**, not what its current tooling already implements. See [coding-tooling #315](https://github.com/moritzbrantner/coding-tooling/issues/315) for implementation and [PR #316](https://github.com/moritzbrantner/coding-tooling/pull/316) for the in-progress indexer.

The source has **exactly two semantic entry kinds: Decision and Question**. Topic headings are navigation, not entries. Labels such as `owner decision`, implementation evidence, and approval provenance are metadata, **not additional kinds**. The answer to a Question is a newly appended Decision that explicitly `answers` the original Question. A changed Decision is a new Decision explicitly `supersedes` the previous one; keep both original entries and IDs. Only an explicit supersession resolves conflicting decisions.

The numbered hierarchy below is **project-scoped and immutable**: never renumber, delete, or reuse identifiers. Topic labels may change without changing identity. Cross-repository references use `repository:ID`; retain known legacy path IDs as aliases during migrations. Issue/PR links below identify the shared implementation tracker; an issue link alone is not independent proof of approval or implementation.

## Entries

- **1** Product meaning and ownership
  - **1.1** Entry model
    - **1.1.1** [owner decision; implementation unverified] **Two kinds** — The product Atlas contains only Decisions (what the product should be) and Questions (what needs an answer). Do not introduce separate entry kinds for constraints, requirements, assumptions, proposals, or deferred decisions. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
    - **1.1.2** [owner decision; implementation unverified] **B** — Minimum authored fields for either kind are a stable ID, explicit kind, statement/question text, and source location. Approval evidence establishes decision authority separately; rationale, alternatives, consequences, dependency references, verification, and implementation status are optional enrichments. Missing data remains visible, not invented. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
    - **1.1.3** [owner decision; implementation unverified] **Linked answer** — A Question remains recorded when answered; append a Decision with an explicit `answers` relationship. Unanswered Questions are not automatically blocking. Agents ask the owner one consequential unresolved question at a time only when needed to proceed. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
  - **1.2** Source of truth
    - **1.2.1** [owner decision; implementation unverified] **B** — Each owning repository keeps versioned decision source files. Product decisions belong to product repositories; coding-tooling owns validation/indexing mechanics, reusable-workflows owns CI publication, and any viewer consumes derived read-only indexes, never a second editable authority. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
    - **1.2.2** [owner decision; implementation unverified] **B** — Authoring is Markdown-first with flexible existing structures. Prefer a single authoritative `docs/decisions/atlas.md` for new owner-authored Atlases, but parse existing numbered Markdown and path-ID sources without forcing migrations or creating duplicate authorities. Generated indexes are reproducible, disposable outputs. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
    - **1.2.3** [owner decision; implementation unverified] **A** — Import established choices from existing GitHub issues and documents with traceable evidence. Treat only demonstrably owner-approved decisions as authoritative; ambiguous inferences are review candidates, not silently accepted decisions. Never fabricate missing rationale, verification, or links. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).

- **2** Identity and history
  - **2.1** Navigation and identifiers
    - **2.1.1** [owner decision; implementation unverified] **A** — IDs are stable and project-scoped, with hierarchical numeric identifiers such as `2.1.1` in new numbered Atlases. Cross-project references use a repository prefix. Preserve existing stable path-based IDs as IDs or aliases rather than renaming them. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
    - **2.1.2** [owner decision; implementation unverified] **A** — Numbered hierarchy expresses topics/subsystems, not chronological order or dependency order. Dependencies and other cross-branch links are explicit typed relationships. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
  - **2.2** Revision and conflicts
    - **2.2.1** [owner decision; implementation unverified] **B** — When product intent changes, append a new Decision with `supersedes`; retain the original ID and record. Do not edit historical choices in place. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
    - **2.2.2** [owner decision; implementation unverified] **B** — Resolve authority conflicts only by explicit supersession, never by latest timestamp or a guessed source ranking. Surface unresolved contradictions for owner review. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).

- **3** Cross-repository relationships
  - **3.1** Ownership
    - **3.1.1** [owner decision; implementation unverified] **A** — Every shared decision has one canonical owning repository responsible for its contract. Consumers reference the owner's ID and may record their own local adoption decisions, without duplicating the shared authority. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
  - **3.2** Discovery and materialization
    - **3.2.1** [owner decision; implementation unverified] **C** — Hybrid discovery: explicit references are confirmed; inferred relationships are proposals with evidence. Explicit-only lookup is the default and never scans or recomputes implicit links. Promote selected discoveries into versioned explicit references to avoid rescanning. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
    - **3.2.2** [owner decision; implementation unverified] **B** — Discovery runs manually or incrementally in opt-in repository CI when sources change. It does not automatically convert inferred relationships into authority. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
    - **3.2.3** [owner decision; implementation unverified] **B** — Propose materialized relationships in reviewable GitHub PRs with evidence and affected decisions. Only merged, individually accepted changes become explicit references. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).

- **4** Delivery
  - **4.1** Practical first version
    - **4.1.1** [owner decision; implementation unverified] **Small first slice** — Build source validation, stable IDs, revision-bound deterministic indexing, visible provenance, and a local navigation preview before fleet-wide Pages aggregation, automatic write-back, or advanced inference. Track implementation separately from approved intent. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).
    - **4.1.2** [owner decision; implementation unverified] **Pilot coverage** — Initial intended product pilots are ARPG, physics-engine, and input-bindings (product behavior, technical constraints, and cross-repository contracts). Use the already-committed My Farm Atlas as the first parser fixture and the MMORPG PR #150 numbered Atlas for compatibility; do not replace their sources. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).

  - **4.2** Cross-repository publication
    - **4.2.1** [question] When cross-repository publication is implemented, should indexes be propagated event-by-event, reconciled periodically, or use another explicitly selected policy? This is not required to build a deterministic local index and should be asked only when publication needs the choice. [Tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).

Questions also have immutable project-scoped IDs. The PR #316 branch includes parser support for `[question]` entries, but that feature is not shipped until the pull request is validated and merged. A Question must never be normalized as an approved Decision.

## Agent reading and implementation rule

Read the relevant repository-owned Atlas before implementation. Follow applicable Decisions. Surface contradictory Decisions rather than guessing. Ask a consequential unresolved Question only when the work needs an answer. Append the owner's answer as a new Decision with `answers`; for changes of intent use `supersedes`. Do not treat inferred candidates, source citations, implementation labels, or generated indexes as owner approval. Never change historical IDs or generate a second authority.

For implementation details and the current gap in Question indexing, use [the Decision Atlas tooling guide](../decision-atlas.md) on PR #316. This file is the owner-decision record; that guide and its schemas describe the tooling's currently supported behavior.

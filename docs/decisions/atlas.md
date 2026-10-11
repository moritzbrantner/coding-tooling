# Decision Atlas

Owner-approved product rules (2026-10-11). Only **Decisions** and **Questions**; topic headings are navigation. IDs stay stable. To retire text, strike it with `~~`; to replace it, write the new text immediately after the struck text. Git preserves previous versions. [Implementation tracker](https://github.com/moritzbrantner/coding-tooling/issues/315).

## Entries

- **1** Product
  - **1.1** Entries
    - **1.1.1** [decision] Decisions and Questions are the only entry kinds.
    - **1.1.2** [decision] **B** — Require ID, kind, text, and source; all other metadata optional. Do not invent evidence.
    - **1.1.3** [decision] Answer Questions with a linked Decision; agents ask consequential unresolved Questions one at a time.
  - **1.2** Ownership
    - **1.2.1** [decision] **B** — Each repository owns its decisions. Indexes and viewers are read-only derivatives.
    - **1.2.2** [decision] **B** — Markdown-first; keep existing formats, with one Atlas file per project preferred.
    - **1.2.3** [decision] **A** — Import only evidenced owner-approved decisions; flag uncertain ones.

- **2** Identity and changes
  - **2.1** IDs
    - **2.1.1** [decision] **A** — Stable project-scoped hierarchical IDs; prefix cross-project references and preserve old aliases.
    - **2.1.2** [decision] **A** — Hierarchy groups topics; explicit references express dependencies.
  - **2.2** Editing
    - **2.2.1** [decision] ~~**B** — When product intent changes, append a new Decision with `supersedes`; retain the original ID and record. Do not edit historical choices in place.~~ Keep the ID: strike retired text; write its replacement after it. Strike the entire text to retire an entry.
    - **2.2.2** [decision] **B** — Resolve conflicts explicitly (inline replacement or a referenced decision), never by timestamp.

- **3** Relationships
  - **3.1** Authority
    - **3.1.1** [decision] **A** — One canonical owner for each shared decision; other repositories reference it.
  - **3.2** Discovery
    - **3.2.1** [decision] **C** — Hybrid discovery. Explicit links are authoritative; inferred links are proposals and can be persisted.
    - **3.2.2** [decision] **B** — Explicit-only by default. Discovery is manual or incremental opt-in CI.
    - **3.2.3** [decision] **B** — Materialize discovered links through reviewed GitHub PRs.

- **4** Delivery
  - **4.1** First version
    - **4.1.1** [decision] Build a deterministic index and local preview first; defer fleet aggregation and inference.
    - **4.1.2** [decision] Pilot ARPG, physics-engine, input-bindings; use My Farm and MMORPG as parser fixtures.
    - **4.1.3** [decision] `daq` retrieves bounded, relevant Decisions and Questions by ID, topic, and words; no implicit discovery.
  - **4.2** Publication
    - **4.2.1** [question] How should indexes synchronize across repositories? Decide when publication needs it.

Agents follow current Decisions and ask relevant unanswered Questions. A struck-only decision is inactive; inline replacement is current. Missing implementation evidence stays unverified.

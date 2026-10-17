# Retired owner approval checklist fixture

Since coding-tooling #348 (Atlas 1.1.4) approval checkboxes are retired: every written Decision is approved and `[x]`/`[ ]` mean built/not built evidence only. This file is kept as a negative fixture — indexing it must fail with the migration message (`tests/atlas-approval.test.ts`).

`DECISION-ATLAS.md` is the exact source from `moritzbrantner/video-to-3d`, `docs/DECISION-ATLAS.md`, PR #180 head `9e66e206362d74bc855bc66064bef6e4287f6e1b`. Retrieved through GitHub's contents API for that immutable revision on 2026-10-13. It has 45 semantic entries, six authored capability headings and six historical/unresolved Questions. The opening Question link is navigation.

The source PR was open when this acceptance handoff was authored. Production work for coding-tooling #324 must recheck that the owner source merged, and independently reconcile fixture changes if its final source differs. This copied input is parser test data, not a second authority or evidence that Video-to-3D acceptance passed. Preserve its source bytes; do not format the reference Markdown.

Run `bun test tests/atlas-approval.test.ts tests/decision-atlas.test.ts tests/daq.test.ts`. The existing tests retain numbered My Farm/MMORPG and original My Farm tree coverage. New tests use the existing `numbered-list` seam and explicit source path: no new authoritative source schema is required by this handoff. New index/CLI behavior is deliberately red on baseline `04745bf9e9a005962f32c3669f79f9ec0b69defd`.

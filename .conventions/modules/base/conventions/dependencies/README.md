# Dependency development conventions

## DEP-001 — Keep publication out of ordinary development

- Develop cross-repository changes against source revisions rather than publishing packages to unblock feature work.
- Prefer the repository's declared source-development mechanism and pin exact revisions.
- Do not start a crates.io, npm, or other registry release train unless the task is explicitly a release task.

## DEP-002 — Version bumps belong to release work

- Keep package versions compatible during source-development work when possible.
- Put version bumps, changelogs, tags, registry publication, and registry-only consumer updates in a dedicated release change.
- Do not treat a missing published version as a feature blocker when an exact source dependency can prove the change.

## DEP-003 — Bound cross-repository task expansion

- A normal implementation task may modify the target repository and at most two upstream repositories unless broader migration scope is explicitly authorized.
- Treat this as an execution-scope budget, not as a limit on how many independently versioned capabilities an application may consume.
- If implementation requires changing a wider source graph, stop recursively expanding the task and treat the boundary as explicit architecture or migration work.
- Do not recursively repair or release unrelated transitive packages merely because they appear in the dependency graph.

## DEP-004 — Require a reason for a new independently versioned package

- Add functionality to an existing coherent package by default.
- Create a new package or crate only when there is a second independent consumer, a hard dependency/isolation boundary, or another concrete reason for independent versioning.
- Conceptual separability alone is not sufficient.

## DEP-005 — Separate development proof from release proof

- Source-mode checks prove that the working source graph is correct.
- Registry-only resolution in a clean checkout is a release/distribution gate, not an inner-loop development gate.
- Before release, remove or deactivate source overrides and prove the published dependency graph independently.

## DEP-006 — Publish frontend packages only for real external consumers

- Keep application-local JavaScript or TypeScript packages source-local.
- Do not publish to npm solely because a workspace package boundary exists.
- Publish only when another independently versioned consumer requires the package or distribution itself is the product.

## DEP-007 — Keep private source graphs local to the coding workspace

- For private cross-repository dependencies, prefer exact sibling repositories or worktrees owned by the outer coding workspace rather than authenticated Git fallback inside the dependency resolver.
- Require each local source checkout to match the exact declared revision before using it; missing or mismatched source must fail explicitly.
- Do not add repository secrets, personal access tokens, or hosted-CI private checkouts merely to reproduce an ordinary multi-repository development workspace.
- Keep hosted CI repository-local when private source access would otherwise be required. Record the exact source revisions and local verification evidence as the implementation proof.
- Authentication may still exist in an explicit release/distribution workflow when that workflow genuinely needs protected release inputs; do not make those credentials a prerequisite for feature development.

## DEP-008 — Keep repository dependencies directional

- Put broadly reusable contracts and primitives below the domain repositories that consume them.
- Domain repositories should depend downward on shared contracts or foundations rather than sideways on another domain's implementation merely to exchange data.
- Put genuine cross-domain behavior in an explicit adapter or composition layer that depends on both domains.
- Applications may compose several domain capabilities directly; that composition is not itself unwanted coupling.

## DEP-009 — Depend on capability surfaces, not upstream topology

- Consume the smallest stable public surface that represents the required capability.
- Do not make callers understand an upstream repository's internal crate/package decomposition when a cohesive public facade or adapter can hide it.
- If ordinary callers must pin or update several same-owner implementation packages together to obtain one capability, improve the owning repository's public boundary instead of spreading that topology into more consumers.
- Do not create a facade that merely forwards APIs without reducing caller knowledge or concentrating compatibility logic.

## DEP-010 — Give every versioned package one canonical owner

- A versioned package or crate must have one canonical repository responsible for source changes, compatibility, tests, and releases.
- During a repository migration, document the temporary old/new ownership state and the exact cutover condition.
- After cutover, the former repository may keep compatibility shims or provenance, but must not remain a competing release or source authority.

## DEP-011 — Treat source overrides as development mechanics

- Exact source overrides may substitute unpublished revisions during cross-repository development, but they must preserve the intended public dependency direction.
- Do not use source patches to normalize permanent sideways dependencies, duplicate ownership, or consumer knowledge of implementation internals.
- Repeated feature work that requires coordinated source heads across several sibling repositories is an architecture signal: introduce or improve a contract, capability surface, adapter, or ownership boundary before expanding the patch graph further.

# Capability catalog

This directory defines deterministic semantic capabilities that repositories may declare through their own scripts.

`catalog.json` is the machine-readable source of truth. A capability name describes what is checked; `scriptCandidates` lists repository script names that can provide it without guessing command semantics.

## Families

- [Automated tests](automated-tests/)
- [Package validation](package/)
- [Storybook](storybook/)
- [Playwright](playwright/)
- [Lighthouse](lighthouse/)
- [Benchmarks](benchmarks/)
- [Profiling](profiling/)

The catalog reports capabilities and metadata. Convention policy still decides which tiers are required for a task.

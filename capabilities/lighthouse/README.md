# Lighthouse capability

Stable executable name: `web:audit`.

A repository may provide that capability with a `web:audit` package script or map another deterministic Lighthouse/Unlighthouse command explicitly through `capabilityCommands`. The semantic capability requires:

1. a production-shaped build,
2. an explicit route set,
3. a committed budget,
4. machine-readable results,
5. captured runner and browser metadata.

Validate budget documents with `../../schemas/performance-budget.schema.json`. The capability is opt-in until a reviewed baseline exists; policy outside this tool promotes it to a blocking gate.

Expected artifacts include `.lighthouseci` and `.generated/unlighthouse`.

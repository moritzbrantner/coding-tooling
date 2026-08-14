# Benchmark capabilities

Stable names:

- \`benchmark\` — run a declared focused benchmark suite and emit machine-readable results.
- \`benchmark:compare\` — compare baseline and candidate results using committed thresholds.

Recognized Bun script candidates include \`bench\`, \`bench:ci\`, and \`bench:compare\`. Other ecosystems may declare an explicit adapter without changing the semantic name.

Benchmark results must satisfy \`../../schemas/benchmark-report.schema.json\`. Each result records its unit, direction, central value, sample count, environment, and thresholds. Comparison fails only when both relative and absolute regression limits are exceeded.

Benchmarks are opt-in by default because they are more expensive and hardware-sensitive than focused tests.

# Built artifact size evidence

Status: accepted for opt-in mechanics; consumer adoption tracked in #160.

Repositories already own their builds, bundle graphs and size budgets. Coding tooling owns deterministic evidence and validation selection. Reimplementing bundlers or inferring compiler settings from finished files would blur these boundaries.

Provide one local, versioned raw-byte collector over explicit repository declarations. It hashes selected artifacts, observed tool versions and declared build inputs; it compares only identical build/selection identities against reviewed versioned measurements. The producing repository builds the artifacts and owns limits and baseline updates. Toolchain probes are bounded subprocesses from trusted repository configuration.

This is a specialized size comparison, not a general performance evaluator. CPU, memory, latency, symbol attribution, compressed transfer metrics and historical benchmark comparisons retain their existing owners. Native and web use the same byte metric while retaining explicit distinct target/profile/feature identities. Incompatible or missing evidence cannot pass a comparison.

This makes stale or incorrectly declared producer inputs a visible contract limitation: the collector cannot independently reconstruct how a binary was built. Consumer commands must build using the declared inputs before collecting. Initial web and Rust pilots must prove the integration before any wider fleet rollout.

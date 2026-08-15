# Dependency-update profiles

Copy the closest JSON profile into a Consumer Repository as `.coding-tooling.json`.

- `typescript-app.json` expects package scripts for lint, typecheck, build, and unit tests; broader
  evidence is optional until declared.
- `rust-library.json` uses the built-in Cargo formatting, Clippy, build, unit, and integration
  mappings. Add `capabilityCommands` for the repository's audit and named Criterion smoke bench.
- `dotnet-service.json` uses the built-in dotnet formatting, build, and unit mappings. Add
  `capabilityCommands` for integration topology, audit policy, E2E, and BenchmarkDotNet entrypoints.

Do not paste a generic benchmark command that measures no representative workload. Optional
capabilities are reported as unavailable; once mapped, a failing command fails the strict tier.

Example Rust extension:

```json
{
  "capabilityCommands": {
    ".": {
      "dependencies:audit": ["cargo", "audit"],
      "benchmark:smoke": ["cargo", "bench", "--locked", "--bench", "smoke"]
    }
  }
}
```

Selectors are component names or repository-relative paths. Path mappings take precedence.

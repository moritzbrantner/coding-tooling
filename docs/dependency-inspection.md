# Static dependency and boundary inspection

```sh
coding-tooling dependencies inspect
coding-tooling dependencies inspect --component backend --json
```

The command collects declarations from the local checkout without executing package scripts, Cargo, MSBuild, Docker, network probes or dependency installation. It reuses normal component discovery and fixture exclusions. `--component` selects dependency and command declarations by component name or path; repository-wide Compose, OpenAPI and native-target declarations remain visible separately.

The normal result envelope contains `data.reportVersion: 1`, `components`, `boundaries` and `coverage`. The data contract is described by [the inspection schema](../schemas/dependency-inspection.schema.json). Without `--json`, output follows the existing CLI's readable, indented JSON presentation. Ordering is stable across manifest key enumeration.

Each component has a stable `kind:path` identity and an explicit collection status:

- `complete`: supported direct declaration fields were collected, including a known-empty dependency set;
- `partial`: some declaration relationships could not be resolved;
- `unsupported`: no adapter collects this component kind;
- `unavailable`: supported input is missing.

The envelope's `passed` status means collection produced evidence, including partial evidence. It does not mean every feature is supported or every dependency resolves. Read component statuses and feature coverage before interpreting empty arrays. Invalid supported declarations return `error`; no analyzable inputs return `unavailable`.

## Dependency declarations

JavaScript components report direct, development, optional and peer dependencies from their package manifest. Registry, `workspace:`, `file:`/`link:` and explicit Git references retain their declaration source. Unsupported URL/catalog forms remain `unknown`. Workspace references identify declared source intent; this command does not resolve package-manager workspaces or prove availability.

Rust components report package, development and build dependencies, including member manifests covered by a discovered workspace. Dependency records retain their own manifest path, target condition, requested features, explicit default-feature setting, package alias and source reference/revision. `workspace = true` uses the nearest declared workspace dependency table, merges requested features and records `inheritedFrom`; a missing entry produces a diagnostic and partial evidence. Features are declared requests, not resolved activation for a compiled target. Target conditions are retained without evaluation.

.NET dependency inspection is explicitly unsupported: existing discovery identifies assemblies but does not provide a static project/package-reference parser. Python and generic repository components likewise retain their identities with unsupported dependency evidence. This initial version does not invoke a tool to invent missing facts.

Transitive dependencies and source-reference extraction are explicitly unsupported. Lockfile presence is not a dependency-use or completeness claim. No output recommends replacement, labels a package unused, or attributes performance.

## Declared boundaries

- Package scripts and explicit `capabilityCommands` are reported as declared subprocess commands, not observed executions.
- Root `compose.yaml`, `compose.yml`, `docker-compose.yaml` and `docker-compose.yml` provide named services, declared images and `depends_on` relationships. Each file remains a separate declaration: merge/override semantics, includes, extensions and environment interpolation are not evaluated. Includes, extensions and interpolated relationships produce partial coverage.
- Recognized JSON OpenAPI documents provide explicit document-level server URLs. Other HTTP configuration, Swagger hosts and operation-level overrides remain outside this partial adapter.
- Cargo `package.links`, explicit `cdylib`/`staticlib` artifact declarations and `.cargo/config[.toml]` WASM build targets provide native/WASM boundary facts. They do not prove foreign calls occur at runtime or discover arbitrary source-level FFI.

Boundary records include source-file provenance. These declarations establish neither successful execution nor live service availability, behavioral correctness, runtime cost or replacement suitability.

# environment-v1 conformance fixtures

These fixtures lock the read-only `coding-tooling` interpretation of the environment-v1 contract to explicit repository states. They are intentionally small and network-free.

Covered states:

- valid exact toolchain pins and complete adoption;
- partial adoption;
- floating toolchain pins;
- valid compatibility holds;
- malformed compatibility holds.

The fixtures are contract evidence, not a second environment implementation. `coding-tooling` must remain read-only; mutation continues to belong to `platform-upgrader`.

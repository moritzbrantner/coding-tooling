# ADR 0003 — Optional common CLI toolbox

Status: proposed (2026-11-05)

## Decision

Use `coding-tooling/mise.toml` as the single declared list of general-purpose
agent CLI conveniences. Distribute the same file in two optional ways:

- a managed mise global `conf.d` fragment, which applies across local repositories;
- a disposable Docker image with the file as its global mise configuration and
  the tools installed during image build.

Per-repository mise files can override versions; existing environment-v1 setup
scripts, CI jobs, native toolchain selection, Git state and credentials remain
outside the toolbox. Docker mounts a checkout at runtime instead of baking it
into the image. Check tool executables when building the image.

## Rationale and trade-offs

Global mise configuration avoids copying an expanding tool list into every
repository. The optional image provides a consistent CLI baseline when host
setup is unavailable. `latest` reduces manual maintenance for non-build tools,
but image builds at different times are not byte-for-byte reproducible; exact
version needs belong to the consuming project or a future locked image profile.
No additional always-on CI or background process is introduced.

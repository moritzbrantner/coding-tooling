# Common coding-agent CLI tools

`mise.toml` at the root of `coding-tooling` owns the optional common CLI baseline.
This is a convenience set, not a new build toolchain or a replacement for each
repository's language-specific setup. Existing CI and
`scripts/codex-environment.sh` do not install the baseline or change their gates.

| Tool       | Executable   | Use                                          |
| ---------- | ------------ | -------------------------------------------- |
| jq         | `jq`         | Query and transform JSON                     |
| ripgrep    | `rg`         | Search source and logs                       |
| fd         | `fd`         | Find files efficiently                       |
| gh         | `gh`         | Inspect GitHub PRs, issues and CI            |
| yq         | `yq`         | Query YAML configuration                     |
| shellcheck | `shellcheck` | Find shell script errors                     |
| shfmt      | `shfmt`      | Format shell scripts                         |
| actionlint | `actionlint` | Validate GitHub Actions workflows            |
| hyperfine  | `hyperfine`  | Compare command-line performance             |
| uv         | `uv`         | Run and manage Python tools and environments |
| just       | `just`       | Run repositories' task recipes when present  |
| bat        | `bat`        | Read source files with context/highlighting  |

These use `latest` deliberately. They are conveniences, not pinned dependencies
for deterministic builds or releases. Project-local `mise.toml` declarations
override global versions; use a repository-specific version or `mise.lock` when
exact reproducibility is needed. No CI workflow is changed by this toolbox.

## On a host machine (all repositories)

Install [mise](https://mise.jdx.dev/getting-started), then from a `coding-tooling`
checkout run:

```bash
./toolbox/install-global.sh --install
./toolbox/install-global.sh --check
```

`--check` is read-only and checks whether the global configuration matches this
repository; the executable smoke is separate. `--install` updates **only** the
managed `coding-agent-tools.toml` file inside mise's global `conf.d/` directory
and installs its tools. It preserves other global settings and installed
toolchains, refuses conflicting unmanaged files or symlinks, and is safe to
repeat. The fragment is loaded in every repository; repo-local declarations
still take precedence. Rerun `--install` when this list changes. If
`MISE_GLOBAL_CONFIG_FILE` is set, this installer refuses to write because mise
would ignore the global `conf.d/` file.

### Noninteractive agent sessions

Installing registers the tools with mise. A launcher must also pass a suitable
`PATH` to the agent. From any project directory, prefix the agent command with
the absolute path to the wrapper in your Coding Tooling checkout:

```bash
/path/to/coding-tooling/toolbox/with-agent-tools.sh codex exec 'Your task'
```

The wrapper adds mise's shim directory to the end of the launch environment's
`PATH` and starts the command in the current directory. Child shells inherit
the path without reading interactive startup files. Existing PATH entries take
priority. When a shim is used, mise resolves the tool in the invocation
directory, including any trusted repository-specific version. Carry over any
custom `MISE_SHIMS_DIR`, `MISE_DATA_DIR`, or `XDG_DATA_HOME` from install time.
For externally managed agents, configure their launch command or environment
with the same shim directory so it reaches the agent process.

Interactive terminals can use `mise activate bash`, which refreshes the
environment at shell hooks. For a single scripted invocation, use
`mise exec -- rg ...` to resolve tools and environment at that invocation's
starting directory. Shims suit agents that change repositories after startup.

From a directory outside the Coding Tooling checkout, verify host discovery
and execution in a noninteractive shell:

```bash
/path/to/coding-tooling/toolbox/with-agent-tools.sh \
  bash --noprofile --norc /path/to/coding-tooling/toolbox/agent-tools-check.sh
```

## Disposable Docker toolbox

Build the image from the root of the `coding-tooling` checkout:

```bash
docker build -f toolbox/Dockerfile -t coding-agent-tools .
```

From **any** repository checkout on Linux, start a toolbox shell with the
current checkout mounted, using the host user's UID/GID so edits are not
created as root-owned files:

```bash
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e MISE_CACHE_DIR=/tmp/mise-cache \
  -v "$PWD:/workspace" -w /workspace \
  coding-agent-tools bash
```

The image contains the baseline tools and their mise shims, not your source,
Git credentials, SSH keys, Docker socket or agent-session state. It does not
automatically provision language-specific toolchains for an arbitrary mounted
repository; use that repository's setup commands for those. The image build
runs `agent-tools-check` to exercise every executable, and you can rerun it
inside the container. Docker is optional and no image is published by this
change. The image's mise release is fixed to a readable tag; the tools resolve
their latest stable versions when the image is built, so rebuild to refresh.

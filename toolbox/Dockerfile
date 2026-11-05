# Optional, disposable CLI-agent toolbox. The source checkout is mounted at runtime,
# never copied into the image. Tool versions resolve at image build time.
FROM ghcr.io/jdx/mise:2026.10.4-debian

# The same project manifest serves as the toolbox's global mise configuration.
# Official mise Debian images already expose /mise/shims on PATH.
COPY mise.toml /mise/config.toml
COPY toolbox/agent-tools-check.sh /usr/local/bin/agent-tools-check

RUN mise install && bash /usr/local/bin/agent-tools-check

WORKDIR /workspace
CMD ["bash"]

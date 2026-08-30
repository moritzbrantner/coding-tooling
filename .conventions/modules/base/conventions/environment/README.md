# Environment conventions

## ENV-001 — Keep irreplaceable development state outside disposable containers

- Containers provide reproducible execution, not source, Git, credentials, worktrees, or agent-session state.

## ENV-002 — Use Docker Compose as the canonical local development and test topology

- Define required local services in Compose and reuse those definitions across development and tests.
- Express differences with configuration, profiles, or explicit overrides; unit tests need no external topology.

## ENV-003 — .env.example is the committed environment contract

- Keep .env local and uncommitted; commit a secret-free .env.example covering supported setup.
- Update .env.example whenever an environment variable changes.

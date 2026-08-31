# Authentication conventions

## AUTHN-001 — A session identifies an account, not an authorization context

- Authenticate a stable account, not a profile, space, membership, or role.
- Prefer revocable server-owned browser sessions with opaque identifiers and secure cookie attributes.
- Resolve mutable authorization facts from authoritative server-side data before protected operations.

## AUTHN-002 — One-time authentication secrets are non-recoverable credentials

- Generate secrets securely; bind them to a subject and purpose; store only a digest where possible.
- Expire and atomically consume them once; never log or expose them outside their delivery channel.
- Do not reveal account or membership existence from unauthenticated flow initiation.

# Authorization conventions

## AUTHZ-001 — Every role assignment has an explicit authority scope

- Keep system and space role assignments distinct and scope-qualified.
- A space role never authorizes outside its space; an override is explicit, narrow, and audited.

## AUTHZ-002 — Authorize every protected operation at the server boundary

- Deny by default using current actor, action, resource, relationships, and context.
- Enforce policy before disclosure or side effects; client checks are not the security boundary.
- Deliberately distinguish unauthenticated, forbidden, and concealed-not-found outcomes.

## AUTHZ-003 — Personal profiles and spaces are authorization resources

- Model profiles, spaces, memberships, ownership, and containment as explicit authoritative relationships.
- Treat active profile or space as untrusted selection state until authorization succeeds.
- Public visibility grants only its documented read capability.

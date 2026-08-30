# Testing conventions

## TEST-001 — Test location follows dependency scope

- Place a test at the lowest source-tree directory containing all production code it covers.

## TEST-002 — Validate tests bottom-up

- Validate from the narrowest affected scope outward; re-run lower layers after production-code fixes.

## TEST-003 — Keep test scope separate from test kind

- Use location for coverage scope and independent names or metadata for execution kind.

## TEST-004 — Test authorization as a decision matrix

- Cover relevant authentication, role, relationship, and context combinations, including denial cases.
- Assert denial causes neither protected disclosure nor side effects.

## TEST-005 — Behavior changes require executable evidence

- Add or update the smallest automated test that would fail without a behavior change or bug fix.

## TEST-006 — Prefer stable public behavior seams

- Test through the highest practical stable interface that exercises the real behavior.
- Callers and tests should normally cross the same seam; avoid coupling tests to private structure when a public seam can prove the behavior.
- Add a lower-level test only when an important rule cannot be exercised reliably through the higher interface.

## TEST-007 — Infer testing strategy from the repository before inventing one

- Reuse the repository's established test layers, commands, fixtures, and public seams.
- Treat test architecture as a design choice only when the existing structure does not provide a safe answer.
- Do not make specs repeat generic testing doctrine that is already encoded here or in repository-local rules.

## TEST-008 — Keep behavior change and structural cleanup distinct

- For approved behavior changes, establish the failing evidence before the production change and return it to green.
- Perform behavior-preserving refactoring only from a green baseline.
- If structural cleanup reveals a test that is insensitive, misleading, or validates the wrong behavior, stop before rewriting the test when doing so could conceal a product or contract decision.

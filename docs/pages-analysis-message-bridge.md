# Pages analysis embedding bridge

`analysis.json` is a browser-executed JSON view, not a conventional HTTP JSON response. Shared GitHub Pages consumers therefore must not use `fetch(...).json()` against that URL.

For browser consumers that need the already-computed remote-preflight result without duplicating `coding-tooling` semantics, the machine view supports an opt-in message bridge:

```text
https://moritzbrantner.github.io/coding-tooling/analysis.json/?repo=owner/repository&postMessage=1
```

When this URL runs inside another page, it posts one message to its parent after analysis completes:

```json
{
  "type": "coding-tooling.analysis.v1",
  "repository": "owner/repository",
  "analysis": {}
}
```

A failed analysis uses the same type and repository binding with an `error.message` instead of `analysis`.

## Boundary and validation

The bridge only transports the result of the existing `analysisJson()` implementation. It does not create another KPI or repository-analysis implementation.

Because the embedded view is public and may be hosted cross-origin, the child uses `postMessage(..., "*")`. A parent consumer must validate all of the following before accepting a message:

- `event.source` is the exact iframe/window it created;
- `event.origin` is the expected `coding-tooling` Pages origin;
- `event.data.type` is `coding-tooling.analysis.v1`;
- `event.data.repository` matches the requested repository.

Consumers must fail closed on timeout, malformed messages, mismatched provenance, or an explicit error message. The bridge does not weaken the existing anonymous-public-repository boundary of Pages analysis.

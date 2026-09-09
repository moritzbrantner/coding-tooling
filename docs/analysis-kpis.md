# GitHub Pages analysis KPIs

The Pages `analysis.json` response includes a versioned `kpis` block that brings progress and verification evidence into the same repository analysis without turning missing evidence into zero or success.

The KPI block is observational. It does not execute repository code in the browser. Each evidence family carries its own `status`, and revision-bearing evidence also carries `freshness` so stale observations cannot be presented as current.

## KPI families

### Work and checklist progress

Pages reads a bounded window of the 20 most recently updated open GitHub issue entries, removes pull requests, and mechanically parses Markdown task lists outside fenced code blocks.

The analysis exposes:

- GitHub's repository-level open item count, whose API semantics combine issues and pull requests;
- inspected issues and issues containing checklists;
- checklist `total`, `completed`, and `remaining` counts;
- checklist completion percentage;
- the first remaining checklist item in the bounded window.

Checklist totals are mechanical task-box counts. Overlapping umbrella/dependent issues are not semantically de-duplicated, so the aggregate is not a claim of unique convergence work. When the GitHub issue window is full, checklist aggregation is `incomplete` rather than claiming an exhaustive repository total.

### Test coverage

The KPI reader consumes the existing normalized snapshot from:

```text
branch: coding-tooling-observations
path:   .coding-tooling/test-coverage.json
```

It reports line, statement, function, and branch coverage only when those native measurements exist. Each metric retains covered, total, uncovered, and percent values. A missing metric stays `null`.

The snapshot revision is compared with the currently observed default-branch head. A stale snapshot remains visible but is `incomplete`, not current evidence.

Function coverage means that the native coverage producer observed execution of the function during tests. It does not claim that each covered function has a meaningful assertion.

### Public contracts and HTTP endpoints

Executed public-contract evidence is published to:

```text
branch: coding-tooling-observations
path:   .coding-tooling/public-contract.json
```

The snapshot wraps the schema-v1 `coding-tooling contract verify` report with repository, exact revision, generation time, and producer provenance.

The KPI reader reports:

- public contracts discovered / verified / unverified;
- incomplete public-contract discovery;
- public-contract verified ratio;
- HTTP operations discovered / verified / unverified;
- HTTP verified ratio.

An HTTP endpoint counts as verified only when the executed public-contract report marks the surface verified or contains passing strong evidence such as behavioral or contract verification. Merely declaring an endpoint, mapping a capability, or proving reachability does not make the endpoint verified.

### Verification checks

Pages consumes the existing `score-history/history.json` evidence and uses the entry for the exact default-branch revision when available. It reports:

- repository score;
- verification score;
- planned, passed, failed, errored, and blocked checks;
- missing required capabilities.

If only an older history entry is available, the evidence is shown as stale instead of current.

### Findings

The KPI block includes the current remote-preflight finding count and high-priority finding count after opt-in hosted governance policy has been applied.

## Fail-closed rules

- A missing observation is `unavailable`, never zero.
- Malformed observation data is `incomplete`, never green.
- Revision-bearing evidence must match the observed default-branch head to be current.
- A full bounded issue window makes aggregate checklist evidence incomplete.
- Checklist totals are mechanical and are not de-duplicated across overlapping issue scopes.
- Endpoint verification requires executed strong public-contract evidence.
- Coverage and public-contract evidence remain separate: line/function execution coverage does not substitute for public contract verification.

These dimensions are intentionally not collapsed into one synthetic quality score. They are meant to show distinct progress vectors that can move independently across commits.

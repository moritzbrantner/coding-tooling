export function resultEnvelope(operation, status, data, diagnostics = [], durationMs = 0) {
  return { schemaVersion: 1, operation, status, durationMs, data, diagnostics };
}

export function apiEnvelope(operation, result, options = {}) {
  const { schemaVersion: _schemaVersion, operation: _operation, ...data } = result ?? {};
  const evidenceState = options.evidenceState ?? result?.summary?.status ?? null;
  return resultEnvelope(
    operation,
    options.status ?? "passed",
    {
      ...data,
      evidence: {
        complete: options.complete ?? true,
        state: evidenceState,
      },
    },
    options.diagnostics ?? [],
    options.durationMs ?? 0,
  );
}

export function apiErrorEnvelope(operation, code, message, data = {}, durationMs = 0) {
  return resultEnvelope(operation, "error", data, [{ code, message }], durationMs);
}

export function analysisApiEnvelope(analysis, durationMs = 0) {
  const state =
    analysis?.querySummary?.selectionStatus ??
    analysis?.summary?.selectionStatus ??
    analysis?.summary?.status ??
    analysis?.summary?.sourceStatus ??
    "unknown";
  const complete = state !== "incomplete";
  const status = !complete ? "unavailable" : state === "needs-attention" ? "failed" : "passed";
  return apiEnvelope(analysis?.operation ?? "remote-preflight-query", analysis, {
    status,
    complete,
    evidenceState: state,
    durationMs,
  });
}

export function testingApiEnvelope(plan, durationMs = 0) {
  const state = plan?.summary?.status ?? "unknown";
  return apiEnvelope("remote-testing-scaffold-plan", plan, {
    status: state === "incomplete" ? "unavailable" : "passed",
    complete: state !== "incomplete",
    evidenceState: state,
    durationMs,
  });
}

export function coverageApiEnvelope(coverage, durationMs = 0) {
  const state = coverage?.summary?.status ?? "unknown";
  return apiEnvelope("test-coverage-observation", coverage, {
    status: state === "available" ? "passed" : "unavailable",
    complete: state === "available" || state === "unavailable",
    evidenceState: state,
    durationMs,
  });
}

export function discoveryApiEnvelope(discovery, durationMs = 0) {
  const state = discovery?.summary?.status ?? "unknown";
  const complete = !discovery?.source?.truncated;
  return apiEnvelope("repository-discovery", discovery, {
    status: complete ? "passed" : "unavailable",
    complete,
    evidenceState: state,
    durationMs,
  });
}

export function nextWorkApiEnvelope(result, durationMs = 0) {
  const state = result?.summary?.status ?? "unknown";
  const complete = !(result?.source?.pullsTruncated || result?.source?.issueWindowTruncated);
  return apiEnvelope("next-work-discovery", result, {
    status: complete ? "passed" : "unavailable",
    complete,
    evidenceState: state,
    durationMs,
  });
}

export function envelopeRequested(parameters) {
  return parameters.get("envelope") === "1";
}

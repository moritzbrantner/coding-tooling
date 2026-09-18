export function apiEnvelope(operation, result, options = {}) {
  const { schemaVersion: _schemaVersion, operation: _operation, ...data } = result ?? {};
  const evidenceState = options.evidenceState ?? result?.summary?.status ?? null;
  return {
    schemaVersion: 1,
    operation,
    status: options.status ?? "passed",
    durationMs: options.durationMs ?? 0,
    data: {
      ...data,
      evidence: {
        complete: options.complete ?? true,
        state: evidenceState,
      },
    },
    diagnostics: options.diagnostics ?? [],
  };
}

export function apiErrorEnvelope(operation, code, message, data = {}, durationMs = 0) {
  return {
    schemaVersion: 1,
    operation,
    status: "error",
    durationMs,
    data,
    diagnostics: [{ code, message }],
  };
}

export function analysisApiEnvelope(analysis, durationMs = 0) {
  const state =
    analysis?.summary?.status ??
    analysis?.summary?.sourceStatus ??
    analysis?.querySummary?.sourceStatus ??
    "unknown";
  const complete = state !== "incomplete";
  const status = !complete
    ? "unavailable"
    : state === "needs-attention"
      ? "failed"
      : "passed";
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
  return apiEnvelope("repository-discovery", discovery, {
    status: "passed",
    complete: !discovery?.source?.truncated,
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

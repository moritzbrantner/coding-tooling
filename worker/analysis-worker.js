import { analysisApiEnvelope, apiErrorEnvelope, envelopeRequested } from "../site/api-envelope.js";
import { analysisQueryJson } from "../site/analysis-query.js";

const jsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const exactSha = /^[0-9a-f]{40}$/i;
const analysisPaths = new Set(["/analysis.json", "/analysis.json/"]);

export default {
  fetch(request, env) {
    return handleAnalysisRequest(request, env);
  },
};

export async function handleAnalysisRequest(request, env = {}, options = {}) {
  const started = Date.now();
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: jsonHeaders,
    });
  }

  if (request.method !== "GET") {
    return errorResponse(
      "remote-preflight-query",
      "method-not-allowed",
      "Only GET and OPTIONS are supported.",
      405,
      started,
      { allow: "GET, OPTIONS" },
    );
  }

  if (!analysisPaths.has(url.pathname)) {
    return errorResponse(
      "remote-preflight-query",
      "route-not-found",
      "Use /analysis.json?repo=owner/repository.",
      404,
      started,
    );
  }

  const repository = url.searchParams.get("repo");
  const useEnvelope = envelopeRequested(url.searchParams);
  if (!repository) {
    return errorResponse(
      "remote-preflight-query",
      "invalid-analysis-url",
      "Missing required ?repo=owner/repository query parameter.",
      400,
      started,
      {},
      useEnvelope,
    );
  }

  const analysisParameters = new URLSearchParams(url.searchParams);
  analysisParameters.delete("envelope");

  try {
    const analyze = options.analysisQueryJson ?? analysisQueryJson;
    const fetchImpl = createGithubFetch(env.GITHUB_TOKEN, options.fetchImpl ?? fetch);
    const analysis = await analyze(repository, analysisParameters, { fetchImpl });
    const durationMs = Date.now() - started;
    const result = useEnvelope ? analysisApiEnvelope(analysis, durationMs) : analysis;

    return jsonResponse(result, 200, {
      "Cache-Control": cacheControl(url.searchParams),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(
      "remote-preflight-query",
      "analysis-request-failed",
      message,
      errorStatus(message),
      started,
      { repository },
      useEnvelope,
    );
  }
}

export function createGithubFetch(token, fetchImpl = fetch) {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    headers.delete("Cookie");

    const url = new URL(typeof input === "string" ? input : input.url);
    if (token && url.hostname === "api.github.com") {
      headers.set("Authorization", `Bearer ${token}`);
    }

    return fetchImpl(input, {
      ...init,
      headers,
    });
  };
}

function cacheControl(parameters) {
  const ref = parameters.get("ref")?.trim() ?? "";
  return exactSha.test(ref)
    ? "public, max-age=300, s-maxage=86400, immutable"
    : "public, max-age=30, s-maxage=60, stale-while-revalidate=300";
}

function errorStatus(message) {
  if (message.startsWith("Repository not found.")) return 404;
  if (message.startsWith("GitHub rejected")) return 429;
  if (message.startsWith("GitHub API request failed")) return 502;
  if (
    /^(Enter owner\/repository|Missing required|Unsupported analysis query parameter|view must|focus must|min-severity must|limit must|head requires|tier requires|Unknown analysis scope|Finding is not available)/.test(
      message,
    )
  ) {
    return 400;
  }
  return 500;
}

function errorResponse(operation, code, message, status, started, data = {}, useEnvelope = true) {
  const durationMs = Date.now() - started;
  const result = useEnvelope
    ? apiErrorEnvelope(operation, code, message, data, durationMs)
    : {
        schemaVersion: 1,
        operation,
        summary: { status: "error" },
        error: { message },
      };

  return jsonResponse(result, status, {
    ...(status === 405 ? { Allow: "GET, OPTIONS" } : {}),
    "Cache-Control": "no-store",
  });
}

function jsonResponse(value, status, extraHeaders = {}) {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    headers: {
      ...jsonHeaders,
      ...extraHeaders,
    },
  });
}

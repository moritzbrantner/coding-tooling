import { failureCategories } from "./ci-reliability-attribution.ts";
import { formatSeconds } from "./ci-durations.ts";
import type { CiReliabilityData, FirstAttemptRate } from "./ci-reliability.ts";

const percent = ({ successes, denominator, rate }: FirstAttemptRate) =>
  rate === null
    ? `n/a (0 applicable)`
    : `${(rate * 100).toFixed(1)}% (${successes}/${denominator})`;

const counts = (values: Record<string, number>) =>
  failureCategories
    .filter((category) => values[category]! > 0)
    .map((category) => `  ${String(values[category]).padStart(5)}  ${category}`);

/** Plain-text report for `--json`-less runs. */
export function formatCiReliability(data: CiReliabilityData, limit = 10): string {
  const scope = [
    `${data.window.since} to ${data.window.until ?? "now"}`,
    ...(data.filters.workflow ? [`workflow ${data.filters.workflow}`] : []),
    ...(data.filters.branch ? [`branch ${data.filters.branch}`] : []),
    ...(data.filters.event ? [`event ${data.filters.event}`] : []),
  ].join(", ");
  const { firstAttempt, redToGreen, runnerTime, attribution, coverage } = data;
  const excluded = firstAttempt.excluded;
  const perHead = redToGreen.perHead;
  const perPull = redToGreen.perPullRequest;
  const merged = runnerTime.perMergedPullRequest;
  return [
    `CI reliability for ${data.repo}: ${scope}. Sampled evidence, not a gate or fleet-wide rate.`,
    [
      `First-attempt success per head: ${percent(firstAttempt)}`,
      `  excluded: ${excluded.pending} pending, ${excluded.cancelledSuperseded} cancelled superseded, ${excluded.cancelled} cancelled, ${excluded.skipped} skipped, ${excluded.notApplicable} not applicable, ${excluded.firstAttemptUnavailable} first attempt unavailable`,
      ...firstAttempt.segments.map(
        (segment) => `  ${`${segment.scope} / ${segment.actorKind}`.padEnd(26)}${percent(segment)}`,
      ),
    ].join("\n"),
    [
      "First red to green",
      `  same head: median ${formatSeconds(perHead.seconds.median)} over ${perHead.samples} recovered; ${perHead.stillRed} still red, ${perHead.supersededWithoutGreen} superseded without green, ${perHead.pending} pending`,
      `  pull request (may cross heads): median ${formatSeconds(perPull.seconds.median)} over ${perPull.samples} recovered; ${perPull.stillRed} without green`,
    ].join("\n"),
    merged
      ? `Runner time per merged PR (not billing): median ${formatSeconds(merged.median)}, p90 ${formatSeconds(merged.p90)}, total ${formatSeconds(runnerTime.totalSeconds)} over ${runnerTime.mergedPullRequests} PRs; excluded ${runnerTime.excluded.openedBeforeCoverage} opened before coverage, ${runnerTime.excluded.noRunsSampled} without sampled runs, ${runnerTime.excluded.missingJobs} missing jobs`
      : `Runner time per merged PR (not billing): unavailable; no merged PR is fully covered (excluded ${runnerTime.excluded.openedBeforeCoverage} opened before coverage, ${runnerTime.excluded.noRunsSampled} without sampled runs, ${runnerTime.excluded.missingJobs} missing jobs)`,
    [
      `Failure attribution: ${attribution.incidents} incidents, ${attribution.unclassified} unknown/unclassified`,
      "  confirmed",
      ...counts(attribution.confirmed),
      "  hypotheses (unconfirmed)",
      ...counts(attribution.hypotheses),
    ].join("\n"),
    [
      "Recurring confirmed causes by wasted runner time, then red-to-green delay",
      ...(data.recurringConfirmedCauses.length === 0
        ? ["  none confirmed"]
        : data.recurringConfirmedCauses.map(
            (cause) =>
              `  ${formatSeconds(cause.wastedRunnerSeconds).padStart(7)} ${formatSeconds(cause.redToGreenSeconds).padStart(7)} x${cause.incidents}  ${cause.category}  ${cause.fingerprint}  ${cause.label}  runs ${cause.runIds.slice(0, 5).join(", ")}`,
          )),
    ].join("\n"),
    [
      `Latest failures (${Math.min(limit, data.failures.length)} of ${data.failures.length})`,
      ...data.failures.slice(0, limit).map((failure) => {
        const { attribution: result } = failure;
        const first = failure.attempts[0]!;
        const verdict =
          result.status === "confirmed"
            ? `confirmed ${result.category}`
            : result.status === "hypothesis"
              ? `hypothesis ${result.hypothesis}`
              : "unclassified";
        const job = failure.firstFailingJob?.name ?? "no job";
        const step =
          failure.firstFailingStep?.name ?? (failure.zeroStep ? "zero steps" : "no step");
        return `  ${failure.headSha.slice(0, 10)} run ${first.runId}#${first.attempt} ${verdict}: ${job} › ${step}  [${failure.fingerprint.id}]`;
      }),
    ].join("\n"),
    [
      `Coverage: ${coverage.runsRead} runs read, ${coverage.runsInScope} in scope, ${coverage.attempts} attempts, ${coverage.failedAttempts} failed (${coverage.failedAttemptsWithoutJobs} without jobs)`,
      ...coverage.warnings.map((warning) => `  warning: ${warning.message}`),
    ].join("\n"),
  ].join("\n\n");
}

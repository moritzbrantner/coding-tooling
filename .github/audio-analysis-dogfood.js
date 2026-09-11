import { loadSnapshot } from "../site/github-analysis.js";
import { analyzeSnapshot } from "../site/preflight.js";

const snapshot = await loadSnapshot({ owner: "moritzbrantner", name: "audio-analysis" });
const analysis = analyzeSnapshot(snapshot);

const inheritedMembers = analysis.components
  .filter(
    (component) =>
      component.kind === "package" &&
      component.path !== "." &&
      component.workspace?.status === "satisfied" &&
      component.toolchain?.reason === "workspace-toolchain-inherited",
  )
  .map((component) => component.path)
  .toSorted();
const nestedPinFindings = analysis.findings
  .filter((finding) => finding.id.startsWith("REMOTE-ENV-006-"))
  .map((finding) => finding.id)
  .toSorted();
const workspaceConflictFindings = analysis.findings
  .filter((finding) => finding.id === "REMOTE-ENV-008")
  .map((finding) => finding.id);
const highFindings = analysis.findings
  .filter((finding) => finding.severity === "high")
  .map((finding) => ({ id: finding.id, title: finding.title }));

const result = {
  repository: analysis.repository.fullName,
  revision: analysis.repository.revision,
  summaryStatus: analysis.summary.status,
  acquisition: analysis.source.manifestAcquisition,
  inheritedWorkspaceMemberCount: inheritedMembers.length,
  inheritedWorkspaceMembers: inheritedMembers,
  nestedPinFindings,
  workspaceConflictFindings,
  highFindings,
};

console.log("DOGFOOD_RESULT_START");
console.log(JSON.stringify(result, null, 2));
console.log("DOGFOOD_RESULT_END");

const acquisition = analysis.source.manifestAcquisition;
const failures = [];
if (!/^[0-9a-f]{40}$/i.test(analysis.repository.revision ?? ""))
  failures.push("exact audio-analysis revision was not established");
if (analysis.source.manifestFetchTruncated)
  failures.push("manifest acquisition is still truncated");
if (acquisition?.reason !== "within-byte-budget")
  failures.push(`unexpected manifest acquisition reason: ${acquisition?.reason ?? "missing"}`);
if (acquisition?.selectedCount !== acquisition?.eligibleCount)
  failures.push(
    `manifest acquisition selected ${acquisition?.selectedCount ?? "?"} of ${acquisition?.eligibleCount ?? "?"}`,
  );
if ((acquisition?.eligibleCount ?? 0) < 28)
  failures.push(`expected at least 28 eligible manifest/context files, saw ${acquisition?.eligibleCount ?? 0}`);
if (inheritedMembers.length === 0)
  failures.push("no proven workspace member inherited the canonical root toolchain identity");
if (nestedPinFindings.length > 0)
  failures.push(`false nested-pin findings remain: ${nestedPinFindings.join(", ")}`);
if (workspaceConflictFindings.length > 0)
  failures.push("workspace conflict finding remains after repository deduplication");

if (failures.length > 0) {
  console.error(`DOGFOOD_FAILURE: ${failures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("DOGFOOD_ASSERTIONS: passed");
}

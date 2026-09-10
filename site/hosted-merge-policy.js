export function applyHostedMergePolicy(analysis, declaration, consistency) {
  const policy = hostedMergePolicyFinding(declaration, consistency);
  if (!policy) return analysis;

  const findings = [...analysis.findings, policy.finding];
  const highPriorityFindingCount = findings.filter((finding) => finding.severity === "high").length;
  const status = policy.incomplete
    ? "incomplete"
    : analysis.summary.status === "incomplete"
      ? "incomplete"
      : highPriorityFindingCount > 0
        ? "needs-attention"
        : analysis.summary.status;

  return {
    ...analysis,
    summary: {
      ...analysis.summary,
      status,
      findingCount: findings.length,
      highPriorityFindingCount,
    },
    findings,
  };
}

function hostedMergePolicyFinding(declaration, consistency) {
  if (declaration?.state === "invalid")
    return {
      incomplete: false,
      finding: {
        id: "REMOTE-GOVERNANCE-003",
        severity: "high",
        title: "Declared merge authority is invalid",
        evidence: `.coding-tooling.json contains an unusable merge authority declaration (${declaration.reason ?? "invalid-declaration"}).`,
        recommendation:
          "Repair the repository-declared merge authority before using it as acceptance evidence.",
      },
    };

  if (declaration?.state !== "declared" || declaration.authority !== "hosted") return null;

  if (consistency?.state === "mismatch") {
    const missing = consistency.missingDeclaredChecks ?? [];
    const missingText = missing.length ? missing.join(", ") : "none reported";
    return {
      incomplete: false,
      finding: {
        id: "REMOTE-GOVERNANCE-001",
        severity: "high",
        title: "Declared hosted merge authority is not enforced",
        evidence: consistency.branchProtected
          ? `The default branch is protected, but declared hosted checks are not all enforced. Missing: ${missingText}.`
          : `The repository declares hosted merge authority, but the default branch is observed as unprotected. Missing declared checks: ${missingText}.`,
        recommendation:
          "Enforce the declared hosted checks through GitHub branch or ruleset governance, or change the repository declaration if hosted enforcement is not authoritative.",
      },
    };
  }

  if (consistency?.state === "unavailable")
    return {
      incomplete: true,
      finding: {
        id: "REMOTE-GOVERNANCE-002",
        severity: "medium",
        title: "Hosted merge enforcement could not be verified",
        evidence: `The repository declares hosted merge authority, but GitHub enforcement evidence is unavailable (${consistency.reason ?? "unknown-reason"}).`,
        recommendation:
          "Use authoritative hosted or local evidence before treating the declared hosted checks as enforced.",
      },
    };

  return null;
}

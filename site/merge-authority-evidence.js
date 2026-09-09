export function declaredMergeAuthorityEvidence(config) {
  if (!config?.merge)
    return {
      state: "unavailable",
      authority: null,
      requiredChecks: [],
      reason: null,
      source: null,
      observedEnforcement: "not-evaluated",
    };

  const merge = config.merge;
  if (!merge || typeof merge !== "object" || Array.isArray(merge))
    return invalidDeclaration("merge-must-be-an-object");
  if (!new Set(["hosted", "local"]).has(merge.authority))
    return invalidDeclaration("merge-authority-must-be-hosted-or-local");

  if (merge.authority === "hosted") {
    if (
      !Array.isArray(merge.requiredChecks) ||
      merge.requiredChecks.length === 0 ||
      merge.requiredChecks.some((check) => typeof check !== "string" || !check.trim())
    )
      return invalidDeclaration("hosted-authority-requires-required-checks");

    return {
      state: "declared",
      authority: "hosted",
      requiredChecks: [...new Set(merge.requiredChecks.map((check) => check.trim()))].toSorted(),
      reason: null,
      source: ".coding-tooling.json",
      observedEnforcement: "not-evaluated",
    };
  }

  if (typeof merge.reason !== "string" || !merge.reason.trim())
    return invalidDeclaration("local-authority-requires-reason");
  return {
    state: "declared",
    authority: "local",
    requiredChecks: [],
    reason: merge.reason.trim(),
    source: ".coding-tooling.json",
    observedEnforcement: "not-evaluated",
  };
}

export function mergeAuthorityConsistency(declaration, defaultBranchProtection) {
  if (declaration?.state === "invalid")
    return consistency("invalid", declaration, defaultBranchProtection, {
      reason: "declared-merge-authority-invalid",
    });
  if (declaration?.state !== "declared")
    return consistency("not-applicable", declaration, defaultBranchProtection, {
      reason: "merge-authority-not-declared",
    });
  if (declaration.authority === "local")
    return consistency("not-applicable", declaration, defaultBranchProtection, {
      reason: "local-authority-does-not-depend-on-github-enforcement",
    });
  if (defaultBranchProtection?.status !== "observed")
    return consistency("unavailable", declaration, defaultBranchProtection, {
      reason: defaultBranchProtection?.reason ?? "default-branch-protection-unavailable",
    });
  if (!defaultBranchProtection.protected)
    return consistency("mismatch", declaration, defaultBranchProtection, {
      reason: "default-branch-unprotected",
      enforcedRequiredChecks: observedCheckNames(defaultBranchProtection),
      missingDeclaredChecks: declaration.requiredChecks,
    });
  if (defaultBranchProtection.requiredStatusChecks?.status !== "observed")
    return consistency("unavailable", declaration, defaultBranchProtection, {
      reason:
        defaultBranchProtection.requiredStatusChecks?.reason ?? "required-status-checks-unavailable",
    });

  const declared = declaration.requiredChecks;
  const enforced = observedCheckNames(defaultBranchProtection);
  const enforcedSet = new Set(enforced);
  const declaredSet = new Set(declared);
  const missingDeclaredChecks = declared.filter((check) => !enforcedSet.has(check));
  const additionalEnforcedChecks = enforced.filter((check) => !declaredSet.has(check));
  return consistency(missingDeclaredChecks.length ? "mismatch" : "aligned", declaration, defaultBranchProtection, {
    reason: missingDeclaredChecks.length ? "declared-checks-not-enforced" : "declared-checks-enforced",
    enforcedRequiredChecks: enforced,
    missingDeclaredChecks,
    additionalEnforcedChecks,
  });
}

function consistency(state, declaration, defaultBranchProtection, overrides = {}) {
  return {
    state,
    authority: declaration?.authority ?? null,
    declaredRequiredChecks: declaration?.requiredChecks ?? [],
    enforcedRequiredChecks: null,
    missingDeclaredChecks: [],
    additionalEnforcedChecks: [],
    branchProtected:
      defaultBranchProtection?.status === "observed"
        ? defaultBranchProtection.protected
        : null,
    reason: null,
    ...overrides,
  };
}

function invalidDeclaration(reason) {
  return {
    state: "invalid",
    authority: null,
    requiredChecks: [],
    reason,
    source: ".coding-tooling.json",
    observedEnforcement: "not-evaluated",
  };
}

function observedCheckNames(defaultBranchProtection) {
  return defaultBranchProtection.requiredStatusChecks?.status === "observed"
    ? [...new Set(defaultBranchProtection.requiredStatusChecks.names ?? [])].toSorted()
    : [];
}

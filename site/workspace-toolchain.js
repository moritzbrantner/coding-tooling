const SIMPLE_WORKSPACE_PATTERN = /^[A-Za-z0-9_.@/*?-]+$/;

export function resolveWorkspacePackages(components, rootManifest) {
  const root = components.find(
    (component) => component.kind === "package" && component.path === ".",
  );
  const patterns = workspacePatterns(rootManifest);
  if (!root || patterns.length === 0) return components;

  const rootManager = commandManagerFromComponent(root);
  return components.map((component) => {
    if (component.kind !== "package" || component.path === ".") return component;
    const membership = workspaceMembership(component.path, patterns);
    if (membership.status !== "satisfied") return component;

    const resolved = {
      ...component,
      workspace: membership,
    };
    if (root.toolchain?.status !== "satisfied") return resolved;

    const local = component.toolchain;
    if (local?.status === "satisfied") {
      if (sameToolchainIdentity(local, root.toolchain)) return resolved;
      return {
        ...resolved,
        toolchain: {
          ...local,
          status: "finding",
          reason: "workspace-toolchain-conflict",
          workspaceOwnerPath: root.path,
          workspaceIdentity: toolchainIdentity(root.toolchain),
          provenance: [
            ...new Set([...(root.toolchain.provenance ?? []), ...(local.provenance ?? [])]),
          ],
        },
      };
    }

    if (local?.status === "finding" || local?.status === "unsupported") return resolved;

    const localManager = explicitCommandManager(component.evidence);
    if (localManager && rootManager && localManager !== rootManager) return resolved;

    return {
      ...resolved,
      capabilities: packageCapabilities(component.declaredCapabilities, rootManager),
      toolchain: {
        ...root.toolchain,
        reason: "workspace-toolchain-inherited",
        inheritedFrom: root.path,
        provenance: root.toolchain.provenance ?? [],
      },
    };
  });
}

export function workspaceToolchainConflict(components) {
  const conflicting = components
    .filter(
      (component) =>
        component.kind === "package" &&
        component.toolchain?.reason === "workspace-toolchain-conflict",
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));
  if (conflicting.length === 0) return null;

  const root = components.find(
    (component) => component.kind === "package" && component.path === ".",
  );
  return {
    root: root ? { path: root.path, identity: toolchainIdentity(root.toolchain) } : null,
    members: conflicting.map((component) => ({
      name: component.name,
      path: component.path,
      identity: toolchainIdentity(component.toolchain),
      pattern: component.workspace?.pattern ?? null,
    })),
  };
}

function workspacePatterns(manifest) {
  const value = manifest?.workspaces;
  const declared = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.packages)
      ? value.packages
      : [];
  if (
    declared.some(
      (pattern) =>
        typeof pattern !== "string" ||
        pattern.trim().length === 0 ||
        pattern.trim().startsWith("!"),
    )
  ) {
    return [];
  }
  return declared.map((pattern) => pattern.trim().replace(/^\.\//, "").replace(/\/$/, ""));
}

function workspaceMembership(path, patterns) {
  for (const pattern of patterns) {
    const matcher = workspacePatternMatcher(pattern);
    if (!matcher) continue;
    if (matcher.test(path)) {
      return {
        status: "satisfied",
        ownerPath: ".",
        manifestPath: "package.json",
        pattern,
        provenance: [{ collector: "github", path: "package.json" }],
      };
    }
  }
  return { status: "unsupported", reason: "workspace-membership-not-proven" };
}

function workspacePatternMatcher(pattern) {
  if (!SIMPLE_WORKSPACE_PATTERN.test(pattern) || /[!{}[\]]/.test(pattern)) return null;
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*" && pattern[index + 2] === "/") {
      expression += "(?:.*/)?";
      index += 2;
    } else if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`);
}

function commandManagerFromComponent(component) {
  const capability = Object.values(component.capabilities ?? {}).find(
    (command) => Array.isArray(command) && command.length > 0,
  );
  if (capability?.[0] === "bun") return "bun";
  if (capability?.[0] === "npm") return "npm";
  return explicitCommandManager(component.evidence);
}

function explicitCommandManager(evidence) {
  const declared = evidence?.facts?.packageManager?.value;
  if (typeof declared === "string") {
    if (declared.startsWith("bun@")) return "bun";
    if (declared.startsWith("npm@")) return "npm";
    return null;
  }
  const lockfiles = evidence?.facts?.lockfiles?.value ?? [];
  if (lockfiles.includes("bun.lock") || lockfiles.includes("bun.lockb")) return "bun";
  if (lockfiles.includes("package-lock.json")) return "npm";
  return null;
}

function packageCapabilities(declaredCapabilities, manager) {
  if (!manager) return {};
  return Object.fromEntries(
    Object.entries(declaredCapabilities ?? {}).map(([capability, script]) => [
      capability,
      manager === "bun" ? ["bun", "run", script] : ["npm", "run", script],
    ]),
  );
}

function sameToolchainIdentity(left, right) {
  return left?.runtime === right?.runtime && left?.version === right?.version;
}

function toolchainIdentity(toolchain) {
  if (!toolchain) return null;
  return {
    manager: toolchain.manager ?? null,
    runtime: toolchain.runtime ?? null,
    version: toolchain.version ?? null,
  };
}

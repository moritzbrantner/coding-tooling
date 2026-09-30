import type { Diagnostic } from "./model.ts";

export type RepositoryArchitecture = {
  owns: string[];
  consumes: string[];
  mustNotOwn: string[];
};

export type RepositoryLifecycleCommand = {
  command: string[];
  check: string[];
  timeoutSeconds: number;
};

export type RepositoryPages =
  | ({ status: "enabled" } & RepositoryLifecycleCommand)
  | { status: "not-applicable"; reason: string };

export type RepositoryContractDeclarations = {
  architecture?: RepositoryArchitecture;
  bootstrap?: RepositoryLifecycleCommand;
  pages?: RepositoryPages;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function argv(value: unknown): value is string[] {
  return (
    strings(value) &&
    value.length > 0 &&
    value[0]!.trim().length > 0 &&
    value.every((entry) => !entry.includes("\0"))
  );
}

function sorted(values: string[]): string[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- Sort a new array under the repository's ES2022 target.
  return [...new Set(values)].sort();
}

export function capabilityBoundaryMatches(boundary: string, capability: string): boolean {
  return capability === boundary || capability.startsWith(`${boundary}/`);
}

export function forbiddenAuthorityClaims(
  architecture: RepositoryArchitecture,
  claims: string[],
): Array<{ capability: string; exclusion: string }> {
  return sorted(claims).flatMap((capability) =>
    architecture.mustNotOwn
      .filter((exclusion) => capabilityBoundaryMatches(exclusion, capability))
      .map((exclusion) => ({ capability, exclusion })),
  );
}

export function parseRepositoryContractDeclarations(
  source: string,
  diagnostics: Diagnostic[],
): RepositoryContractDeclarations {
  function invalid(section: string, message: string): void {
    diagnostics.push({
      code: "repository-contract-declaration-invalid",
      message: `${section}: ${message}`,
      path: ".repository.toml",
    });
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (error) {
    diagnostics.push({
      code: "repository-metadata-unreadable",
      message: error instanceof Error ? error.message : String(error),
      path: ".repository.toml",
    });
    return {};
  }
  if (!record(parsed)) return {};

  function table(name: string, keys: string[]): Record<string, unknown> | undefined {
    const value = record(parsed) ? parsed[name] : undefined;
    if (value === undefined) return undefined;
    if (!record(value)) {
      invalid(name, "must be a table");
      return undefined;
    }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) invalid(name, `unsupported field ${key}`);
    }
    return value;
  }

  function lifecycle(
    name: string,
    value: Record<string, unknown>,
  ): RepositoryLifecycleCommand | undefined {
    if (!argv(value.command) || !argv(value.check)) {
      invalid(name, "command and check must be nonempty argument arrays");
      return undefined;
    }
    const timeoutSeconds = value.timeout_seconds ?? 300;
    if (
      typeof timeoutSeconds !== "number" ||
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 1800
    ) {
      invalid(name, "timeout_seconds must be an integer from 1 to 1800");
      return undefined;
    }
    return { command: value.command, check: value.check, timeoutSeconds };
  }

  const result: RepositoryContractDeclarations = {};
  const architecture = table("architecture", ["owns", "consumes", "must_not_own"]);
  if (architecture) {
    const { owns, consumes, must_not_own: mustNotOwn } = architecture;
    if (
      !strings(owns) ||
      !strings(consumes) ||
      !strings(mustNotOwn) ||
      [...owns, ...consumes, ...mustNotOwn].some(
        (value) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) || value.endsWith("/"),
      )
    ) {
      invalid("architecture", "owns, consumes and must_not_own must declare stable capability IDs");
    } else {
      result.architecture = {
        owns: sorted(owns),
        consumes: sorted(consumes),
        mustNotOwn: sorted(mustNotOwn),
      };
    }
  }

  const bootstrap = table("bootstrap", ["command", "check", "timeout_seconds"]);
  if (bootstrap) result.bootstrap = lifecycle("bootstrap", bootstrap);

  const pages = table("pages", ["status", "reason", "command", "check", "timeout_seconds"]);
  if (pages?.status === "enabled") {
    const commands = lifecycle("pages", pages);
    if (pages.reason !== undefined) invalid("pages", "enabled Pages cannot declare an N/A reason");
    if (commands) result.pages = { status: "enabled", ...commands };
  } else if (pages?.status === "not-applicable") {
    if (typeof pages.reason !== "string" || !pages.reason.trim()) {
      invalid("pages", "not-applicable requires a reason");
    } else if (
      pages.command !== undefined ||
      pages.check !== undefined ||
      pages.timeout_seconds !== undefined
    ) {
      invalid("pages", "not-applicable cannot declare build or acceptance commands");
    } else {
      result.pages = { status: "not-applicable", reason: pages.reason };
    }
  } else if (pages) {
    invalid("pages", "status must be enabled or not-applicable");
  }
  return result;
}

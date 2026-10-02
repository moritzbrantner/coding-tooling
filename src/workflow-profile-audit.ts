import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { Diagnostic, ResultEnvelope } from "./model.ts";

type WorkflowException = {
  path: string;
  reason: string;
};

type WorkflowProfileDeclaration = {
  schemaVersion: 1;
  catalog: "workflow-profiles-v1";
  catalogDigest: string;
  profile: string;
  enabledRoles: string[];
  workflows: Record<string, string>;
  exceptions?: WorkflowException[];
};

const declarationRelativePath = ".github/workflow-profile.json";
const workflowPathPattern = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDeclaration(path: string): {
  declaration: WorkflowProfileDeclaration | null;
  diagnostics: Diagnostic[];
} {
  if (!existsSync(path)) {
    return {
      declaration: null,
      diagnostics: [
        {
          code: "workflow-profile-declaration-missing",
          message: `${declarationRelativePath} is missing`,
          path: declarationRelativePath,
        },
      ],
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    return {
      declaration: null,
      diagnostics: [
        {
          code: "workflow-profile-declaration-invalid-json",
          message: error instanceof Error ? error.message : String(error),
          path: declarationRelativePath,
        },
      ],
    };
  }

  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    diagnostics.push({
      code: "workflow-profile-declaration-invalid",
      message: "Workflow profile declaration must be a JSON object",
      path: declarationRelativePath,
    });
    return { declaration: null, diagnostics };
  }

  if (value.schemaVersion !== 1) {
    diagnostics.push({
      code: "workflow-profile-schema-version-invalid",
      message: "schemaVersion must be 1",
      path: declarationRelativePath,
    });
  }
  if (value.catalog !== "workflow-profiles-v1") {
    diagnostics.push({
      code: "workflow-profile-catalog-invalid",
      message: "catalog must be workflow-profiles-v1",
      path: declarationRelativePath,
    });
  }
  if (typeof value.catalogDigest !== "string" || !digestPattern.test(value.catalogDigest)) {
    diagnostics.push({
      code: "workflow-profile-catalog-digest-invalid",
      message: "catalogDigest must be a sha256:<64 lowercase hex> digest",
      path: declarationRelativePath,
    });
  }
  if (typeof value.profile !== "string" || value.profile.trim() === "") {
    diagnostics.push({
      code: "workflow-profile-id-invalid",
      message: "profile must be a non-empty string",
      path: declarationRelativePath,
    });
  }

  const enabledRoles = Array.isArray(value.enabledRoles) ? value.enabledRoles : null;
  if (
    !enabledRoles ||
    enabledRoles.some((role) => typeof role !== "string" || role.trim() === "") ||
    new Set(enabledRoles).size !== enabledRoles.length
  ) {
    diagnostics.push({
      code: "workflow-profile-enabled-roles-invalid",
      message: "enabledRoles must contain unique non-empty strings",
      path: declarationRelativePath,
    });
  }

  const workflows = isRecord(value.workflows) ? value.workflows : null;
  if (!workflows) {
    diagnostics.push({
      code: "workflow-profile-workflows-invalid",
      message: "workflows must map enabled roles to canonical workflow paths",
      path: declarationRelativePath,
    });
  } else {
    for (const [role, path] of Object.entries(workflows)) {
      if (typeof path !== "string" || !workflowPathPattern.test(path)) {
        diagnostics.push({
          code: "workflow-profile-workflow-path-invalid",
          message: `Workflow role ${role} has invalid path ${String(path)}`,
          path: declarationRelativePath,
        });
      }
    }
  }

  if (enabledRoles && workflows) {
    const workflowRoles = Object.keys(workflows).sort();
    const declaredRoles = [...enabledRoles].sort();
    if (JSON.stringify(workflowRoles) !== JSON.stringify(declaredRoles)) {
      diagnostics.push({
        code: "workflow-profile-role-map-mismatch",
        message: "workflows keys must exactly match enabledRoles",
        path: declarationRelativePath,
      });
    }
  }

  const exceptionsValue = value.exceptions ?? [];
  if (!Array.isArray(exceptionsValue)) {
    diagnostics.push({
      code: "workflow-profile-exceptions-invalid",
      message: "exceptions must be an array",
      path: declarationRelativePath,
    });
  } else {
    const seen = new Set<string>();
    for (const exception of exceptionsValue) {
      if (
        !isRecord(exception) ||
        typeof exception.path !== "string" ||
        !workflowPathPattern.test(exception.path) ||
        typeof exception.reason !== "string" ||
        exception.reason.trim().length < 8
      ) {
        diagnostics.push({
          code: "workflow-profile-exception-invalid",
          message: "Each exception requires a canonical workflow path and a concrete reason",
          path: declarationRelativePath,
        });
        continue;
      }
      if (seen.has(exception.path)) {
        diagnostics.push({
          code: "workflow-profile-exception-duplicate",
          message: `Duplicate exception for ${exception.path}`,
          path: declarationRelativePath,
        });
      }
      seen.add(exception.path);
    }
  }

  if (diagnostics.length > 0) return { declaration: null, diagnostics };

  return {
    declaration: {
      schemaVersion: 1,
      catalog: "workflow-profiles-v1",
      catalogDigest: value.catalogDigest as string,
      profile: value.profile as string,
      enabledRoles: enabledRoles as string[],
      workflows: workflows as Record<string, string>,
      exceptions: exceptionsValue as WorkflowException[],
    },
    diagnostics,
  };
}

function actualWorkflowPaths(root: string): {
  paths: string[];
  diagnostics: Diagnostic[];
} {
  const directory = join(root, ".github", "workflows");
  if (!existsSync(directory)) {
    return { paths: [], diagnostics: [] };
  }

  try {
    if (!statSync(directory).isDirectory()) {
      return {
        paths: [],
        diagnostics: [
          {
            code: "workflow-profile-workflows-path-invalid",
            message: ".github/workflows exists but is not a directory",
            path: ".github/workflows",
          },
        ],
      };
    }

    return {
      paths: readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
        .map((entry) => `.github/workflows/${entry.name}`)
        .sort(),
      diagnostics: [],
    };
  } catch (error) {
    return {
      paths: [],
      diagnostics: [
        {
          code: "workflow-profile-workflows-unreadable",
          message: error instanceof Error ? error.message : String(error),
          path: ".github/workflows",
        },
      ],
    };
  }
}

export function workflowProfileAudit(root: string): ResultEnvelope<Record<string, unknown>> {
  const started = Date.now();
  const resolvedRoot = resolve(root);
  const { declaration, diagnostics } = readDeclaration(join(resolvedRoot, declarationRelativePath));
  const inventory = actualWorkflowPaths(resolvedRoot);
  const actual = inventory.paths;
  diagnostics.push(...inventory.diagnostics);

  if (!declaration) {
    return {
      schemaVersion: 1,
      operation: "workflow-profile",
      status: "failed",
      durationMs: Date.now() - started,
      data: {
        reportVersion: 1,
        root: resolvedRoot,
        repositoryName: basename(resolvedRoot),
        declarationPath: declarationRelativePath,
        actualWorkflows: actual,
      },
      diagnostics,
    };
  }

  const expected = Object.values(declaration.workflows).sort();
  const exceptions = (declaration.exceptions ?? []).map((entry) => entry.path).sort();
  const expectedSet = new Set(expected);
  const exceptionSet = new Set(exceptions);

  for (const path of expected) {
    if (exceptionSet.has(path)) {
      diagnostics.push({
        code: "workflow-profile-exception-overlaps-managed",
        message: `${path} is both canonical and excepted`,
        path: declarationRelativePath,
      });
    }
  }

  const missing = expected.filter((path) => !actual.includes(path));
  const missingExceptions = exceptions.filter((path) => !actual.includes(path));
  const unexpected = actual.filter((path) => !expectedSet.has(path) && !exceptionSet.has(path));

  for (const path of missing) {
    diagnostics.push({
      code: "workflow-profile-workflow-missing",
      message: `Expected canonical workflow ${path} is missing`,
      path,
    });
  }
  for (const path of missingExceptions) {
    diagnostics.push({
      code: "workflow-profile-exception-workflow-missing",
      message: `Excepted workflow ${path} is missing`,
      path,
    });
  }
  for (const path of unexpected) {
    diagnostics.push({
      code: "workflow-profile-workflow-unexpected",
      message: `${path} is outside the selected workflow profile and has no exception`,
      path,
    });
  }

  return {
    schemaVersion: 1,
    operation: "workflow-profile",
    status: diagnostics.length === 0 ? "passed" : "failed",
    durationMs: Date.now() - started,
    data: {
      reportVersion: 1,
      root: resolvedRoot,
      repositoryName: basename(resolvedRoot),
      declarationPath: declarationRelativePath,
      catalog: declaration.catalog,
      catalogDigest: declaration.catalogDigest,
      profile: declaration.profile,
      enabledRoles: [...declaration.enabledRoles].sort(),
      expectedWorkflows: expected,
      exceptionWorkflows: exceptions,
      actualWorkflows: actual,
      missingWorkflows: missing,
      missingExceptionWorkflows: missingExceptions,
      unexpectedWorkflows: unexpected,
      summary: {
        expected: expected.length,
        exceptions: exceptions.length,
        actual: actual.length,
        missing: missing.length,
        missingExceptions: missingExceptions.length,
        unexpected: unexpected.length,
      },
    },
    diagnostics,
  };
}

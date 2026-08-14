import { existsSync, readFileSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  commandAvailable,
  pathName,
  readJson,
  relativePosix,
  repositoryRoot,
  runCommand,
  walkFiles,
} from "./shared.ts";

export const capabilityOrder = [
  "format:check",
  "lint",
  "typecheck",
  "build",
  "test",
  "test:unit",
  "test:integration",
  "test:e2e",
  "gate:final",
] as const;

export type Capability = (typeof capabilityOrder)[number];
export type Status = "passed" | "failed" | "unavailable" | "error";
export type Diagnostic = { code?: string; message: string; path?: string };
export type Component = {
  name: string;
  path: string;
  kind: "package" | "rust" | "dotnet";
  technologies: string[];
  capabilities: Partial<Record<Capability, string[]>>;
};
export type Inspection = {
  root: string;
  technologies: string[];
  components: Component[];
};
export type Envelope<T extends object> = {
  schemaVersion: 1;
  operation: string;
  status: Status;
  durationMs: number;
  data: T;
  diagnostics: Diagnostic[];
};

type PackageManifest = {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export function envelope<T extends object>(
  operation: string,
  started: number,
  status: Status,
  data: T,
  diagnostics: Diagnostic[] = [],
): Envelope<T> {
  return {
    schemaVersion: 1,
    operation,
    status,
    durationMs: Date.now() - started,
    data,
    diagnostics,
  };
}

export function inspectRepository(input = process.cwd()): Inspection {
  const root = repositoryRoot(resolve(input));
  const files = walkFiles(root);
  const components: Component[] = [];

  for (const manifestPath of files.filter(
    (path) => basename(path) === "package.json",
  )) {
    const manifest = readJson<PackageManifest>(manifestPath);
    if (!manifest) continue;
    const componentRoot = dirname(manifestPath);
    components.push({
      name: manifest.name || pathName(componentRoot),
      path: relativePosix(root, componentRoot),
      kind: "package",
      technologies: packageTechnologies(manifest, componentRoot),
      capabilities: packageCapabilities(manifest, componentRoot, root),
    });
  }

  for (const manifestPath of files.filter(
    (path) => basename(path) === "Cargo.toml",
  )) {
    const componentRoot = dirname(manifestPath);
    const contents = readFileSync(manifestPath, "utf8");
    const name =
      /^name\s*=\s*["']([^"']+)["']/m.exec(contents)?.[1] ||
      pathName(componentRoot) + "-rust";
    components.push({
      name,
      path: relativePosix(root, componentRoot),
      kind: "rust",
      technologies: ["rust"],
      capabilities: {
        "format:check": ["cargo", "fmt", "--all", "--", "--check"],
        lint: [
          "cargo",
          "clippy",
          "--all-targets",
          "--",
          "-D",
          "warnings",
        ],
        typecheck: ["cargo", "check", "--all-targets"],
        build: ["cargo", "build", "--all-targets"],
        test: ["cargo", "test"],
      },
    });
  }

  for (const projectPath of files.filter((path) =>
    path.endsWith(".csproj"),
  )) {
    const componentRoot = dirname(projectPath);
    const project = basename(projectPath);
    components.push({
      name: project.slice(0, -7),
      path: relativePosix(root, componentRoot),
      kind: "dotnet",
      technologies: ["dotnet"],
      capabilities: {
        "format:check": [
          "dotnet",
          "format",
          project,
          "--verify-no-changes",
        ],
        build: ["dotnet", "build", project],
        typecheck: ["dotnet", "build", project],
        test: ["dotnet", "test", project],
      },
    });
  }

  components.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name),
  );
  disambiguateNames(components);
  return {
    root,
    technologies: [
      ...new Set(
        components.flatMap((component) => component.technologies),
      ),
    ].sort(),
    components,
  };
}

function packageTechnologies(
  manifest: PackageManifest,
  root: string,
): string[] {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  const technologies = new Set<string>(["javascript"]);
  if (
    dependencies.typescript ||
    existsSync(join(root, "tsconfig.json"))
  ) {
    technologies.add("typescript");
  }
  if (dependencies.react || dependencies["react-dom"]) {
    technologies.add("react");
  }
  if (dependencies.vite) technologies.add("vite");
  return [...technologies].sort();
}

function packageCapabilities(
  manifest: PackageManifest,
  root: string,
  repository: string,
): Partial<Record<Capability, string[]>> {
  const scripts = manifest.scripts || {};
  const command = packageCommand(manifest, root, repository);
  const capabilities: Partial<Record<Capability, string[]>> = {};
  const declared: Array<[Capability, string]> = [
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["build", "build"],
    ["test", "test"],
    ["test:unit", "test:unit"],
    ["test:integration", "test:integration"],
    ["test:e2e", "test:e2e"],
    ["gate:final", "check"],
  ];
  for (const [capability, script] of declared) {
    if (scripts[script]) capabilities[capability] = command(script);
  }
  if (scripts["format:check"]) {
    capabilities["format:check"] = command("format:check");
  } else if (
    scripts.format &&
    /(^|\s)--check(?:\s|$)/.test(scripts.format)
  ) {
    capabilities["format:check"] = command("format");
  }
  return capabilities;
}

function packageCommand(
  manifest: PackageManifest,
  root: string,
  repository: string,
): (script: string) => string[] {
  const declared = manifest.packageManager?.split("@")[0];
  const manager =
    declared ||
    (existsSync(join(root, "bun.lock")) ||
    existsSync(join(repository, "bun.lock"))
      ? "bun"
      : existsSync(join(root, "pnpm-lock.yaml")) ||
          existsSync(join(repository, "pnpm-lock.yaml"))
        ? "pnpm"
        : existsSync(join(root, "yarn.lock")) ||
            existsSync(join(repository, "yarn.lock"))
          ? "yarn"
          : "npm");
  return (script) =>
    manager === "yarn" ? [manager, script] : [manager, "run", script];
}

function disambiguateNames(components: Component[]): void {
  const counts = new Map<string, number>();
  for (const component of components) {
    counts.set(component.name, (counts.get(component.name) || 0) + 1);
  }
  for (const component of components) {
    if ((counts.get(component.name) || 0) > 1) {
      component.name = component.name + ":" + component.kind;
    }
  }
}

export function runCheck(
  inspection: Inspection,
  capability: string,
  selectedComponent?: string,
): Envelope<{ capability: string; results: object[] }> {
  const started = Date.now();
  if (!capabilityOrder.includes(capability as Capability)) {
    return envelope(
      "check",
      started,
      "unavailable",
      { capability, results: [] },
      [
        {
          code: "unknown-capability",
          message: "Unknown capability: " + capability,
        },
      ],
    );
  }
  const components = selectedComponent
    ? inspection.components.filter(
        (component) => component.name === selectedComponent,
      )
    : inspection.components;
  if (selectedComponent && components.length === 0) {
    return envelope(
      "check",
      started,
      "unavailable",
      { capability, results: [] },
      [
        {
          code: "unknown-component",
          message: "Unknown component: " + selectedComponent,
        },
      ],
    );
  }
  const runnable = components.filter(
    (component) => component.capabilities[capability as Capability],
  );
  if (runnable.length === 0) {
    return envelope(
      "check",
      started,
      "unavailable",
      { capability, results: [] },
      [
        {
          code: "capability-unavailable",
          message:
            "Capability " +
            capability +
            " is not declared for the selected scope.",
        },
      ],
    );
  }

  const results: object[] = [];
  let status: Status = "passed";
  const diagnostics: Diagnostic[] = [];
  for (const component of runnable) {
    const command =
      component.capabilities[capability as Capability]!;
    const commandStarted = Date.now();
    if (!commandAvailable(command[0])) {
      status = "error";
      diagnostics.push({
        code: "runtime-unavailable",
        message: "Required runtime is unavailable: " + command[0],
        path: component.path,
      });
      results.push({
        component: component.name,
        path: component.path,
        command,
        status: "error",
        exitCode: 127,
        durationMs: Date.now() - commandStarted,
        stdout: "",
        stderr: "",
      });
      continue;
    }

    const result = runCommand(
      command[0],
      command.slice(1),
      join(
        inspection.root,
        component.path === "." ? "" : component.path,
      ),
    );
    const resultStatus = result.error
      ? "error"
      : result.status === 0
        ? "passed"
        : "failed";
    if (resultStatus === "error") status = "error";
    else if (resultStatus === "failed" && status === "passed") {
      status = "failed";
    }
    results.push({
      component: component.name,
      path: component.path,
      command,
      status: resultStatus,
      exitCode: result.status,
      durationMs: Date.now() - commandStarted,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return envelope(
    "check",
    started,
    status,
    { capability, results },
    diagnostics,
  );
}

export function affected(
  inspection: Inspection,
  options: { base?: string; changeManifest?: string },
): Envelope<{
  base: string | null;
  changeManifest: string | null;
  changedFiles: string[];
  affectedComponents: string[];
  recommendedCapabilities: Capability[];
}> {
  const started = Date.now();
  try {
    const changedFiles = options.changeManifest
      ? manifestFiles(inspection.root, options.changeManifest)
      : gitChangedFiles(inspection.root, options.base || "HEAD");
    const affectedComponents = inspection.components
      .filter((component) =>
        changedFiles.some(
          (file) =>
            component.path === "." ||
            file === component.path ||
            file.startsWith(component.path + "/"),
        ),
      )
      .map((component) => component.name);
    const available = new Set(
      inspection.components
        .filter((component) =>
          affectedComponents.includes(component.name),
        )
        .flatMap(
          (component) =>
            Object.keys(component.capabilities) as Capability[],
        ),
    );
    const recommended = (
      [
        "format:check",
        "lint",
        "typecheck",
        "test:unit",
        "test",
      ] as Capability[]
    ).filter((capability) => available.has(capability));
    return envelope("affected", started, "passed", {
      base: options.changeManifest
        ? null
        : options.base || "HEAD",
      changeManifest: options.changeManifest || null,
      changedFiles,
      affectedComponents,
      recommendedCapabilities: recommended,
    });
  } catch (error) {
    return envelope(
      "affected",
      started,
      "error",
      {
        base: options.base || null,
        changeManifest: options.changeManifest || null,
        changedFiles: [],
        affectedComponents: [],
        recommendedCapabilities: [],
      },
      [
        {
          code: "affected-failed",
          message:
            error instanceof Error ? error.message : String(error),
        },
      ],
    );
  }
}

function manifestFiles(root: string, manifestPath: string): string[] {
  const path = resolve(manifestPath);
  const value = JSON.parse(readFileSync(path, "utf8")) as
    | string[]
    | { files?: string[]; changedFiles?: string[] };
  const files = Array.isArray(value)
    ? value
    : value.files || value.changedFiles;
  if (
    !files ||
    !files.every((file) => typeof file === "string")
  ) {
    throw new Error(
      "Change manifest must be an array of paths or an object with a files array.",
    );
  }
  return [
    ...new Set(
      files.map((file) => normalizeChangedPath(root, file)),
    ),
  ].sort();
}

function normalizeChangedPath(root: string, file: string): string {
  const absolute = isAbsolute(file)
    ? resolve(file)
    : resolve(root, file);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(".." + sep)) {
    throw new Error(
      "Change manifest path is outside the repository: " + file,
    );
  }
  return rel.split(sep).join("/");
}

function gitChangedFiles(root: string, base: string): string[] {
  const diff = runCommand(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=ACMRTUXB",
      base,
      "--",
    ],
    root,
  );
  if (diff.status !== 0) {
    throw new Error(
      diff.stderr.trim() || "git diff failed for base " + base,
    );
  }
  const untracked = runCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    root,
  );
  if (untracked.status !== 0) {
    throw new Error(
      untracked.stderr.trim() || "git ls-files failed",
    );
  }
  return [
    ...new Set(
      (diff.stdout + "\n" + untracked.stdout)
        .split(/\r?\n/)
        .map((file) => file.trim())
        .filter(Boolean),
    ),
  ].sort();
}

export function doctor(
  inspection: Inspection,
): Envelope<{ checks: object[] }> {
  const started = Date.now();
  const checks: Array<{
    name: string;
    status: "passed" | "failed";
    message: string;
  }> = [];
  checks.push({
    name: "repository",
    status:
      existsSync(inspection.root) &&
      statSync(inspection.root).isDirectory()
        ? "passed"
        : "failed",
    message: "repository root: " + inspection.root,
  });
  const gitAvailable = commandAvailable("git");
  checks.push({
    name: "git",
    status: gitAvailable ? "passed" : "failed",
    message: gitAvailable
      ? "git is available"
      : "git is unavailable",
  });
  const runtimes = [
    ...new Set(
      inspection.components.flatMap((component) =>
        Object.values(component.capabilities).map(
          (command) => command![0],
        ),
      ),
    ),
  ].sort();
  for (const runtime of runtimes) {
    const available = commandAvailable(runtime);
    checks.push({
      name: runtime,
      status: available ? "passed" : "failed",
      message: available
        ? runtime + " is available"
        : runtime + " is unavailable",
    });
  }
  return envelope(
    "doctor",
    started,
    checks.every((check) => check.status === "passed")
      ? "passed"
      : "failed",
    { checks },
  );
}

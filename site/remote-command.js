import { loadSnapshot } from "./github-analysis.js";
import { analyzeSnapshot, parseRepositoryReference } from "./preflight.js";

const capabilities = [
  "format:check",
  "lint",
  "typecheck",
  "build",
  "test",
  "test:unit",
  "test:integration",
  "test:e2e",
  "test:e2e:smoke",
  "test:accessibility",
  "test:visual",
  "package:check",
  "dependencies:audit",
  "benchmark",
  "benchmark:smoke",
  "profile:runtime",
  "profile:hotspots",
  "profile:memory",
  "storybook:check",
  "web:audit",
  "template:smoke",
];

const defaultTiers = {
  fast: ["format:check", "lint", "typecheck", "test:unit", "build"],
  integration: ["test:integration"],
  e2e: ["test:e2e"],
  full: ["format:check", "lint", "typecheck", "test:unit", "test:integration", "test:e2e", "build"],
};

const supportedCommands = new Set([
  "inspect",
  "findings",
  "bootstrap plan",
  "plan",
  "repository metadata",
]);

export async function remoteCommand(value, argv, options = {}) {
  const started = Date.now();
  const reference = typeof value === "string" ? parseRepositoryReference(value) : value;
  if (!reference?.owner || !reference?.name)
    return timed(
      envelope("remote-command", "error", { requestedArgv: inputArgv(argv) }, [
        {
          code: "invalid-repository",
          message: "Enter owner/repository or a github.com repository URL.",
        },
      ]),
      started,
    );

  let args;
  try {
    args = normalizeArgv(argv);
  } catch (error) {
    return timed(
      envelope("remote-command", "error", { repository: `${reference.owner}/${reference.name}` }, [
        { code: "invalid-argv", message: error instanceof Error ? error.message : String(error) },
      ]),
      started,
    );
  }

  const request = commandRequest(args);
  if (!supportedCommands.has(request.key))
    return timed(unavailableEnvelope(reference, args, request.key), started);

  try {
    const snapshot = await loadSnapshot(reference, options);
    return timed(remoteCommandFromSnapshot(snapshot, args, options.now ?? new Date()), started);
  } catch (error) {
    return timed(
      envelope(
        request.operation,
        "error",
        {
          repository: `${reference.owner}/${reference.name}`,
          requestedArgv: args,
        },
        [
          {
            code: "remote-command-failed",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      ),
      started,
    );
  }
}

export function remoteCommandFromSnapshot(snapshot, argv, now = new Date()) {
  let args;
  try {
    args = normalizeArgv(argv);
  } catch (error) {
    return envelope("remote-command", "error", {}, [
      { code: "invalid-argv", message: error instanceof Error ? error.message : String(error) },
    ]);
  }

  const request = commandRequest(args);
  if (!supportedCommands.has(request.key))
    return unavailableEnvelope(
      { owner: snapshot.repository.owner, name: snapshot.repository.name },
      args,
      request.key,
    );

  const analysis = analyzeSnapshot(snapshot, now);
  const incompleteDiagnostic =
    analysis.summary.status === "incomplete"
      ? [
          {
            code: "remote-source-incomplete",
            message:
              "GitHub did not provide a complete repository snapshot; treat this result as incomplete.",
          },
        ]
      : [];

  try {
    if (request.key === "inspect") {
      assertOnlyJson(args.slice(1));
      const components = analysis.components.map(componentView);
      return envelope(
        "inspect",
        components.length > 0 ? "passed" : "unavailable",
        {
          root: remoteRoot(snapshot),
          technologies: analysis.technologies,
          components,
          source: analysis.source,
          remoteScope: "structural",
        },
        incompleteDiagnostic,
      );
    }

    if (request.key === "findings") {
      assertOnlyJson(args.slice(1));
      const counts = countFindings(analysis.findings);
      return envelope(
        "findings",
        counts.high > 0 ? "failed" : "passed",
        {
          root: remoteRoot(snapshot),
          state: "remote-structural",
          includeSuppressed: false,
          counts,
          findings: analysis.findings,
          source: analysis.source,
          remoteScope: "structural",
        },
        incompleteDiagnostic,
      );
    }

    if (request.key === "bootstrap plan") {
      assertOnlyJson(args.slice(2));
      return envelope(
        "bootstrap",
        "passed",
        {
          root: remoteRoot(snapshot),
          action: "plan",
          remoteScope: "structural",
          actions: analysis.findings.map((finding) => ({
            id: finding.id,
            severity: finding.severity,
            title: finding.title,
            recommendation: finding.recommendation,
            ...(finding.command ? { command: finding.command } : {}),
          })),
          source: analysis.source,
        },
        incompleteDiagnostic,
      );
    }

    if (request.key === "repository metadata") {
      assertOnlyJson(args.slice(2));
      return envelope(
        "repository-metadata",
        "passed",
        {
          root: remoteRoot(snapshot),
          repository: snapshot.repository,
          technologies: analysis.technologies,
          components: analysis.components.map(componentView),
          source: analysis.source,
          remoteScope: "github-default-branch",
        },
        incompleteDiagnostic,
      );
    }

    return remotePlan(snapshot, analysis, args);
  } catch (error) {
    return envelope(
      request.operation,
      "error",
      {
        root: remoteRoot(snapshot),
        requestedArgv: args,
      },
      [
        {
          code: "invalid-remote-command",
          message: error instanceof Error ? error.message : String(error),
        },
        ...incompleteDiagnostic,
      ],
    );
  }
}

function remotePlan(snapshot, analysis, args) {
  const options = parsePlanOptions(args.slice(1));
  const config = readToolingConfig(snapshot);
  const selected = config.tiers?.[options.tier] ?? defaultTiers[options.tier];
  if (!selected) throw new Error(`Unknown tier: ${options.tier}`);
  validateCapabilities(selected);
  validateCapabilities(config.requiredCapabilities ?? []);
  validateCapabilities(config.optionalCapabilities ?? []);

  const components = analysis.components
    .map((component) => applyCapabilityCommands(componentView(component), config))
    .filter(
      (component) =>
        !options.component ||
        component.name === options.component ||
        component.path === options.component,
    );
  if (options.component && components.length === 0)
    throw new Error(`Unknown component: ${options.component}`);

  const checks = [];
  for (const component of components) {
    for (const capability of new Set(selected)) {
      const command = component.capabilities[capability];
      if (command)
        checks.push({ capability, component: component.name, path: component.path, command });
    }
  }

  const available = new Set(checks.map((check) => check.capability));
  const required = new Set(config.requiredCapabilities ?? []);
  const optional = new Set(config.optionalCapabilities ?? []);
  const scope = components.length === 1 ? components[0].name : "selected components";
  const missing = [];
  for (const capability of new Set(selected)) {
    if (available.has(capability)) continue;
    if (required.has(capability)) missing.push({ capability, component: scope, optional: false });
    else if (optional.has(capability))
      missing.push({ capability, component: scope, optional: true });
  }

  const diagnostics = missing.map((item) => ({
    code: item.optional ? "optional-capability-unavailable" : "capability-unavailable",
    message: `${item.capability} is unavailable for ${item.component}`,
  }));
  if (analysis.summary.status === "incomplete")
    diagnostics.push({
      code: "remote-source-incomplete",
      message:
        "GitHub did not provide a complete repository snapshot; treat this plan as incomplete.",
    });
  if ((config.conventionRefs ?? []).length > 0)
    diagnostics.push({
      code: "remote-convention-execution-not-evaluated",
      message:
        "Installed convention execution is local-only; this Pages plan includes repository-declared capabilities but does not project executable convention configuration.",
    });

  return envelope(
    "plan",
    checks.length > 0 ? "passed" : "unavailable",
    {
      root: remoteRoot(snapshot),
      profile: config.profile,
      tier: options.tier,
      dependencyResolution: "distribution",
      checks,
      missing,
      conventionRequiredCapabilities: [],
      conventionRefs: config.conventionRefs ?? [],
      source: analysis.source,
      remoteScope: "structural-plan-only",
    },
    diagnostics,
  );
}

function readToolingConfig(snapshot) {
  const raw = snapshot.files[".coding-tooling.json"];
  if (!raw) return { schemaVersion: 1 };
  const config = JSON.parse(raw);
  if (config?.schemaVersion !== 1) throw new Error(".coding-tooling.json must use schemaVersion 1");
  if (config.tiers) for (const values of Object.values(config.tiers)) validateCapabilities(values);
  return config;
}

function applyCapabilityCommands(component, config) {
  return {
    ...component,
    capabilities: {
      ...component.capabilities,
      ...config.capabilityCommands?.[component.name],
      ...config.capabilityCommands?.[component.path],
    },
  };
}

function validateCapabilities(values) {
  if (!Array.isArray(values)) throw new Error("Capability lists must be arrays.");
  for (const value of values) {
    if (!capabilities.includes(value)) throw new Error(`Unknown capability: ${value}`);
  }
}

function parsePlanOptions(args) {
  let tier;
  let component;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--json") continue;
    if (value === "--tier" || value === "--component") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
      if (value === "--tier") tier = next;
      else component = next;
      index += 1;
      continue;
    }
    if (value === "--config")
      throw new Error(
        "Pages supports the default .coding-tooling.json only; custom --config paths require the local CLI.",
      );
    throw new Error(`Unsupported Pages plan argument: ${value}`);
  }
  if (!tier) throw new Error("plan requires --tier <name>.");
  return { tier, component };
}

function componentView(component) {
  return {
    name: component.name,
    path: component.path,
    kind: component.kind,
    technologies: component.technologies,
    capabilities: component.capabilities,
  };
}

function countFindings(findings) {
  const counts = { total: findings.length, high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    if (finding.severity in counts) counts[finding.severity] += 1;
  }
  return counts;
}

function assertOnlyJson(args) {
  const unknown = args.filter((value) => value !== "--json");
  if (unknown.length > 0) throw new Error(`Unsupported Pages argument: ${unknown[0]}`);
}

function commandRequest(args) {
  const clean = args.filter((value) => value !== "--json");
  const command = clean[0] ?? "";
  const action = clean[1] ?? "";
  if (command === "bootstrap")
    return { key: `${command} ${action}`.trim(), operation: "bootstrap" };
  if (command === "repository")
    return { key: `${command} ${action}`.trim(), operation: "repository-metadata" };
  return { key: command, operation: command || "remote-command" };
}

function unavailableEnvelope(reference, args, key) {
  const localCommand = [
    "coding-tooling",
    ...args.filter((value) => value !== "--json"),
    "--json",
  ].join(" ");
  return envelope(
    key || "remote-command",
    "unavailable",
    {
      repository: `${reference.owner}/${reference.name}`,
      requestedArgv: args,
      localCommand,
      remoteAlternatives: [
        "inspect --json",
        "findings --json",
        "bootstrap plan --json",
        "plan --tier fast --json",
        "repository metadata --json",
      ],
    },
    [
      {
        code: "remote-command-unavailable",
        message:
          "This command needs repository execution, mutation, local Git history, local environment state, or analysis that the static Pages boundary cannot reproduce safely.",
      },
    ],
  );
}

function remoteRoot(snapshot) {
  return `github:${snapshot.repository.fullName}@${snapshot.repository.defaultBranch}`;
}

function envelope(operation, status, data, diagnostics = []) {
  return { schemaVersion: 1, operation, status, durationMs: 0, data, diagnostics };
}

function timed(result, started) {
  return { ...result, durationMs: Date.now() - started };
}

function inputArgv(value) {
  return Array.isArray(value) ? value : typeof value === "string" ? value : [];
}

export function normalizeArgv(value) {
  const args = Array.isArray(value) ? [...value] : tokenize(value ?? "");
  if (args[0] === "coding-tooling") args.shift();
  return args;
}

function tokenize(input) {
  if (typeof input !== "string") throw new Error("argv must be a string or an array of arguments.");
  const args = [];
  let token = "";
  let quote = null;
  let escaped = false;
  let active = false;
  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
      active = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      active = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      active = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (active) {
        args.push(token);
        token = "";
        active = false;
      }
      continue;
    }
    token += character;
    active = true;
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("Unterminated quote in argv.");
  if (active) args.push(token);
  return args;
}

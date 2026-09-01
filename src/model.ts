export const capabilities = [
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
  "storybook:check",
  "web:audit",
  "template:smoke",
] as const;

export type Capability = (typeof capabilities)[number];
export type ResultStatus = "passed" | "failed" | "unavailable" | "error";
export type ResultOperation =
  | "inspect"
  | "check"
  | "affected"
  | "doctor"
  | "conformance"
  | "environment"
  | "plan"
  | "run"
  | "source-deps"
  | "dependencies"
  | "agent-capabilities"
  | "conventions"
  | "conventions-init"
  | "conventions-add"
  | "conventions-check"
  | "conventions-diff"
  | "conventions-update"
  | "generate"
  | "pr";

export type Diagnostic = {
  code?: string;
  message: string;
  path?: string;
};

export type ResultEnvelope<T extends Record<string, unknown>> = {
  schemaVersion: 1;
  operation: ResultOperation;
  status: ResultStatus;
  durationMs: number;
  data: T;
  diagnostics: Diagnostic[];
};

export type Component = {
  name: string;
  path: string;
  kind: "package" | "rust" | "dotnet";
  technologies: string[];
  capabilities: Partial<Record<Capability, string[]>>;
};

export type ToolingConfig = {
  schemaVersion: 1;
  profile?: string;
  tiers?: Record<string, Capability[]>;
  requiredCapabilities?: Capability[];
  optionalCapabilities?: Capability[];
  capabilityCommands?: Record<string, Partial<Record<Capability, string[]>>>;
  conventionRefs?: string[];
};

export type PlannedCheck = {
  capability: Capability;
  component: string;
  path: string;
  command: string[];
};

export const defaultTiers: Record<string, Capability[]> = {
  fast: ["format:check", "lint", "typecheck", "test:unit", "build"],
  integration: ["test:integration"],
  e2e: ["test:e2e"],
  full: ["format:check", "lint", "typecheck", "test:unit", "test:integration", "test:e2e", "build"],
};

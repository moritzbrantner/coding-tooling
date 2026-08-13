export type Capability =
  | "format"
  | "lint"
  | "typecheck"
  | "build"
  | "test:unit"
  | "test:integration"
  | "test:e2e";

export const capabilityOrder: Capability[] = [
  "format",
  "lint",
  "typecheck",
  "build",
  "test:unit",
  "test:integration",
  "test:e2e",
];

export type CheckStatus = "passed" | "failed" | "unavailable";
export type DoctorStatus = "passed" | "warning" | "failed";

export interface ProfileCapability {
  command: string[];
  requires_script?: string;
}

export interface Profile {
  id: string;
  language: string;
  runtime: string;
  capabilities: Partial<Record<Capability, ProfileCapability>>;
}

export interface Component {
  name: string;
  path: string;
  profile: string;
  language: string;
  runtime: string;
  capabilities: Capability[];
}

export interface Inspection {
  schemaVersion: 1;
  root: string;
  languages: string[];
  runtimes: string[];
  profiles: string[];
  capabilities: Record<Capability, boolean>;
  components: Component[];
}

export interface CheckResult {
  schemaVersion: 1;
  capability: Capability;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  component: string;
  componentPath: string;
  command: string[];
  stdout: string;
  stderr: string;
}

export interface AffectedResult {
  schemaVersion: 1;
  root: string;
  base: string | null;
  changedFiles: string[];
  affectedComponents: string[];
  recommendedCapabilities: Capability[];
}

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorResult {
  schemaVersion: 1;
  root: string | null;
  status: "passed" | "failed";
  checks: DoctorCheck[];
}

import { readFileSync, writeFileSync } from "node:fs";

export function buildPublicContractSnapshot({ input, repository, revision, generatedAt }) {
  if (!repository || !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repository))
    throw new Error("--repository must be owner/repository");
  if (!/^[0-9a-f]{40}$/i.test(revision ?? ""))
    throw new Error("--revision must be an exact 40-character Git commit SHA");
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt)))
    throw new Error("--generated-at must be an ISO timestamp");

  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  const report = publicContractReport(parsed);
  if (!report) throw new Error("Input is not a schemaVersion 1 public-contract report");
  if (report.revision && report.revision !== revision)
    throw new Error("Public-contract report revision does not match --revision");

  return {
    schemaVersion: 1,
    kind: "coding-tooling-public-contract-snapshot",
    repository: {
      fullName: repository,
      revision,
    },
    generatedAt: new Date(generatedAt).toISOString(),
    producer: {
      id: "coding-tooling",
      protocolVersion: 1,
    },
    report: {
      ...report,
      revision,
    },
  };
}

function publicContractReport(value) {
  if (value?.schemaVersion === 1 && value?.summary && Array.isArray(value?.surfaces)) return value;
  if (
    value?.schemaVersion === 1 &&
    value?.operation === "contract" &&
    value?.data?.schemaVersion === 1 &&
    value?.data?.summary &&
    Array.isArray(value?.data?.surfaces)
  )
    return value.data;
  return null;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

function main() {
  const inputPath = argument("--input");
  const outputPath = argument("--output");
  const snapshot = buildPublicContractSnapshot({
    input: readFileSync(inputPath, "utf8"),
    repository: argument("--repository"),
    revision: argument("--revision"),
    generatedAt: argument("--generated-at"),
  });
  writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

if (import.meta.main) main();

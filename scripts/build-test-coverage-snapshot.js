import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseCoverage } from "../site/test-coverage.js";

export function buildTestCoverageSnapshot({
  coverage,
  repository,
  revision,
  generatedAt,
  sourcePath,
  sourceFormat,
}) {
  if (!repository || !repository.includes("/")) throw new Error("--repository must be owner/repository");
  if (!/^[0-9a-f]{40}$/i.test(revision ?? "")) throw new Error("--revision must be an exact Git commit SHA");
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt)))
    throw new Error("--generated-at must be an ISO-8601 timestamp");

  return {
    schemaVersion: 1,
    kind: "coding-tooling-test-coverage-snapshot",
    repository: {
      fullName: repository,
      revision,
    },
    generatedAt: new Date(generatedAt).toISOString(),
    producer: {
      id: "coding-tooling",
      protocolVersion: 1,
    },
    source: {
      path: sourcePath,
      format: sourceFormat,
    },
    coverage,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const known = new Set([
    "--input",
    "--format",
    "--repository",
    "--revision",
    "--generated-at",
    "--output",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!known.has(flag) || !argv[index + 1]) usage();
    index += 1;
  }

  const input = option(argv, "input");
  const format = option(argv, "format");
  const repository = option(argv, "repository");
  const revision = option(argv, "revision");
  const generatedAt = option(argv, "generated-at");
  const output = option(argv, "output");
  if (!input || !format || !repository || !revision || !generatedAt || !output) usage();

  const coverage = parseCoverage(await readFile(input, "utf8"), format);
  const snapshot = buildTestCoverageSnapshot({
    coverage,
    repository,
    revision,
    generatedAt,
    sourcePath: input,
    sourceFormat: format,
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(snapshot));
}

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function usage() {
  throw new Error(
    "Usage: bun scripts/build-test-coverage-snapshot.js --input <path> --format <lcov|istanbul-summary> --repository <owner/repository> --revision <sha> --generated-at <iso> --output <path>",
  );
}

if (import.meta.main) await main();

export function parseCoverageDetail(content, format) {
  if (format !== "lcov")
    throw new Error(`Unsupported detailed coverage format: ${format}`);
  return parseLcovDetail(content);
}

function parseLcovDetail(content) {
  const files = [];
  let record = null;

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      if (record) files.push(finishRecord(record));
      record = createRecord(line.slice(3));
      continue;
    }
    if (!record) continue;

    if (line === "end_of_record") {
      files.push(finishRecord(record));
      record = null;
      continue;
    }
    if (line.startsWith("FN:")) {
      const [lineNumber, name] = splitFirst(line.slice(3));
      const parsedLine = nonNegativeInteger(lineNumber, "FN line");
      if (!name) throw new Error("Invalid LCOV FN name");
      if (!record.functionLines.has(name)) record.functionLines.set(name, parsedLine);
      continue;
    }
    if (line.startsWith("FNDA:")) {
      const [hits, name] = splitFirst(line.slice(5));
      if (!name) throw new Error("Invalid LCOV FNDA name");
      record.functionHits.set(
        name,
        (record.functionHits.get(name) ?? 0) + nonNegativeInteger(hits, "FNDA hits"),
      );
      continue;
    }
    if (line.startsWith("DA:")) {
      const fields = line.slice(3).split(",");
      const lineNumber = nonNegativeInteger(fields[0], "DA line");
      const hits = nonNegativeInteger(fields[1], "DA hits");
      record.lineHits.set(lineNumber, (record.lineHits.get(lineNumber) ?? 0) + hits);
      continue;
    }
    if (line.startsWith("BRDA:")) {
      const fields = line.slice(5).split(",");
      if (fields.length < 4) throw new Error("Invalid LCOV BRDA entry");
      const taken = fields[3] === "-" ? null : nonNegativeInteger(fields[3], "BRDA hits");
      record.branches.push({
        line: nonNegativeInteger(fields[0], "BRDA line"),
        block: fields[1],
        branch: fields[2],
        hits: taken,
        covered: taken !== null && taken > 0,
      });
    }
  }

  if (record) files.push(finishRecord(record));
  if (files.length === 0) throw new Error("No LCOV source records found");

  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function createRecord(path) {
  if (!path) throw new Error("Invalid LCOV source path");
  return {
    path,
    functionLines: new Map(),
    functionHits: new Map(),
    lineHits: new Map(),
    branches: [],
  };
}

function finishRecord(record) {
  const functionNames = new Set([...record.functionLines.keys(), ...record.functionHits.keys()]);
  const functions = [...functionNames]
    .map((name) => ({
      name,
      line: record.functionLines.get(name) ?? null,
      hits: record.functionHits.get(name) ?? 0,
      covered: (record.functionHits.get(name) ?? 0) > 0,
    }))
    .sort(compareFunction);

  const lines = [...record.lineHits.entries()]
    .map(([line, hits]) => ({ line, hits, covered: hits > 0 }))
    .sort((left, right) => left.line - right.line);

  const branches = [...record.branches].sort(compareBranch);

  return {
    path: record.path,
    lines,
    functions,
    branches,
  };
}

function compareFunction(left, right) {
  const leftLine = left.line ?? Number.MAX_SAFE_INTEGER;
  const rightLine = right.line ?? Number.MAX_SAFE_INTEGER;
  return leftLine - rightLine || left.name.localeCompare(right.name);
}

function compareBranch(left, right) {
  return (
    left.line - right.line ||
    String(left.block).localeCompare(String(right.block)) ||
    String(left.branch).localeCompare(String(right.branch))
  );
}

function splitFirst(value) {
  const index = value.indexOf(",");
  if (index < 0) return [value, ""];
  return [value.slice(0, index), value.slice(index + 1)];
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid LCOV ${label}`);
  return parsed;
}

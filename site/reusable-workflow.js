const EXACT_GIT_SHA = /^[0-9a-f]{40}$/i;
const EXTERNAL_REUSABLE_WORKFLOW =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(\.github\/workflows\/.+\.ya?ml)@([^\s#]+)$/i;
const LOCAL_REUSABLE_WORKFLOW = /^(\.\/\.github\/workflows\/.+\.ya?ml)$/i;

export function discoverReusableWorkflowCalls(workflows) {
  return (workflows ?? [])
    .flatMap((workflow) => workflowCalls(workflow.path, workflow.content))
    .toSorted(
      (left, right) =>
        left.callerPath.localeCompare(right.callerPath) || left.job.localeCompare(right.job),
    );
}

export function materializeReusableWorkflow(content, callerInputs) {
  const defaults = workflowCallInputDefaults(content);
  const inputs = { ...defaults, ...literalInputs(callerInputs) };
  const unresolved = new Set();
  const materialized = String(content).replace(
    /\$\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g,
    (expression, name) => {
      if (!(name in inputs)) {
        unresolved.add(name);
        return expression;
      }
      return inputs[name];
    },
  );
  return {
    content: materialized,
    inputs,
    unresolvedInputs: [...unresolved].toSorted(),
    workflowCall: hasWorkflowCallTrigger(content),
  };
}

export function parseReusableWorkflowReference(value) {
  const reference = String(value ?? "").trim();
  const local = reference.match(LOCAL_REUSABLE_WORKFLOW);
  if (local) {
    return {
      status: "local",
      reference,
      path: local[1].slice(2),
      ref: null,
      repository: null,
    };
  }

  const external = reference.match(EXTERNAL_REUSABLE_WORKFLOW);
  if (!external) return null;
  const ref = external[4];
  return {
    status: EXACT_GIT_SHA.test(ref) ? "pinned" : "unsupported",
    reference,
    repository: `${external[1]}/${external[2]}`,
    path: external[3],
    ref,
    ...(EXACT_GIT_SHA.test(ref) ? {} : { reason: "reusable-workflow-ref-not-immutable" }),
  };
}

function workflowCalls(callerPath, content) {
  const lines = String(content).split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => /^\s*jobs:\s*(?:#.*)?$/.test(line));
  if (jobsIndex < 0) return [];
  const jobsIndent = indentation(lines[jobsIndex]);
  const starts = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = indentation(line);
    if (indent <= jobsIndent) break;
    const match = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (!match) continue;
    if (starts.length === 0 || match[1].length === starts[0].indent) {
      starts.push({ index, indent: match[1].length, job: match[2] });
    }
  }

  return starts.flatMap((start, position) => {
    const end = starts[position + 1]?.index ?? lines.length;
    const propertyIndent = firstChildIndent(lines, start.index + 1, end, start.indent);
    if (propertyIndent === null) return [];
    const usesIndex = findProperty(lines, start.index + 1, end, propertyIndent, "uses");
    if (usesIndex < 0) return [];
    const uses = yamlScalar(lines[usesIndex].replace(/^\s*uses\s*:\s*/, ""));
    const target = parseReusableWorkflowReference(uses);
    if (!target) return [];

    const withIndex = findProperty(lines, start.index + 1, end, propertyIndent, "with");
    const inputs = withIndex < 0 ? {} : childScalars(lines, withIndex + 1, end, propertyIndent);
    return [
      {
        callerPath,
        job: start.job,
        inputs,
        target,
      },
    ];
  });
}

function workflowCallInputDefaults(content) {
  const lines = normalizedLines(content);
  const on = findKey(lines, 0, lines.length, null, "on");
  if (on < 0) return {};
  const workflowCall = findChildKey(lines, on, "workflow_call");
  if (workflowCall < 0) return {};
  const inputs = findChildKey(lines, workflowCall, "inputs");
  if (inputs < 0) return {};

  const result = {};
  const inputEnd = blockEnd(lines, inputs);
  const inputIndent = firstNormalizedChildIndent(lines, inputs, inputEnd);
  if (inputIndent === null) return result;
  for (let index = inputs + 1; index < inputEnd; index += 1) {
    const line = lines[index];
    const name =
      line.indent === inputIndent ? line.text.match(/^([A-Za-z_][A-Za-z0-9_-]*):$/)?.[1] : null;
    if (!name) continue;
    const defaultIndex = findChildKey(lines, index, "default");
    if (defaultIndex < 0) continue;
    const value = yamlScalar(lines[defaultIndex].text.replace(/^default\s*:\s*/, ""));
    if (value !== null && !value.includes("${{")) result[name] = value;
  }
  return result;
}

function hasWorkflowCallTrigger(content) {
  const lines = normalizedLines(content);
  const on = findKey(lines, 0, lines.length, null, "on");
  if (on < 0) return false;
  if (/^on\s*:\s*.*\bworkflow_call\b/.test(lines[on].text)) return true;
  return findChildKey(lines, on, "workflow_call") >= 0;
}

function literalInputs(values) {
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(
      ([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) &&
        typeof value === "string" &&
        !value.includes("${{"),
    ),
  );
}

function childScalars(lines, start, end, parentIndent) {
  const childIndent = firstChildIndent(lines, start, end, parentIndent);
  if (childIndent === null) return {};
  const result = {};
  for (let index = start; index < end; index += 1) {
    if (indentation(lines[index]) !== childIndent) continue;
    const match = lines[index].trim().match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const value = yamlScalar(match[2]);
    if (value !== null && !value.includes("${{")) result[match[1]] = value;
  }
  return result;
}

function findProperty(lines, start, end, indent, key) {
  for (let index = start; index < end; index += 1) {
    if (indentation(lines[index]) !== indent) continue;
    if (new RegExp(`^\\s*${key}\\s*:`).test(lines[index])) return index;
  }
  return -1;
}

function firstChildIndent(lines, start, end, parentIndent) {
  for (let index = start; index < end; index += 1) {
    if (!lines[index].trim()) continue;
    const indent = indentation(lines[index]);
    if (indent > parentIndent) return indent;
  }
  return null;
}

function normalizedLines(content) {
  return String(content)
    .split(/\r?\n/)
    .map((raw) => ({ indent: indentation(raw), text: raw.replace(/\s+#.*$/, "").trim() }))
    .filter((line) => line.text);
}

function findKey(lines, start, end, indent, key) {
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (indent !== null && line.indent !== indent) continue;
    if (new RegExp(`^${key}\\s*:`).test(line.text)) return index;
  }
  return -1;
}

function findChildKey(lines, parentIndex, key) {
  const end = blockEnd(lines, parentIndex);
  const childIndent = firstNormalizedChildIndent(lines, parentIndex, end);
  return childIndent === null ? -1 : findKey(lines, parentIndex + 1, end, childIndent, key);
}

function firstNormalizedChildIndent(lines, parentIndex, end) {
  for (let index = parentIndex + 1; index < end; index += 1) {
    if (lines[index].indent > lines[parentIndex].indent) return lines[index].indent;
  }
  return null;
}

function blockEnd(lines, index) {
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (lines[cursor].indent <= lines[index].indent) return cursor;
  }
  return lines.length;
}

function yamlScalar(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || /^[|>]/.test(trimmed)) return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function indentation(line) {
  return String(line).replace(/\t/g, "  ").match(/^\s*/)?.[0].length ?? 0;
}

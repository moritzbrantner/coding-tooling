const fileInput = document.querySelector("#report-file");
const jsonInput = document.querySelector("#report-json");
const renderButton = document.querySelector("#render-report");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const packagesBody = document.querySelector("#packages");
const findingsSection = document.querySelector("#findings-section");
const findingsRoot = document.querySelector("#findings");

function text(value) {
  return typeof value === "string" ? value : "";
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeDependencyResolutionReport(value) {
  const envelope = record(value);
  const data = record(envelope.data);
  if (envelope.schemaVersion !== 1 || envelope.operation !== "dependencies") {
    throw new Error("Expected a coding-tooling dependencies schema v1 result.");
  }
  const mode = text(data.mode);
  if (mode !== "runtime" && mode !== "static") {
    throw new Error("Dependency report does not declare a recognized evidence mode.");
  }
  return {
    status: text(envelope.status) || "unavailable",
    mode,
    runtimeEvidence: text(data.runtimeEvidence),
    packages: list(data.packages).map(record),
    findings: list(data.findings).map(record),
  };
}

function appendLines(container, lines) {
  for (const line of lines) {
    const item = document.createElement("div");
    item.textContent = line;
    container.append(item);
  }
}

function probeLines(probeValue) {
  const probe = record(probeValue);
  const state = text(probe.status) || "unavailable";
  const lines = [`State: ${state}`];
  const selected = record(probe.selectedVersions);
  const selectedEntries = Object.entries(selected);
  if (selectedEntries.length > 0) {
    lines.push(`Resolved: ${selectedEntries.map(([name, version]) => `${name}@${version}`).join(", ")}`);
  } else {
    const specs = list(probe.specs).filter((value) => typeof value === "string");
    if (specs.length > 0) lines.push(`Requested: ${specs.join(", ")}`);
  }
  if (text(probe.reason)) lines.push(`Reason: ${probe.reason}`);
  for (const detail of list(probe.details).filter((value) => typeof value === "string").slice(0, 4)) {
    lines.push(detail);
  }
  return lines;
}

function repositoryLines(repositoryStateValue) {
  const repositoryState = record(repositoryStateValue);
  const lines = [`State: ${text(repositoryState.status) || "unavailable"}`];
  const lockfiles = list(repositoryState.lockfiles).filter((value) => typeof value === "string");
  if (lockfiles.length > 0) lines.push(`Lockfiles: ${lockfiles.join(", ")}`);
  const declared = Object.entries(record(repositoryState.declaredVersions));
  if (declared.length > 0) {
    lines.push(`Declared locally: ${declared.map(([name, version]) => `${name}@${version}`).join(", ")}`);
  }
  if (text(repositoryState.proves)) lines.push(repositoryState.proves);
  return lines;
}

function cell(lines) {
  const td = document.createElement("td");
  appendLines(td, lines);
  return td;
}

function renderPackages(report) {
  packagesBody.replaceChildren();
  for (const packageReport of report.packages) {
    const row = document.createElement("tr");
    row.append(
      cell([text(packageReport.packageName) || text(packageReport.manifestPath) || "package"]),
      cell(repositoryLines(packageReport.repositoryState)),
      cell(probeLines(packageReport.minimum)),
      cell(probeLines(packageReport.fresh)),
    );
    packagesBody.append(row);
  }
  results.hidden = report.packages.length === 0;
}

function renderFindings(report) {
  findingsRoot.replaceChildren();
  for (const finding of report.findings) {
    const article = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = text(finding.code) || "dependency finding";
    const message = document.createElement("p");
    message.textContent = text(finding.message) || "No message supplied.";
    const metadata = document.createElement("p");
    metadata.className = "muted";
    const pieces = [text(finding.severity), text(finding.packageName), text(finding.mode)].filter(Boolean);
    metadata.textContent = pieces.join(" · ");
    article.append(heading, message, metadata);
    const details = list(finding.details).filter((value) => typeof value === "string");
    if (details.length > 0) {
      const pre = document.createElement("pre");
      pre.textContent = details.join("\n");
      article.append(pre);
    }
    findingsRoot.append(article);
  }
  findingsSection.hidden = report.findings.length === 0;
}

export function reportStatusMessage(report) {
  if (report.mode !== "runtime" || report.runtimeEvidence !== "requested") {
    return "Static evidence loaded. No resolver-backed compatibility result is claimed.";
  }
  if (report.status === "unavailable") {
    return "Runtime resolution is unavailable. This is not a passing compatibility result.";
  }
  if (report.status === "failed") {
    return "Runtime resolution found an acceptance failure. Inspect the dependency findings below.";
  }
  if (report.status === "passed") {
    return "Runtime minimum and fresh-range resolution completed without an active dependency finding.";
  }
  return `Runtime dependency evidence state: ${report.status}.`;
}

function render(value) {
  const report = normalizeDependencyResolutionReport(value);
  renderPackages(report);
  renderFindings(report);
  status.textContent = reportStatusMessage(report);
}

function renderText(value) {
  try {
    render(JSON.parse(value));
  } catch (error) {
    results.hidden = true;
    findingsSection.hidden = true;
    status.textContent = error instanceof Error ? error.message : "Invalid dependency resolution report.";
  }
}

renderButton.addEventListener("click", () => renderText(jsonInput.value));
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const contents = await file.text();
  jsonInput.value = contents;
  renderText(contents);
});

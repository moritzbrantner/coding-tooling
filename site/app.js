import { analysisJson } from "./github-analysis.js";
import { nextWorkJson } from "./next-work.js";
import { DEFAULT_DISCOVERY_OWNER, discoveryJson } from "./repository-discovery.js";

const form = document.querySelector("form");
const input = document.querySelector("#repository");
const status = document.querySelector("#status");
const output = document.querySelector("#output");
const discovery = document.querySelector("#repository-discovery");
const discoveryStatus = document.querySelector("#discovery-status");
const discoveryCandidates = document.querySelector("#repository-candidates");
const nextWork = document.querySelector("#next-work");
const nextWorkStatus = document.querySelector("#next-work-status");
const nextWorkCandidates = document.querySelector("#next-work-candidates");
let controller;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void run(input.value);
});

const searchParams = new URL(location.href).searchParams;
const initial = searchParams.get("repo");
if (initial) {
  input.value = initial;
  void run(initial);
} else {
  discovery.hidden = false;
  void loadDiscovery(searchParams.get("owner") ?? DEFAULT_DISCOVERY_OWNER);
}

async function loadDiscovery(owner) {
  setDiscoveryStatus(`Reading recent public repositories for ${owner}…`);

  try {
    const result = await discoveryJson(owner);
    renderDiscovery(result);
    const qualifier = result.source.truncated ? " within the bounded public API window" : "";
    setDiscoveryStatus(`Ranked public repository candidates for ${result.owner}${qualifier}.`);

    if (result.summary.suggestedRepository) {
      nextWork.hidden = false;
      void loadNextWork(result.summary.suggestedRepository);
    } else {
      nextWork.hidden = true;
    }
  } catch (error) {
    setDiscoveryStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function loadNextWork(repository) {
  setNextWorkStatus(`Reading recent open work for ${repository}…`);

  try {
    const result = await nextWorkJson(repository);
    renderNextWork(result);
    const bounded = result.source.pullsTruncated || result.source.issueWindowTruncated;
    const qualifier = bounded ? " within bounded public API windows" : "";
    setNextWorkStatus(`Ranked concrete open work for ${repository}${qualifier}.`);
  } catch (error) {
    setNextWorkStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function renderDiscovery(result) {
  const machineUrl = new URL("./discovery.json/", location.href);
  machineUrl.searchParams.set("owner", result.owner);
  document.querySelector("#discovery-json-link").href = machineUrl.href;

  if (!result.candidates.length) {
    discoveryCandidates.replaceChildren(
      empty(`No active public repositories found for ${result.owner}.`),
    );
    return;
  }

  discoveryCandidates.replaceChildren(
    ...result.candidates.map((candidate, index) => repositoryCandidate(candidate, index === 0)),
  );
}

function renderNextWork(result) {
  const machineUrl = new URL("./next-work.json/", location.href);
  machineUrl.searchParams.set("repo", result.repository.fullName);
  document.querySelector("#next-work-json-link").href = machineUrl.href;
  document.querySelector("#next-work-repository").textContent = result.repository.fullName;

  if (!result.candidates.length) {
    nextWorkCandidates.replaceChildren(empty("No open pull requests or issues found."));
    return;
  }

  nextWorkCandidates.replaceChildren(
    ...result.candidates.map((candidate, index) => workCandidate(candidate, index === 0)),
  );
}

function repositoryCandidate(candidate, suggested) {
  const article = document.createElement("article");
  article.className = "card";

  const label = document.createElement("div");
  label.className = "finding-label";
  label.textContent = suggested ? "Suggested starting repository" : "Repository candidate";

  const heading = document.createElement("h3");
  heading.textContent = candidate.fullName;

  const description = document.createElement("p");
  description.className = "muted";
  description.textContent = candidate.description ?? "No repository description.";

  const evidence = document.createElement("p");
  evidence.className = "muted";
  evidence.textContent = candidateEvidence(candidate);

  const signals = document.createElement("div");
  signals.className = "chips";
  signals.replaceChildren(...candidate.signals.map((signal) => chip(signal)));

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Analyze repository";
  button.addEventListener("click", () => {
    input.value = candidate.fullName;
    void run(candidate.fullName);
  });

  article.append(label, heading, description, evidence, signals, button);
  return article;
}

function workCandidate(candidate, suggested) {
  const article = document.createElement("article");
  article.className = "card";

  const label = document.createElement("div");
  label.className = "finding-label";
  label.textContent = suggested ? "Suggested next work" : "Open work candidate";

  const heading = document.createElement("h3");
  heading.textContent = `#${candidate.number} ${candidate.title}`;

  const evidence = document.createElement("p");
  evidence.className = "muted";
  evidence.textContent = workEvidence(candidate);

  const signals = document.createElement("div");
  signals.className = "chips";
  const displayedSignals = candidate.ci
    ? [...candidate.signals, `ci-${candidate.ci.status}`]
    : candidate.signals;
  signals.replaceChildren(...displayedSignals.map((signal) => chip(signal)));

  const link = document.createElement("a");
  link.href = candidate.htmlUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Open on GitHub";

  article.append(label, heading, evidence, signals, link);
  return article;
}

function candidateEvidence(candidate) {
  const parts = [];
  if (candidate.language) parts.push(candidate.language);
  if (candidate.lastActivityAt)
    parts.push(
      `last repository activity ${new Date(candidate.lastActivityAt).toLocaleDateString()}`,
    );
  parts.push(
    `${candidate.openItemCount} open GitHub ${candidate.openItemCount === 1 ? "item" : "items"} (issues and pull requests combined)`,
  );
  return parts.join(" · ");
}

function workEvidence(candidate) {
  const kind = candidate.kind === "pull-request" ? "Pull request" : "Issue";
  const parts = [kind, workAction(candidate.action)];
  if (candidate.updatedAt)
    parts.push(`updated ${new Date(candidate.updatedAt).toLocaleDateString()}`);
  if (candidate.author) parts.push(`by ${candidate.author}`);
  if (candidate.ci) parts.push(`observed CI ${candidate.ci.status}`);
  if (candidate.nextStep?.kind === "checklist-item" && candidate.nextStep.text)
    parts.push(`next checklist item: ${candidate.nextStep.text}`);
  else if (candidate.nextStep?.kind === "reconcile-completed-checklist")
    parts.push("checklist complete; reconcile issue state");
  return parts.join(" · ");
}

function workAction(action) {
  if (action === "continue-or-review-pull-request") return "continue or review";
  if (action === "continue-pull-request") return "continue implementation";
  return "implementation candidate";
}

async function run(value) {
  controller?.abort();
  controller = new AbortController();
  setStatus("Reading public GitHub metadata, structural evidence, and published KPIs…");
  output.hidden = true;

  try {
    const analysis = await analysisJson(value, { signal: controller.signal });
    history.replaceState(null, "", `?repo=${encodeURIComponent(analysis.repository.fullName)}`);
    input.value = analysis.repository.fullName;
    render(analysis);
    setStatus(`Analyzed ${analysis.repository.fullName}.`);
  } catch (error) {
    if (error?.name === "AbortError") return;
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function render(analysis) {
  output.hidden = false;
  document.querySelector("#repo-name").textContent = analysis.repository.fullName;
  document.querySelector("#repo-description").textContent =
    analysis.repository.description ?? "No repository description.";
  const summary = document.querySelector("#summary");
  summary.replaceChildren(
    metric("Status", analysis.summary.status),
    metric("Components", analysis.summary.componentCount),
    metric("Technologies", analysis.summary.technologyCount),
    metric("Findings", analysis.summary.findingCount),
  );

  renderKpis(analysis.kpis);
  const technologies = document.querySelector("#technologies");
  technologies.replaceChildren(...analysis.technologies.map((name) => chip(name)));
  renderComponents(analysis.components);
  renderFindings(analysis.findings);

  const commands = analysis.agentHandoff.localCommands.join("\n");
  document.querySelector("#commands").textContent = commands;
  const json = `${JSON.stringify(analysis, null, 2)}\n`;
  document.querySelector("#json").textContent = json;
  document.querySelector("#copy-commands").onclick = () => navigator.clipboard.writeText(commands);
  document.querySelector("#copy-json").onclick = () => navigator.clipboard.writeText(json);
  document.querySelector("#download-json").onclick = () =>
    download(`${analysis.repository.name}-coding-tooling-preflight.json`, json);
  const machineUrl = new URL("./analysis.json/", location.href);
  machineUrl.searchParams.set("repo", analysis.repository.fullName);
  document.querySelector("#analysis-json-link").href = machineUrl.href;
}

function renderKpis(kpis) {
  const target = document.querySelector("#kpis");
  const rows = [
    [
      "Checklist work",
      checklistValue(kpis?.work?.checklist),
      kpiState(kpis?.work?.checklist),
      "Bounded open-issue task lists; older issues may be omitted when the window is full.",
    ],
    [
      "Public contracts verified",
      ratioValue(
        kpis?.publicContracts?.contracts?.verified,
        kpis?.publicContracts?.contracts?.discovered,
      ),
      kpiState(kpis?.publicContracts),
      "Executed public-contract evidence only; declarations without a passing verifier do not count.",
    ],
    [
      "HTTP endpoints verified",
      ratioValue(
        kpis?.publicContracts?.httpEndpoints?.verified,
        kpis?.publicContracts?.httpEndpoints?.discovered,
      ),
      kpiState(kpis?.publicContracts),
      "HTTP operations discovered through public-contract verification evidence.",
    ],
    [
      "Functions covered by tests",
      coverageValue(kpis?.testCoverage?.functions),
      kpiState(kpis?.testCoverage),
      "Native test coverage; execution coverage is not a claim that every function has meaningful assertions.",
    ],
    [
      "Lines covered by tests",
      coverageValue(kpis?.testCoverage?.lines),
      kpiState(kpis?.testCoverage),
      "Native test coverage from the published current-revision snapshot when available.",
    ],
    [
      "Verification checks passed",
      ratioValue(kpis?.verification?.checks?.passed, kpis?.verification?.checks?.planned),
      kpiState(kpis?.verification),
      "Planned checks remain obligations even when an earlier check blocks later execution.",
    ],
    [
      "Actionable findings",
      kpis?.findings?.total == null
        ? "Unavailable"
        : `${kpis.findings.total} total · ${kpis.findings.highPriority} high priority`,
      kpiState(kpis?.findings),
      "Current remote-preflight findings, including opted-in hosted governance policy.",
    ],
  ];

  target.replaceChildren(
    ...rows.map(([name, value, state, note]) => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("th");
      nameCell.scope = "row";
      nameCell.textContent = name;
      const valueCell = document.createElement("td");
      valueCell.textContent = value;
      const stateCell = document.createElement("td");
      stateCell.textContent = state;
      const noteCell = document.createElement("td");
      noteCell.className = "muted";
      noteCell.textContent = note;
      row.append(nameCell, valueCell, stateCell, noteCell);
      return row;
    }),
  );
}

function checklistValue(checklist) {
  if (!checklist || checklist.remaining == null || checklist.total == null) return "Unavailable";
  if (checklist.total === 0) return "No checklist items in inspected issues";
  return `${checklist.remaining} remaining · ${checklist.completed}/${checklist.total} complete`;
}

function coverageValue(metric) {
  if (!metric) return "Unavailable";
  return `${metric.covered}/${metric.total} · ${formatPercent(metric.percent)}`;
}

function ratioValue(numerator, denominator) {
  if (numerator == null || denominator == null) return "Unavailable";
  if (denominator === 0) return "0 discovered";
  return `${numerator}/${denominator} · ${formatPercent((numerator / denominator) * 100)}`;
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return "n/a";
  return `${Number(value).toFixed(2).replace(/\.00$/, "")}%`;
}

function kpiState(kpi) {
  const statusValue = kpi?.status ?? "unavailable";
  const freshness = kpi?.freshness;
  return freshness && freshness !== "unknown" ? `${statusValue} · ${freshness}` : statusValue;
}

function renderComponents(components) {
  const target = document.querySelector("#components");
  if (!components.length)
    return target.replaceChildren(empty("No supported package, Rust, or .NET component detected."));
  target.replaceChildren(
    ...components.map((component) => {
      const article = document.createElement("article");
      article.className = "card";
      const heading = document.createElement("h3");
      heading.textContent = component.name;
      const meta = document.createElement("p");
      meta.className = "muted";
      meta.textContent = `${component.kind} · ${component.path}`;
      const tags = document.createElement("div");
      tags.className = "chips";
      tags.replaceChildren(...component.technologies.map((name) => chip(name)));
      const list = document.createElement("ul");
      for (const [name, command] of Object.entries(component.capabilities)) {
        const item = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = `${name}: ${command.join(" ")}`;
        item.append(code);
        list.append(item);
      }
      article.append(heading, meta, tags, list);
      return article;
    }),
  );
}

function renderFindings(findings) {
  const target = document.querySelector("#findings");
  if (!findings.length)
    return target.replaceChildren(
      empty("No remote preflight findings. Local checks are still authoritative."),
    );
  target.replaceChildren(
    ...findings.map((finding) => {
      const article = document.createElement("article");
      article.className = `finding finding-${finding.severity}`;
      const label = document.createElement("div");
      label.className = "finding-label";
      label.textContent = `${finding.severity} · ${finding.id}`;
      const heading = document.createElement("h3");
      heading.textContent = finding.title;
      const evidence = document.createElement("p");
      evidence.textContent = finding.evidence;
      const recommendation = document.createElement("p");
      recommendation.className = "recommendation";
      recommendation.textContent = finding.recommendation;
      article.append(label, heading, evidence, recommendation);
      if (finding.command) {
        const code = document.createElement("code");
        code.className = "command";
        code.textContent = finding.command;
        article.append(code);
      }
      return article;
    }),
  );
}

function metric(label, value) {
  const element = document.createElement("div");
  element.className = "metric";
  const strong = document.createElement("strong");
  strong.textContent = String(value);
  const span = document.createElement("span");
  span.textContent = label;
  element.append(strong, span);
  return element;
}

function chip(value) {
  const element = document.createElement("span");
  element.className = "chip";
  element.textContent = value;
  return element;
}

function empty(message) {
  const element = document.createElement("p");
  element.className = "empty";
  element.textContent = message;
  return element;
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.state = error ? "error" : "normal";
}

function setDiscoveryStatus(message, error = false) {
  discoveryStatus.textContent = message;
  discoveryStatus.dataset.state = error ? "error" : "normal";
}

function setNextWorkStatus(message, error = false) {
  nextWorkStatus.textContent = message;
  nextWorkStatus.dataset.state = error ? "error" : "normal";
}

function download(name, content) {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

import { analysisJson } from "./github-analysis.js";

const form = document.querySelector("form");
const input = document.querySelector("#repository");
const status = document.querySelector("#status");
const output = document.querySelector("#output");
let controller;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void run(input.value);
});

const initial = new URL(location.href).searchParams.get("repo");
if (initial) {
  input.value = initial;
  void run(initial);
}

async function run(value) {
  controller?.abort();
  controller = new AbortController();
  setStatus("Reading public GitHub metadata and structural evidence…");
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

function download(name, content) {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

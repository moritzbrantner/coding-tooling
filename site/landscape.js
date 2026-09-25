const filter = document.querySelector("#filter");
const clearFilter = document.querySelector("#clear-filter");
const status = document.querySelector("#status");
const warningSection = document.querySelector("#warnings-section");
const warnings = document.querySelector("#warnings");
const conflicts = document.querySelector("#conflicts");
const capabilities = document.querySelector("#capabilities");
const repositories = document.querySelector("#repositories");

let snapshot;

filter.addEventListener("input", render);
clearFilter.addEventListener("click", () => {
  filter.value = "";
  filter.focus();
  render();
});

try {
  const response = await fetch("./landscape.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`landscape.json returned HTTP ${response.status}`);
  snapshot = await response.json();
  render();
} catch (error) {
  status.dataset.state = "error";
  status.textContent =
    error instanceof Error
      ? `Landscape unavailable: ${error.message}`
      : "Landscape unavailable.";
}

function render() {
  if (!snapshot) return;
  const query = filter.value.trim().toLowerCase();
  const graph = snapshot.graph ?? {};
  const repositoryRows = (graph.repositories ?? []).filter((repository) =>
    matches(repository, query),
  );
  const capabilityNames = new Set([
    ...Object.keys(graph.authorityOwners ?? {}),
    ...(graph.adapterEdges ?? []).map((edge) => edge.capability),
  ]);
  const capabilityEntries = [...capabilityNames]
    .sort()
    .map((capability) => [capability, graph.authorityOwners?.[capability] ?? []])
    .filter(([capability, owners]) =>
      matches({ capability, owners, adapters: adaptersFor(capability) }, query),
    );
  const conflictRows = (graph.conflicts ?? []).filter((conflict) => matches(conflict, query));

  renderWarnings(snapshot.source?.warnings ?? []);
  renderConflicts(conflictRows);
  renderCapabilities(capabilityEntries);
  renderRepositories(repositoryRows);

  const generated = snapshot.generatedAt
    ? new Date(snapshot.generatedAt).toLocaleString()
    : "unknown time";
  status.dataset.state = "";
  status.textContent =
    `${repositoryRows.length} repositories · ${capabilityEntries.length} capabilities · snapshot ${generated}`;
}

function matches(value, query) {
  return !query || JSON.stringify(value).toLowerCase().includes(query);
}

function adaptersFor(capability) {
  return (snapshot.graph?.adapterEdges ?? [])
    .filter((edge) => edge.capability === capability)
    .map((edge) => edge.repository);
}

function renderWarnings(entries) {
  warningSection.hidden = entries.length === 0;
  warnings.replaceChildren(
    ...entries.map((entry) => {
      const article = document.createElement("article");
      article.className = "finding finding-medium";
      const label = document.createElement("div");
      label.className = "finding-label";
      label.textContent = [entry.repository, entry.path].filter(Boolean).join(" · ") || "Collection";
      const message = document.createElement("p");
      message.textContent = entry.message;
      article.append(label, message);
      return article;
    }),
  );
}

function renderConflicts(entries) {
  if (entries.length === 0) {
    conflicts.replaceChildren(empty("No matching duplicate authority declarations."));
    return;
  }
  conflicts.replaceChildren(
    ...entries.map((entry) => {
      const article = document.createElement("article");
      article.className = "finding finding-medium";
      const label = document.createElement("div");
      label.className = "finding-label";
      label.textContent = entry.kind;
      const heading = document.createElement("h3");
      heading.textContent = entry.capability;
      const detail = document.createElement("p");
      detail.textContent = entry.repositories.join(", ");
      article.append(label, heading, detail);
      return article;
    }),
  );
}

function renderCapabilities(entries) {
  capabilities.replaceChildren(
    ...entries.map(([capability, owners]) => {
      const row = document.createElement("tr");
      row.append(
        cell(capability, true),
        cell(owners.join(", ") || "—"),
        cell(adaptersFor(capability).join(", ") || "—"),
      );
      return row;
    }),
  );
}

function renderRepositories(entries) {
  repositories.replaceChildren(
    ...entries.map((repository) => {
      const metadata = repository.metadata ?? {};
      const authority = repository.authority ?? {};
      const row = document.createElement("tr");
      const name = repository.github?.htmlUrl
        ? linkCell(repository.id, repository.github.htmlUrl)
        : cell(repository.id, true);
      row.append(
        name,
        cell([metadata.kind, metadata.status].filter(Boolean).join(" / ") || "unknown"),
        cell((metadata.dependsOn ?? []).join(", ") || "—"),
        cell((authority.owns ?? []).join(", ") || "—"),
        cell((authority.adapts ?? []).join(", ") || "—"),
      );
      return row;
    }),
  );
}

function cell(text, heading = false) {
  const element = document.createElement(heading ? "th" : "td");
  if (heading) element.scope = "row";
  element.textContent = text;
  return element;
}

function linkCell(text, href) {
  const element = document.createElement("th");
  element.scope = "row";
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = text;
  element.append(link);
  return element;
}

function empty(text) {
  const element = document.createElement("div");
  element.className = "empty";
  element.textContent = text;
  return element;
}

import type { AtlasDecision, AtlasIndex } from "./decision-atlas.ts";

function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function statementHtml(value: string): string {
  return html(value).replace(/~~(.*?)~~/g, "<del>$1</del>");
}

function activeLabel(decision: AtlasDecision): string {
  const active = decision.statement.replace(/~~.*?~~/g, "").trim();
  const chosen = active.replace(/^\*\*[ABC][^*]*\*\*\s*—\s*/u, "").trim();
  const label = chosen || decision.statement.replace(/~~/g, "");
  return `${decision.decisionStatus === "superseded" ? "Retired: " : ""}${label.split(/\.\s/)[0]!.slice(0, 94)}`;
}

function anchor(id: string): string {
  return `decision-${encodeURIComponent(id)}`;
}

interface Branch {
  title: string;
  children: Map<string, Branch>;
  decisions: AtlasDecision[];
}

function makeBranch(title: string): Branch {
  return { title, children: new Map(), decisions: [] };
}

function navigation(branch: Branch): string {
  const children = [...branch.children.values()]
    .map(
      (child) =>
        `<details open><summary>${html(child.title)}</summary>${navigation(child)}</details>`,
    )
    .join("");
  const decisions = branch.decisions
    .map((decision) => {
      const label = activeLabel(decision);
      return `<a class="node" data-search="${html([decision.kind, decision.id, ...decision.aliases, label, ...decision.tags].join(" ").toLowerCase())}" href="#${anchor(decision.id)}"><code>${html(decision.id)}</code> ${html(label)}</a>`;
    })
    .join("");
  return children + decisions;
}

export function renderAtlasPreview(index: AtlasIndex): string {
  const root = makeBranch("Decisions");
  for (const decision of index.decisions) {
    let branch = root;
    for (const label of decision.path) {
      if (!branch.children.has(label)) branch.children.set(label, makeBranch(label));
      branch = branch.children.get(label)!;
    }
    branch.decisions.push(decision);
  }
  const sections = index.decisions
    .map((decision) => {
      const sourceUrl = `https://github.com/${index.repository}/blob/${index.sourceRevision}/${decision.source.path}#L${decision.source.line}`;
      const edges = decision.relations
        .map(
          (relation) =>
            `<li><strong>${html(relation.type)}</strong> → <a href="#${anchor(relation.target)}">${html(relation.target)}</a></li>`,
        )
        .join("");
      const references = decision.links
        .map((url) => `<li><a href="${html(url)}" rel="noreferrer">${html(url)}</a></li>`)
        .join("");
      const tags = decision.tags.map((tag) => `<span class="tag">${html(tag)}</span>`).join(" ");
      const aliases = decision.aliases
        .map(
          (alias) =>
            `<span class="tag">Legacy alias: <code>${html(alias)}</code></span><span id="${anchor(alias)}"></span>`,
        )
        .join(" ");
      const detail =
        decision.kind === "question"
          ? "Question: unresolved · No owner-selected choice"
          : `Decision: ${html(decision.decisionStatus ?? "")}${decision.choice === null ? "" : ` · Choice: ${html(decision.choice)}`} · Source implementation claim: ${html(decision.implementation.sourceLabel)}`;
      return `<article id="${anchor(decision.id)}">
      <h2><code>${html(decision.id)}</code> · ${html(decision.kind)}</h2>
      <p class="meta">${detail} · <strong>Implementation not independently verified</strong></p>
      <p>${statementHtml(decision.statement)}</p>
      <p>${tags} ${aliases}</p>
      <p class="meta"><a href="${html(sourceUrl)}">Owning source at committed revision, line ${decision.source.line}</a></p>
      ${edges ? `<h3>Relationships</h3><ul>${edges}</ul>` : ""}
      <h3>Declared sources (not independently verified)</h3><ul class="sources">${references}</ul>
    </article>`;
    })
    .join("\n");
  const title = `${index.repository} · Decision Atlas`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>
:root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; }
header { padding: 1rem 1.5rem; border-bottom: 1px solid #8885; }
h1 { margin: 0 0 .3rem; font-size: 1.4rem; }
.meta { color: #777; font-size: .85rem; overflow-wrap: anywhere; }
main { display: grid; grid-template-columns: minmax(240px, 34%) minmax(0, 1fr); }
nav { padding: 1rem; border-right: 1px solid #8885; max-height: calc(100vh - 7rem); overflow: auto; position: sticky; top: 0; }
nav details { margin-left: .6rem; } nav summary { cursor: pointer; font-weight: 650; padding: .25rem; }
.node { display: block; padding: .3rem .4rem; margin-left: .8rem; text-decoration: none; border-radius: .3rem; }
.node:hover, .node:focus-visible { background: #8883; }
input { width: 100%; padding: .5rem; margin: .6rem 0; font: inherit; }
section { padding: .5rem 1.5rem; min-width: 0; }
article { border-bottom: 1px solid #8885; padding: .8rem 0 1.2rem; scroll-margin-top: 1rem; }
h2 { font-size: 1.1rem; overflow-wrap: anywhere; } h3 { font-size: .9rem; margin-bottom: .1rem; }
code { overflow-wrap: anywhere; } a { color: inherit; } .sources { overflow-wrap: anywhere; }
.tag { display: inline-block; padding: 0 .45rem; margin: .1rem; border: 1px solid #8886; border-radius: .3rem; font-size: .82rem; }
@media(max-width:760px) { main { display: block; } nav { position: static; max-height: 45vh; border-right: 0; border-bottom: 1px solid #8885; } }
</style></head>
<body><header><h1>${html(title)}</h1><div class="meta">Revision: <code>${html(index.sourceRevision)}</code> · ${index.decisions.length} decisions · Read-only derived navigation · Implementation evidence unverified</div></header>
<main><nav aria-label="Decision hierarchy"><label for="atlas-filter">Find a decision or tag</label><input id="atlas-filter" type="search" placeholder="Search IDs, text, tags">${navigation(root)}</nav><section aria-label="Decision details">${sections}</section></main>
<script>
const filter = document.getElementById("atlas-filter");
filter.addEventListener("input", () => {
  const query = filter.value.trim().toLowerCase();
  document.querySelectorAll("a.node").forEach((link) => {
    link.hidden = !link.dataset.search.includes(query);
  });
  document.querySelectorAll("nav details").forEach((group) => {
    group.hidden = query !== "" && !group.querySelector('a.node:not([hidden])');
    if (query !== "") group.open = true;
  });
});
</script></body></html>\n`;
}

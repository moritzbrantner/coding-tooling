import {
  changeDrivers,
  chartSegments,
  diagnosticText,
  latestEntry,
  normalizeHistory,
  scoreDelta,
  shortCommit,
  shortFingerprint,
  verificationEvidence,
} from "./model.js";

const HISTORY_URL =
  "https://raw.githubusercontent.com/moritzbrantner/coding-tooling/score-history/history.json";

const status = document.querySelector("#status");
const latest = document.querySelector("#latest-score");
const latestRating = document.querySelector("#latest-rating");
const delta = document.querySelector("#score-delta");
const deltaLabel = document.querySelector("#score-delta-label");
const structural = document.querySelector("#structural-score");
const verification = document.querySelector("#verification-score");
const definition = document.querySelector("#definition-fingerprint");
const scoreProfile = document.querySelector("#score-profile");
const chart = document.querySelector("#score-chart");
const categories = document.querySelector("#categories");
const changeList = document.querySelector("#change-drivers");
const auditBody = document.querySelector("#audit-body");
const historyBody = document.querySelector("#history-body");
const latestCommit = document.querySelector("#latest-commit");

function scoreText(value) {
  return value === null ? "—" : String(value);
}

function ratingText(value) {
  return String(value ?? "unavailable").replaceAll("-", " ");
}

function signed(value) {
  if (value === null || value === 0) return value === 0 ? "±0" : "—";
  return `${value > 0 ? "+" : ""}${value}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderChart(entries) {
  const recent = entries.slice(-60);
  const segments = chartSegments(recent);
  const points = segments.flat();
  if (points.length === 0) {
    chart.innerHTML = '<text x="360" y="120" text-anchor="middle">No scored commits yet</text>';
    return;
  }

  const guideLines = [0, 25, 50, 75, 100]
    .map((score) => {
      const y = 24 + ((100 - score) / 100) * 192;
      return `<g class="guide"><line x1="24" y1="${y}" x2="696" y2="${y}"/><text x="2" y="${y + 4}">${score}</text></g>`;
    })
    .join("");
  const polylines = segments
    .filter((segment) => segment.length > 1)
    .map(
      (segment) =>
        `<polyline class="series" points="${segment.map((point) => `${point.x},${point.y}`).join(" ")}"/>`,
    )
    .join("");
  const dots = points
    .map((point) => {
      const label = `${shortCommit(point.commit)} · ${point.score}/100 · ${verificationEvidence(point)} · ${point.scoreProfileVersion ?? "legacy profile"} · definition ${shortFingerprint(point.definitionFingerprint)}`;
      return `<circle cx="${point.x}" cy="${point.y}" r="4"><title>${escapeHtml(label)}</title></circle>`;
    })
    .join("");
  chart.innerHTML = `${guideLines}${polylines}${dots}`;
}

function renderCategories(entry) {
  const values = Object.entries(entry.categories ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  categories.innerHTML = values.length
    ? values
        .map(
          ([name, score]) => `
            <div class="category-row">
              <span>${escapeHtml(name.replaceAll("-", " "))}</span>
              <strong>${scoreText(score)}</strong>
              <div class="meter"><span style="width:${score ?? 0}%"></span></div>
            </div>`,
        )
        .join("")
    : '<p class="muted">No category scores available.</p>';
}

function driverDetail(driver) {
  if (driver.kind !== "audit") return "";
  const details = [];
  if (driver.failedSubjectsDelta)
    details.push(`${signed(driver.failedSubjectsDelta)} failed subjects`);
  if (driver.activeFindingsDelta)
    details.push(`${signed(driver.activeFindingsDelta)} active findings`);
  return details.length ? `<small>${escapeHtml(details.join(" · "))}</small>` : "";
}

function renderChanges(entry) {
  const drivers = changeDrivers(entry);
  if (drivers.length === 0) {
    changeList.innerHTML = '<p class="muted">No score-affecting evidence changed.</p>';
    return;
  }
  changeList.innerHTML = drivers
    .map(
      (driver) => `
        <div class="change-row">
          <div>
            <strong>${escapeHtml(driver.label)}</strong>
            ${driverDetail(driver)}
          </div>
          <span>${signed(driver.delta)}</span>
        </div>`,
    )
    .join("");
}

function renderAudits(entry) {
  auditBody.innerHTML = (entry.audits ?? [])
    .map(
      (audit) => `
        <tr>
          <td>${escapeHtml(audit.id)}</td>
          <td>${escapeHtml(String(audit.category).replaceAll("-", " "))}</td>
          <td>${scoreText(audit.score)}</td>
          <td>${scoreText(audit.subjects)}</td>
          <td>${scoreText(audit.failedSubjects)}</td>
          <td>${audit.activeFindings ?? 0}</td>
          <td>${escapeHtml(ratingText(audit.coverageStatus))}</td>
        </tr>`,
    )
    .join("");
}

function renderTable(entries) {
  historyBody.innerHTML = entries
    .slice(-20)
    .toReversed()
    .map((entry) => {
      const evidence = verificationEvidence(entry);
      const diagnostics = diagnosticText(entry);
      return `
        <tr>
          <td><a href="https://github.com/moritzbrantner/coding-tooling/commit/${entry.commit}">${shortCommit(entry.commit)}</a></td>
          <td>${new Date(entry.timestamp).toLocaleString()}</td>
          <td><strong>${scoreText(entry.score)}</strong></td>
          <td>${entry.change?.comparable ? signed(entry.change.scoreDelta) : "—"}</td>
          <td><code>${escapeHtml(entry.scoreProfileVersion ?? "legacy")}</code></td>
          <td><code>${shortFingerprint(entry.definitionFingerprint)}</code></td>
          <td>${escapeHtml(evidence)}${diagnostics ? `<br><small>${escapeHtml(diagnostics)}</small>` : ""}</td>
          <td>${escapeHtml(ratingText(entry.rating))}</td>
        </tr>`;
    })
    .join("");
}

async function load() {
  try {
    const response = await fetch(`${HISTORY_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`history request failed with ${response.status}`);
    const history = normalizeHistory(await response.json());
    const entry = latestEntry(history);
    if (!entry) {
      status.textContent =
        "The history branch exists, but no score snapshot has been published yet.";
      return;
    }

    latest.textContent = scoreText(entry.score);
    latestRating.textContent = `${ratingText(entry.rating)} · ${entry.completeness} · verification ${verificationEvidence(entry)}`;
    delta.textContent = signed(scoreDelta(history.entries));
    deltaLabel.textContent = entry.change?.comparable
      ? "Change from comparable prior commit"
      : "Comparison boundary";
    structural.textContent = scoreText(entry.structuralScore);
    verification.textContent = scoreText(entry.verificationScore);
    definition.textContent = shortFingerprint(entry.definitionFingerprint);
    definition.title = entry.definitionFingerprint ?? "Definition fingerprint unavailable";
    scoreProfile.textContent = entry.scoreProfileVersion ?? "legacy / unknown";
    latestCommit.textContent = shortCommit(entry.commit);
    latestCommit.href = `https://github.com/moritzbrantner/coding-tooling/commit/${entry.commit}`;
    renderChart(history.entries);
    renderCategories(entry);
    renderChanges(entry);
    renderAudits(entry);
    renderTable(history.entries);

    const retained = `${history.entries.length} commit snapshot${history.entries.length === 1 ? "" : "s"} retained across ${Object.keys(history.definitions).length} exact score definition${Object.keys(history.definitions).length === 1 ? "" : "s"}.`;
    if (entry.score === null) {
      const detail = diagnosticText(entry) || verificationEvidence(entry);
      status.textContent = `${retained} The latest commit could not be scored: ${detail}`;
    } else if (!entry.change?.comparable) {
      status.textContent = `${retained} The latest commit is a comparison boundary; its numeric delta is intentionally withheld.`;
    } else {
      status.textContent = retained;
    }
  } catch (error) {
    status.textContent = `Score history is not available yet: ${error instanceof Error ? error.message : String(error)}`;
  }
}

load();

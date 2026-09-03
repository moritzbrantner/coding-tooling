import {
  chartPoints,
  latestEntry,
  normalizeHistory,
  scoreDelta,
  scoreProfileChanged,
  shortCommit,
} from "./model.js";

const HISTORY_URL =
  "https://raw.githubusercontent.com/moritzbrantner/coding-tooling/score-history/history.json";

const status = document.querySelector("#status");
const latest = document.querySelector("#latest-score");
const latestRating = document.querySelector("#latest-rating");
const delta = document.querySelector("#score-delta");
const structural = document.querySelector("#structural-score");
const verification = document.querySelector("#verification-score");
const chart = document.querySelector("#score-chart");
const categories = document.querySelector("#categories");
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

function profileSeries(points) {
  const series = [];
  for (const point of points) {
    const current = series.at(-1);
    if (!current || current.at(-1)?.scoreProfileVersion !== point.scoreProfileVersion) {
      series.push([point]);
    } else {
      current.push(point);
    }
  }
  return series;
}

function renderChart(entries) {
  const recent = entries.slice(-60);
  const points = chartPoints(recent);
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
  const lines = profileSeries(points)
    .filter((series) => series.length > 1)
    .map(
      (series) =>
        `<polyline class="series" points="${series.map((point) => `${point.x},${point.y}`).join(" ")}"/>`,
    )
    .join("");
  const dots = points
    .map(
      (point) =>
        `<circle cx="${point.x}" cy="${point.y}" r="4"><title>${shortCommit(point.commit)} · ${point.score}/100 · ${point.scoreProfileVersion ?? "legacy profile"}</title></circle>`,
    )
    .join("");
  chart.innerHTML = `${guideLines}${lines}${dots}`;
}

function renderCategories(entry) {
  const values = Object.entries(entry.categories ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  categories.innerHTML = values.length
    ? values
        .map(
          ([name, score]) => `
            <div class="category-row">
              <span>${name.replaceAll("-", " ")}</span>
              <strong>${scoreText(score)}</strong>
              <div class="meter"><span style="width:${score ?? 0}%"></span></div>
            </div>`,
        )
        .join("")
    : '<p class="muted">No category scores available.</p>';
}

function renderTable(entries) {
  historyBody.innerHTML = entries
    .slice(-20)
    .reverse()
    .map(
      (entry) => `
        <tr>
          <td><a href="https://github.com/moritzbrantner/coding-tooling/commit/${entry.commit}">${shortCommit(entry.commit)}</a></td>
          <td>${new Date(entry.timestamp).toLocaleString()}</td>
          <td><strong>${scoreText(entry.score)}</strong></td>
          <td>${scoreText(entry.structuralScore)}</td>
          <td>${scoreText(entry.verificationScore)}</td>
          <td>${ratingText(entry.rating)}</td>
        </tr>`,
    )
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
    latestRating.textContent = `${ratingText(entry.rating)} · ${entry.completeness}`;
    delta.textContent = signed(scoreDelta(history.entries));
    structural.textContent = scoreText(entry.structuralScore);
    verification.textContent = scoreText(entry.verificationScore);
    latestCommit.textContent = shortCommit(entry.commit);
    latestCommit.href = `https://github.com/moritzbrantner/coding-tooling/commit/${entry.commit}`;
    renderChart(history.entries);
    renderCategories(entry);
    renderTable(history.entries);
    const retained = `${history.entries.length} commit snapshot${history.entries.length === 1 ? "" : "s"} retained.`;
    status.textContent = scoreProfileChanged(history.entries)
      ? `${retained} The latest commit starts a new scoring profile; its delta is intentionally withheld.`
      : retained;
  } catch (error) {
    status.textContent = `Score history is not available yet: ${error instanceof Error ? error.message : String(error)}`;
  }
}

load();

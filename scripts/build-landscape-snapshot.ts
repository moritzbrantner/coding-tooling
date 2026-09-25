import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fleetAuthorityGraph } from "../src/fleet-authority-graph.ts";

type GitHubRepository = {
  archived: boolean;
  default_branch: string;
  description: string | null;
  disabled: boolean;
  fork: boolean;
  full_name: string;
  html_url: string;
  name: string;
  pushed_at: string | null;
};

type CollectionWarning = {
  repository?: string;
  path?: string;
  message: string;
};

const owner =
  process.env.LANDSCAPE_OWNER?.trim() ||
  process.env.GITHUB_REPOSITORY_OWNER ||
  "moritzbrantner";
const token = process.env.GITHUB_TOKEN?.trim();
const warnings: CollectionWarning[] = [];

function headers(): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "coding-tooling-landscape",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function github(
  url: string,
  warning: CollectionWarning,
): Promise<Response | undefined> {
  try {
    return await fetch(url, { headers: headers() });
  } catch (error) {
    warnings.push({
      ...warning,
      message: `${warning.message}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
}

async function listRepositories(): Promise<GitHubRepository[]> {
  const repositories: GitHubRepository[] = [];
  for (let page = 1; ; page += 1) {
    const response = await github(
      `https://api.github.com/users/${encodeURIComponent(
        owner,
      )}/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=${page}`,
      { message: `Repository listing request failed on page ${page}` },
    );
    if (!response) break;
    if (!response.ok) {
      warnings.push({
        message: `Repository listing stopped at page ${page}: GitHub returned ${response.status}.`,
      });
      break;
    }
    const items = (await response.json()) as GitHubRepository[];
    repositories.push(...items);
    if (items.length < 100) break;
  }
  return repositories
    .filter((repository) => !repository.fork && !repository.disabled)
    .sort((left, right) => left.full_name.localeCompare(right.full_name));
}

async function readRepositoryFile(
  repository: GitHubRepository,
  path: string,
): Promise<string | undefined> {
  const response = await github(
    `https://api.github.com/repos/${repository.full_name}/contents/${path}?ref=${encodeURIComponent(
      repository.default_branch,
    )}`,
    {
      repository: repository.full_name,
      path,
      message: "GitHub content request failed",
    },
  );
  if (!response) return undefined;
  if (response.status === 404) return undefined;
  if (!response.ok) {
    warnings.push({
      repository: repository.full_name,
      path,
      message: `GitHub returned ${response.status}.`,
    });
    return undefined;
  }
  const payload = (await response.json()) as { content?: string; encoding?: string };
  if (payload.encoding !== "base64" || typeof payload.content !== "string") {
    warnings.push({
      repository: repository.full_name,
      path,
      message: "GitHub returned an unsupported content encoding.",
    });
    return undefined;
  }
  return Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
}

const root = mkdtempSync(join(tmpdir(), "coding-tooling-landscape-"));

try {
  const repositories = await listRepositories();
  const metadata = new Map<string, GitHubRepository>();
  let collectedRepositoryCount = 0;

  for (const repository of repositories) {
    const repositoryRoot = join(root, repository.name);
    mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
    metadata.set(repository.full_name, repository);
    metadata.set(repository.name, repository);

    const repositoryMetadata = await readRepositoryFile(
      repository,
      ".repository.toml",
    );
    const agents = await readRepositoryFile(repository, "AGENTS.md");
    if (repositoryMetadata) {
      writeFileSync(join(repositoryRoot, ".repository.toml"), repositoryMetadata);
    }
    if (agents) writeFileSync(join(repositoryRoot, "AGENTS.md"), agents);
    if (repositoryMetadata || agents) collectedRepositoryCount += 1;
  }

  const result = fleetAuthorityGraph(root);
  const graph = result.data as {
    root?: unknown;
    repositories?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  const { root: _localRoot, repositories: graphRepositories = [], ...rest } = graph;
  const publicRepositories = graphRepositories.map((repository) => {
    const { root: _repositoryRoot, ...publicRepository } = repository;
    const id = typeof publicRepository.id === "string" ? publicRepository.id : "";
    const github = metadata.get(id);
    return {
      ...publicRepository,
      github: github
        ? {
            archived: github.archived,
            description: github.description,
            htmlUrl: github.html_url,
            pushedAt: github.pushed_at,
          }
        : null,
    };
  });

  const snapshot = {
    schemaVersion: 1,
    kind: "coding-tooling/landscape",
    generatedAt: new Date().toISOString(),
    owner,
    source: {
      kind: "github-public-repositories",
      repositoryCount: repositories.length,
      collectedRepositoryCount,
      warnings,
    },
    graph: {
      ...rest,
      repositories: publicRepositories,
    },
  };

  writeFileSync("site/landscape.json", JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `Wrote site/landscape.json with ${publicRepositories.length} repositories and ${warnings.length} collection warnings.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

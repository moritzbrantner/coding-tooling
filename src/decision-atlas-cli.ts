import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  buildAtlasIndex,
  type AtlasFormat,
  type AtlasIndex,
  type AtlasSource,
} from "./decision-atlas.ts";
import { renderAtlasPreview } from "./decision-atlas-preview.ts";

const maxFiles = 256;
const maxBytes = 2 * 1024 * 1024;
const formats = new Set<AtlasFormat>(["my-farm-tree", "numbered-list", "canonical"]);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: maxBytes + 1024,
  });
}

function sourcePaths(root: string, relativeSource: string, format: AtlasFormat): string[] {
  if (
    !/^docs\/decisions\/[A-Za-z0-9_./-]+$/.test(relativeSource) ||
    relativeSource.split("/").some((piece) => piece === "." || piece === "..")
  ) {
    throw new Error("source must be a repository-relative path inside docs/decisions");
  }
  const path = join(root, relativeSource);
  if (!existsSync(path)) throw new Error(`missing source: ${relativeSource}`);
  const kind = lstatSync(path);
  if (kind.isSymbolicLink()) throw new Error("symlinked decision sources are not followed");
  if (kind.isFile()) {
    if (!relativeSource.endsWith(".md")) throw new Error("decision source must be Markdown");
    return [relativeSource];
  }
  if (!kind.isDirectory() || format !== "canonical")
    throw new Error("only canonical sources can be directories");
  const pending = [relativeSource];
  const collected: string[] = [];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const child = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`symlinked decision source: ${child}`);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && entry.name.endsWith(".md")) collected.push(child);
      if (collected.length + pending.length > maxFiles)
        throw new Error("decision source file budget exceeded");
    }
  }
  return collected.sort();
}

export interface AtlasCommandOptions {
  root: string;
  repository: string;
  source: string;
  format: AtlasFormat;
  revision: string;
  output?: string;
  previous?: string;
  minDecisions?: number;
}

export function indexRepository(options: AtlasCommandOptions): AtlasIndex {
  const root = resolve(options.root);
  const actual = git(root, "rev-parse", "HEAD").trim();
  if (actual !== options.revision)
    throw new Error(`stale source revision: expected ${options.revision}, checkout is ${actual}`);
  const remote = git(root, "config", "--get", "remote.origin.url").trim();
  const normalizedRemote = remote
    .replace(/^git@github\\.com:/, "https://github.com/")
    .replace(/\\.git$/, "");
  if (normalizedRemote !== `https://github.com/${options.repository}`)
    throw new Error(`repository identity mismatch: origin is ${remote}`);
  const paths = sourcePaths(root, options.source, options.format);
  let bytes = 0;
  const sources: AtlasSource[] = paths.map((path) => {
    const file = join(root, path);
    if (!lstatSync(file).isFile()) throw new Error(`unsafe source file: ${path}`);
    const actualText = readFileSync(file, "utf8");
    const committed = git(root, "show", `${actual}:${path}`);
    if (committed !== actualText) throw new Error(`uncommitted or stale decision source: ${path}`);
    bytes += Buffer.byteLength(actualText, "utf8");
    if (bytes > maxBytes) throw new Error("decision text budget exceeded");
    return { path, format: options.format, text: committed };
  });
  let previous: AtlasIndex | undefined;
  if (options.previous) {
    previous = JSON.parse(readFileSync(resolve(options.previous), "utf8")) as AtlasIndex;
    if (!previous || previous.schemaVersion !== 1 || !Array.isArray(previous.decisions))
      throw new Error("previous index has an unsupported schema");
  }
  const index = buildAtlasIndex(options.repository, actual, sources, previous);
  if (options.minDecisions !== undefined && index.decisions.length < options.minDecisions)
    throw new Error(
      `incomplete index: expected at least ${options.minDecisions}, found ${index.decisions.length}`,
    );
  return index;
}

function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  writeFileSync(path, content, "utf8");
}

function usage(): never {
  throw new Error(
    "usage: coding-tooling decision-atlas index --root <checkout> --repository <owner/repo> --source docs/decisions/<file-or-directory> --format <my-farm-tree|numbered-list|canonical> --revision <40-char-commit> [--previous-index <index.json>] [--min-decisions <n>] [--output <directory>]",
  );
}

export function decisionAtlasCommand(argv: string[]): number {
  try {
    if (argv[0] !== "index") usage();
    const options = new Map<string, string>();
    const allowed = new Set([
      "--root",
      "--repository",
      "--source",
      "--format",
      "--revision",
      "--previous-index",
      "--min-decisions",
      "--output",
    ]);
    for (let i = 1; i < argv.length; i += 2) {
      const key = argv[i]!;
      const value = argv[i + 1];
      if (!allowed.has(key) || !value || value.startsWith("--") || options.has(key)) usage();
      options.set(key, value);
    }
    const root = options.get("--root");
    const repository = options.get("--repository");
    const source = options.get("--source");
    const format = options.get("--format") as AtlasFormat | undefined;
    const revision = options.get("--revision");
    if (!root || !repository || !source || !format || !formats.has(format) || !revision) usage();
    const threshold = options.get("--min-decisions");
    const minDecisions = threshold === undefined ? undefined : Number(threshold);
    if (minDecisions !== undefined && (!Number.isInteger(minDecisions) || minDecisions < 1))
      usage();
    const index = indexRepository({
      root,
      repository,
      source,
      format,
      revision,
      previous: options.get("--previous-index"),
      minDecisions,
    });
    const document = JSON.stringify(index, null, 2) + "\n";
    const output = options.get("--output");
    if (output) {
      const destination = resolve(output);
      const relativePath = relative(resolve(root), destination);
      const insideCheckout =
        !isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
      const disposable =
        relativePath === ".artifacts" || relativePath.startsWith(`.artifacts${sep}`);
      if (insideCheckout && !disposable) {
        throw new Error(
          "output must be outside the owner checkout or inside its .artifacts directory",
        );
      }
      mkdirSync(destination, { recursive: true });
      writeIfChanged(join(destination, "index.json"), document);
      writeIfChanged(join(destination, "preview.html"), renderAtlasPreview(index));
      console.log(`Decision Atlas: ${index.decisions.length} indexed decisions in ${destination}`);
    } else {
      process.stdout.write(document);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

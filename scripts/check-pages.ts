import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    !isAbsolute(child) && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\")
  );
}

function files(root: string): string[] {
  const paths: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Static artifact contains a symlink: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error(`Static artifact contains an unsupported entry: ${path}`);
    }
  }
  visit(root);
  // oxlint-disable-next-line unicorn/no-array-sort -- Sort fresh inventory under the repository's ES2022 target.
  return paths.sort((left, right) => {
    const a = relative(root, left).replaceAll("\\", "/");
    const b = relative(root, right).replaceAll("\\", "/");
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function checkPagesArtifact(artifactPath: string, expectedHtml: string[]) {
  const root = resolve(artifactPath);
  if (expectedHtml.length === 0) throw new Error("No source-owned HTML entrypoints were declared");
  const inventory = files(root);
  const resources = new Set<string>();
  const externalResources = new Set<string>();
  for (const html of expectedHtml) {
    const path = resolve(root, html);
    if (!inside(root, path) || !lstatSync(path).isFile())
      throw new Error(`Missing regular HTML entrypoint: ${html}`);
    const source = readFileSync(path, "utf8");
    for (const tag of source.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
      const attribute = /\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag[0]);
      const resource = attribute?.[1] ?? attribute?.[2] ?? attribute?.[3];
      if (!resource || resource.startsWith("#")) continue;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(resource)) {
        externalResources.add(resource);
        continue;
      }
      const target = resolve(dirname(path), decodeURIComponent(resource.split(/[?#]/)[0]!));
      if (!inside(root, target) || !lstatSync(target).isFile())
        throw new Error(`Missing owned resource ${resource} in ${html}`);
      resources.add(relative(root, target).replaceAll("\\", "/"));
    }
  }
  const artifacts = inventory.map((path) => ({
    path: relative(root, path).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }));
  return {
    schemaVersion: 1,
    kind: "structural-static-artifact",
    status: "passed",
    artifactRoot: root,
    fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(artifacts)).digest("hex")}`,
    htmlEntrypoints: expectedHtml,
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort fresh inventory under the repository's ES2022 target.
    ownedResources: [...resources].sort(),
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort fresh inventory under the repository's ES2022 target.
    unverifiedExternalResources: [...externalResources].sort(),
    artifacts,
    limitations: [
      "Structural HTML resource acceptance only; no browser behavior, security, coverage, or performance claim.",
    ],
  };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  try {
    const expectedHtml = files(join(root, "site"))
      .filter((path) => path.endsWith(".html"))
      .map((path) => relative(join(root, "site"), path).replaceAll("\\", "/"));
    console.log(
      JSON.stringify(checkPagesArtifact(join(root, ".artifacts", "pages"), expectedHtml)),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        kind: "structural-static-artifact",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}

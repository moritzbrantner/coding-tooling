import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("the deployed Worker bundle analyzes React source and rejects private repositories in workerd", async () => {
  const build = spawnSync(process.execPath, ["run", "analysis:worker:bundle"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_HIDE_BANNER: "true" },
  });
  expect(build.status, build.stderr).toBe(0);
  const config = Bun.JSONC.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  const directory = join(root, ".artifacts/analysis-worker");
  const source = readFileSync(
    join(root, "fixtures/react-update-boundaries/violations.tsx"),
    "utf8",
  );
  const revision = "a".repeat(40);
  const files = {
    "package.json": JSON.stringify({ name: "repo", packageManager: "bun@1.4.2" }),
    "src/Scene.tsx": source,
  };
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: directory,
      modulesRoot: directory,
      modules: true,
      scriptPath: join(directory, "analysis-worker.js"),
      compatibilityDate: config.compatibility_date,
      port: 0,
      cf: false,
      outboundService: async (request) => {
        const path = new URL(request.url).pathname;
        let body;
        if (path === "/repos/example/private") body = { private: true };
        else if (path === "/repos/example/repo")
          body = {
            private: false,
            owner: { login: "example" },
            name: "repo",
            full_name: "example/repo",
            default_branch: "main",
            allow_merge_commit: true,
          };
        else if (path.endsWith("/branches/main"))
          body = { commit: { sha: revision }, protected: false };
        else if (path.includes("/git/trees/"))
          body = {
            tree: Object.entries(files).map(([sourcePath, content]) => ({
              type: "blob",
              path: sourcePath,
              sha: sourcePath,
              size: content.length,
            })),
            truncated: false,
          };
        else if (path.includes("/git/blobs/"))
          body = {
            encoding: "base64",
            content: Buffer.from(files[path.split("/git/blobs/")[1]]).toString("base64"),
          };
        else return new Response("{}", { status: 404 });
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      },
    }),
  );
  try {
    const response = await runtime.dispatchFetch(
      "http://analysis.local/analysis.json?repo=example/repo&view=agent&focus=performance&envelope=1",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.data.findings).toHaveLength(3);
    const privateResponse = await runtime.dispatchFetch(
      "http://analysis.local/analysis.json?repo=example/private&envelope=1",
    );
    expect(privateResponse.status).toBe(404);
  } finally {
    await runtime.dispose();
  }
});

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const script = resolve(import.meta.dir, "../templates/codex-environment.sh");

function setup(apt: string[], tools = ["bash", "python3", "git"]) {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-codex-environment-"));
  const bin = join(root, ".bin");
  mkdirSync(bin);
  // Only these host tools are visible, so host-installed packages cannot leak into results.
  for (const tool of tools) {
    const found = spawnSync("bash", ["-c", `command -v ${tool}`], {
      encoding: "utf8",
    }).stdout.trim();
    symlinkSync(found, join(bin, tool));
  }
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("sudo", 'exec "$@"');
  stub("apt-get", `echo "$*" >> "${root}/apt.log"`);
  stub("dpkg-query", 'if [[ "${@: -1}" == xvfb ]]; then printf "ii "; exit 0; fi; exit 1');
  stub("cmake", "exit 0");
  writeFileSync(
    join(root, ".repository-environment.toml"),
    `schema_version = 1\n[system]\napt = ${JSON.stringify(apt)}\n`,
  );
  spawnSync("git", ["init", "-q", root]);
  const result = spawnSync("bash", [script, "setup"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: bin, HOME: root },
  });
  let aptLog = "";
  try {
    aptLog = readFileSync(join(root, "apt.log"), "utf8");
  } catch {}
  return { ...result, aptLog };
}

describe("codex-environment.sh system packages", () => {
  test("does not contact apt when the image already provides every package", () => {
    const result = setup(["xvfb"]);
    expect(result.status).toBe(0);
    expect(result.aptLog).toBe("");
  });

  test("installs packages missing from dpkg, even with a same-named binary, with bounded retries", () => {
    const result = setup(["xvfb", "cmake", "ffmpeg"]);
    expect(result.status).toBe(0);
    const calls = result.aptLog.trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("Acquire::Retries=3");
    expect(calls[0]).toEndWith("update");
    expect(calls[1]).toEndWith("install -y --no-install-recommends cmake ffmpeg");
  });

  test("reads the config with Bun when Python's tomllib is unavailable", () => {
    const result = setup(["xvfb", "ffmpeg"], ["bash", "bun", "git"]);
    expect(result.status).toBe(0);
    expect(result.aptLog.trim().split("\n")[1]).toEndWith(
      "install -y --no-install-recommends ffmpeg",
    );
  });
});

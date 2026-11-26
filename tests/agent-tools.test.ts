import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const root = resolve(import.meta.dir, "..");
const miseToml = readFileSync(join(root, "mise.toml"), "utf8");
const installer = join(root, "toolbox", "install-global.sh");
const launcher = join(root, "toolbox", "with-agent-tools.sh");
const smoke = join(root, "toolbox", "agent-tools-check.sh");

const executables: Record<string, string> = {
  jq: "jq",
  ripgrep: "rg",
  fd: "fd",
  gh: "gh",
  yq: "yq",
  shellcheck: "shellcheck",
  shfmt: "shfmt",
  actionlint: "actionlint",
  hyperfine: "hyperfine",
  uv: "uv",
  just: "just",
  bat: "bat",
};

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "coding-tooling-agent-tools-"));
}

function fakeCommand(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("shared agent tools", () => {
  test("the configured mise tools and executable smoke remain in sync", () => {
    const parsed = Bun.TOML.parse(miseToml) as { tools: Record<string, string> };
    expect(Object.keys(parsed.tools).toSorted()).toEqual(Object.keys(executables).toSorted());
    expect(Object.values(parsed.tools)).toEqual(
      Array(Object.keys(executables).length).fill("latest"),
    );

    const source = readFileSync(smoke, "utf8");
    const actual = [...source.matchAll(/^  ([a-z-]+):([a-z-]+)$/gm)].map((match) => [
      match[1],
      match[2],
    ]);
    expect(actual).toEqual(Object.entries(executables));
  });

  test("the Docker image installs and runs the same manifest without copying source", () => {
    const dockerfile = readFileSync(join(root, "toolbox", "Dockerfile"), "utf8");
    const dockerignore = readFileSync(join(root, ".dockerignore"), "utf8");
    expect(dockerfile).toContain("COPY mise.toml /mise/config.toml");
    expect(dockerfile).toContain("RUN mise install && bash /usr/local/bin/agent-tools-check");
    expect(dockerfile).not.toMatch(/^COPY\s+\.\s/m);
    expect(dockerignore).toContain("**\n!mise.toml\n!toolbox/");
  });

  test("the smoke fails if a listed executable is missing or cannot run", () => {
    const directory = temporaryRoot();
    try {
      const bin = join(directory, "bin");
      mkdirSync(bin);
      for (const executable of Object.values(executables)) {
        fakeCommand(join(bin, executable), 'test "$1" = --version');
      }
      const run = () =>
        spawnSync("/bin/bash", [smoke], {
          encoding: "utf8",
          env: { PATH: bin },
        });

      expect(run().status).toBe(0);
      fakeCommand(join(bin, "uv"), "exit 1");
      expect(run().status).toBe(1);
      expect(run().stderr).toContain("agent tool cannot run: uv");
      rmSync(join(bin, "uv"));
      expect(run().status).toBe(1);
      expect(run().stderr).toContain("agent tool unavailable: uv");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the opt-in launcher exposes all tools to a clean child shell and preserves PATH precedence", () => {
    const directory = temporaryRoot();
    try {
      const bin = join(directory, "project bin");
      const data = join(directory, "mise data");
      const shims = join(data, "shims");
      mkdirSync(bin);
      mkdirSync(shims, { recursive: true });
      for (const executable of Object.values(executables)) {
        fakeCommand(join(shims, executable), 'test "$1" = --version');
      }
      fakeCommand(join(shims, "node"), "exit 1");
      fakeCommand(join(bin, "node"), 'printf "%s\\n" "$1"');
      const options = {
        encoding: "utf8" as const,
        cwd: directory,
        env: { PATH: bin, MISE_DATA_DIR: data },
      };
      const shellFlags = ["--noprofile", "--norc"];
      expect(spawnSync("/bin/bash", [...shellFlags, smoke], options).status).toBe(1);
      const launched = spawnSync(
        "/bin/bash",
        [
          launcher,
          "/bin/bash",
          ...shellFlags,
          "-ec",
          '/bin/bash "$1"; node "$2"; exit 7',
          "agent",
          smoke,
          "project tool",
        ],
        options,
      );
      expect(launched.stdout).toBe("12 agent tools ready\nproject tool\n");
      expect(launched.status).toBe(7);

      const customShims = spawnSync("/bin/bash", [launcher, "/bin/bash", ...shellFlags, smoke], {
        ...options,
        env: { PATH: bin, MISE_SHIMS_DIR: shims },
      });
      expect(customShims.stdout).toBe("12 agent tools ready\n");
      expect(customShims.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the global installer is read-only by default, converges and preserves unmanaged config", () => {
    const directory = temporaryRoot();
    try {
      const bin = join(directory, "bin");
      const config = join(directory, "mise-config");
      const target = join(config, "conf.d", "coding-agent-tools.toml");
      const log = join(directory, "mise.log");
      mkdirSync(bin);
      fakeCommand(
        join(bin, "mise"),
        'printf "%s|%s\\n" "$MISE_GLOBAL_CONFIG_FILE" "$*" >> "$AGENT_TOOLS_MISE_LOG"',
      );
      const run = (mode?: string) =>
        spawnSync("/bin/bash", [installer, ...(mode ? [mode] : [])], {
          encoding: "utf8",
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            MISE_CONFIG_DIR: config,
            MISE_GLOBAL_CONFIG_FILE: "",
            AGENT_TOOLS_MISE_LOG: log,
          },
        });

      expect(run().status).toBe(1);
      expect(run("--install").status).toBe(0);
      expect(readFileSync(target, "utf8")).toBe(miseToml);
      expect(readFileSync(log, "utf8")).toContain(`${target}|-C `);
      expect(run("--check").status).toBe(0);
      const before = statSync(target).mtimeMs;
      expect(run("--install").status).toBe(0);
      expect(statSync(target).mtimeMs).toBe(before);

      writeFileSync(target, "[tools]\nnode = 'lts'\n");
      expect(run("--install").status).toBe(2);
      expect(readFileSync(target, "utf8")).toContain("node = 'lts'");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

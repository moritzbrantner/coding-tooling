export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function runCommand(command: string[], cwd: string): CommandResult {
  const started = performance.now();
  try {
    const result = Bun.spawnSync(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Math.round(performance.now() - started),
    };
  }
}

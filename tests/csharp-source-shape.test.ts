import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { runConventionChecks } from "../src/convention-enforcement.ts";
import { discoverComponents } from "../src/core.ts";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "coding-tooling-csharp-shape-"));
  writeFileSync(join(root, "Fixture.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
  const directory = join(root, ".conventions", "modules", "fixture");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "CSHARP-002.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ruleId: "CSHARP-002",
        enforcement: { kind: "builtin", check: "csharp-explicit-control-flow" },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

test("requires braces for C# control-flow bodies", () => {
  const root = repository();
  const source = join(root, "Service.cs");
  writeFileSync(
    source,
    `public class Service\n{\n    public void Run(bool ready)\n    {\n        if (ready) RunNow();\n    }\n\n    private void RunNow() { }\n}\n`,
  );

  const failed = runConventionChecks(root, discoverComponents(root));
  expect(failed.status).toBe("failed");
  expect(failed.diagnostics[0]?.message).toContain("if body must use braces");
});

test("accepts braced C# control flow, else-if, using declarations, and do-while", () => {
  const root = repository();
  writeFileSync(
    join(root, "Service.cs"),
    `public class Service\n{\n    public void Run(bool ready)\n    {\n        using var resource = Create();\n        if (ready) { RunNow(); }\n        else if (resource is not null) { RunNow(); }\n        else { Stop(); }\n        for (var index = 0; index < 1; index++) { RunNow(); }\n        foreach (var item in new[] { 1 }) { RunNow(); }\n        while (ready) { Stop(); }\n        do { Stop(); } while (ready);\n        using (Create()) { RunNow(); }\n        lock (this) { RunNow(); }\n    }\n\n    private object Create() { return new object(); }\n    private void RunNow() { }\n    private void Stop() { }\n}\n`,
  );

  expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");
});

test("skips generated and conditionally compiled C# source", () => {
  const root = repository();
  writeFileSync(
    join(root, "Generated.g.cs"),
    `public class Generated { public void Run(bool ready) { if (ready) RunNow(); } private void RunNow() { } }\n`,
  );
  writeFileSync(
    join(root, "Conditional.cs"),
    `#if DEBUG\npublic class Conditional { public void Run(bool ready) { if (ready) RunNow(); } private void RunNow() { } }\n#endif\n`,
  );

  expect(runConventionChecks(root, discoverComponents(root)).status).toBe("passed");
});

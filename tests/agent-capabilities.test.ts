import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAgentCapabilityCatalog,
  resolveAgentProfile,
  resolveFederatedProfile,
} from "../src/agent-capabilities.ts";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "coding-tooling-agent-capabilities-"));
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
}

const skill = (id: string, name: string, entryPoint = true) => `---
id: ${id}
name: ${name}
description: "${name} capability"
kind: skill
maturity: stable
entry-point: ${entryPoint}
intents:
  - review
requires: []
related-to: []
readiness: []
extensions: {}
---

# ${name}
`;

const reviewFlow = `---
id: general/code-review
name: code-review
description: "Review standards and spec independently."
kind: flow
maturity: stable
entry-point: true
intents:
  - review
requires: []
related-to: []
readiness: []
flow:
  steps:
    - id: axes
      kind: parallel
      steps:
        - id: standards
          kind: invoke
          capability: general/standards-review
        - id: spec
          kind: invoke
          capability: general/spec-review
extensions: {}
---

# Code review
`;

describe("agent capability catalog", () => {
  test("builds skills, executable flows, and inherited profiles", () => {
    const root = workspace();
    try {
      write(
        root,
        "skills/standards-review/SKILL.md",
        skill("general/standards-review", "standards-review"),
      );
      write(root, "skills/spec-review/SKILL.md", skill("general/spec-review", "spec-review"));
      write(root, "flows/code-review/FLOW.md", reviewFlow);
      write(
        root,
        "profiles/minimal.toml",
        'name = "minimal"\ncapabilities = [\n  "general/standards-review",\n  "general/spec-review",\n]\n',
      );
      write(
        root,
        "profiles/standard.toml",
        'name = "standard"\nextends = "minimal"\ncapabilities = ["general/code-review"]\n',
      );

      const catalog = buildAgentCapabilityCatalog(root, "test-revision");
      expect(catalog.namespace).toBe("general");
      expect(catalog.capabilities).toHaveLength(3);
      expect(resolveAgentProfile(catalog, "standard")).toEqual([
        "general/standards-review",
        "general/spec-review",
        "general/code-review",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("profiles cannot auto-enable internal capabilities", () => {
    const root = workspace();
    try {
      write(root, "skills/internal/SKILL.md", skill("general/internal", "internal", false));
      write(
        root,
        "profiles/minimal.toml",
        'name = "minimal"\ncapabilities = ["general/internal"]\n',
      );
      expect(() => buildAgentCapabilityCatalog(root, "test-revision")).toThrow(
        "cannot select internal capability",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects executable flow cycles", () => {
    const root = workspace();
    try {
      const flow = (id: string, name: string, target: string) => `---
id: ${id}
name: ${name}
description: "cycle fixture"
kind: flow
maturity: stable
entry-point: true
intents: []
requires: []
related-to: []
readiness: []
flow:
  steps:
    - id: next
      kind: invoke
      capability: ${target}
extensions: {}
---
`;
      write(root, "flows/a/FLOW.md", flow("general/a", "a", "general/b"));
      write(root, "flows/b/FLOW.md", flow("general/b", "b", "general/a"));
      expect(() => buildAgentCapabilityCatalog(root, "test-revision")).toThrow(
        "executable flow cycle",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unions matching profile additions across federated fragments", () => {
    const general = {
      schemaVersion: 1 as const,
      namespace: "general",
      revision: "a",
      capabilities: [
        {
          id: "general/tdd",
          name: "tdd",
          kind: "skill" as const,
          maturity: "stable" as const,
          entryPoint: true,
          intents: [],
          requires: [],
          relatedTo: [],
          readiness: [],
          extensions: {},
        },
      ],
      profiles: [{ name: "minimal", capabilities: ["general/tdd"] }],
    };
    const agentLoop = {
      schemaVersion: 1 as const,
      namespace: "agent-loop",
      revision: "b",
      capabilities: [
        {
          id: "agent-loop/implement-work-item",
          name: "implement-work-item",
          kind: "skill" as const,
          maturity: "stable" as const,
          entryPoint: true,
          intents: [],
          requires: ["general/tdd"],
          relatedTo: [],
          readiness: [],
          extensions: {},
        },
      ],
      profiles: [{ name: "minimal", capabilities: ["agent-loop/implement-work-item"] }],
    };

    expect(resolveFederatedProfile([general, agentLoop], "minimal")).toEqual([
      "general/tdd",
      "agent-loop/implement-work-item",
    ]);
  });
});

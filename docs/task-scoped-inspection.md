# Task-scoped inspection

Use the existing inspection command to find the declared context for explicit repository paths or components:

```sh
coding-tooling inspect --target src/components/patterns/workbench-layout.tsx --task-kind presentation --json
coding-tooling inspect --component @example/ui --json
coding-tooling inspect --task-context --json
```

`--target` and `--component` are repeatable. Targets are literal repository files or directories; wildcard target input, missing paths, escaping symlinks, ambiguous components and undeclared scope relationships are reported explicitly. An uncertain selection retains repository-wide commands and instructions instead of silently narrowing validation. Directory instruction discovery follows the existing generated/fixture exclusion boundary and reports when its depth bound of 16 is reached. Literal deep targets retain all ancestor instructions.

Root and applicable ancestor `AGENTS.md`/`CLAUDE.md` pointers always remain visible. Whole instruction files preserve authority and safety statements without interpreting arbitrary prose. Declared `alwaysInstructions` provide additional global links. Scoped instruction references are selected from existing repository-owned declarations, rather than inferred from filenames or document wording.

Add only relationships that the existing component/capability or generator catalogs cannot provide, under `.coding-tooling.json`:

```json
{
  "schemaVersion": 1,
  "taskKnowledge": {
    "schemaVersion": 1,
    "alwaysInstructions": ["README.md"],
    "completion": { "command": ["bun", "run", "verify:release"], "source": "package.json" },
    "scopes": [
      {
        "id": "workbench",
        "paths": ["src/components/patterns/**"],
        "taskKinds": ["presentation"],
        "instructions": ["CONTEXT.md"],
        "conventionRefs": ["UI-001"],
        "capabilities": ["test:unit", "storybook:check"],
        "examples": [
          {
            "path": "src/components/patterns/workbench-layout.stories.tsx",
            "entrypoint": "@moritzbrantner/ui/patterns"
          }
        ],
        "generators": ["ui-component"],
        "owners": ["moritzbrantner/ui"]
      }
    ],
    "exceptions": [{ "ruleId": "UI-001", "source": "AGENTS.md" }]
  }
}
```

The example illustrates declaration syntax; adopt only actual applicable links and exceptions. `paths` support declared Bun glob selectors and directory prefixes. Optional `components` add explicitly related components, such as a native WASM producer for a browser task. A task kind filters declarations that explicitly constrain kinds; it does not infer architectural meaning. Overlapping declarations retain their owners and checks. Related-owner declarations and exact source-dependency revisions remain visible; external validation is not inferred or asserted from file proximity.

Focused commands reuse discovered capabilities and `.coding-tooling.json` overrides without writing effective convention configurations. Missing focused capabilities are explicit. Completion is either an existing tier or a command with its declared repository source. Without an explicit completion declaration, the conservative full-tier pointer remains visible as an adoption gap. Lookup verifies pointers and declarations, not whether the commands, examples or public entrypoints behave correctly; every execution field remains `not-run`.

Convention references retain stable rule IDs and source revision/path provenance. Module references reuse the existing registry and dependency resolution. Principles, agent and security references remain global; explicit repository references and referenced generator rules join selected scope references. Unknown rules, missing source files and unavailable module/generator relationships cannot become verified evidence. Structured exceptions reference their source and rule; arbitrary prose is not interpreted as an exception.

Resolve a policy context once and reuse it across lookups or skills:

```sh
coding-tooling conventions resolve --root . --json > /tmp/resolved-policy.json
coding-tooling inspect --target src/components/patterns/workbench-layout.tsx --policy-context /tmp/resolved-policy.json --json
```

Reusable contexts must be convention-resolution envelopes for the same repository with `ruleSources` and source provenance. Resolution exposes the additive `ruleSources` map through the existing command. Cached lookup does not poll remote heads or require environment attestation; it preserves the captured source revision and checks local pointers. Module declarations are read from that source's local registry. A cached revision is provenance for the supplied context, not a fresh verification of the source checkout.

The additive inspection data uses `coding-tooling/task-context/v1`, with `resolved` or `partial` routing status. A partial result exits unavailable and includes diagnostics. Invalid metadata produces an error envelope with `taskContext: null`. The ordinary unscoped inspection contract remains available. Lookup is read-only: it does not install dependencies, execute examples, mutate source, create orchestration state, or replace repository-local instructions.

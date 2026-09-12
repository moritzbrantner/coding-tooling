from pathlib import Path
import re


enforcement_path = Path("src/convention-enforcement.ts")
enforcement = enforcement_path.read_text()
marker = "function executable(root: string, componentRoot: string, name: string): string | undefined {"
helper = '''export function conventionEnforcementExecutableRequirements(
  root: string,
  components: Component[],
): Map<"oxlint" | "oxlint-tsgolint", Set<string>> {
  const requirements = new Map<"oxlint" | "oxlint-tsgolint", Set<string>>();
  const add = (name: "oxlint" | "oxlint-tsgolint", ruleId: string) => {
    const rules = requirements.get(name) ?? new Set<string>();
    rules.add(ruleId);
    requirements.set(name, rules);
  };

  for (const item of loadEnforcements(root)) {
    const enforcement = item.enforcement;
    if (
      enforcement.kind !== "oxlint" ||
      !components.some((component) => appliesTo(component, enforcement.technologies))
    ) {
      continue;
    }
    add("oxlint", item.ruleId);
    const options = enforcement.config.options;
    if (isRecord(options) && options.typeAware === true) {
      add("oxlint-tsgolint", item.ruleId);
    }
  }

  return requirements;
}

'''
if helper.strip() in enforcement:
    raise SystemExit("helper already present")
if marker not in enforcement:
    raise SystemExit("executable marker not found")
enforcement_path.write_text(enforcement.replace(marker, helper + marker, 1))

foundation_path = Path("src/foundation-audit.ts")
foundation = foundation_path.read_text()
import_marker = 'import { conventionRegistryCommand } from "./convention-registry.ts";\n'
if import_marker not in foundation:
    raise SystemExit("foundation import marker not found")
foundation = foundation.replace(
    import_marker,
    'import { conventionEnforcementExecutableRequirements } from "./convention-enforcement.ts";\n'
    + import_marker,
    1,
)
foundation = foundation.replace(
    'type ConventionExecutableName = "oxlint" | "oxlint-tsgolint";',
    'type ConventionExecutableName = "oxfmt" | "oxlint" | "oxlint-tsgolint";',
    1,
)
foundation = foundation.replace(
    '): { activeRules: Set<string>; diagnostics: Diagnostic[] } {',
    '): { requirements: Map<ConventionExecutableName, Set<string>>; diagnostics: Diagnostic[] } {',
    1,
)
foundation = foundation.replace(
    "    return { activeRules: new Set(), diagnostics: [] };",
    "    return { requirements: new Map(), diagnostics: [] };",
    1,
)
foundation = foundation.replace(
    "      activeRules: new Set(),",
    "      requirements: new Map(),",
    1,
)
foundation = foundation.replace(
    "  const activeRules = new Set<string>();\n  const diagnostics: Diagnostic[] = [];",
    "  const requirements = new Map<ConventionExecutableName, Set<string>>();\n  const diagnostics: Diagnostic[] = [];",
    1,
)
foundation = foundation.replace(
    '      if (configuration.tool === "oxlint") activeRules.add(configuration.rule);',
    "      addConventionExecutableRequirement(requirements, configuration.tool, configuration.rule);",
    1,
)
foundation = foundation.replace(
    "  return { activeRules, diagnostics };",
    "  return { requirements, diagnostics };",
    1,
)
foundation, count = re.subn(
    r"function conventionExecutableRequirements\(.*?\n\}\n\n(?=function conventionPackageManifests)",
    "",
    foundation,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit("old executable requirements function not found")
old = """  const adapterEvidence = conventionAdapterEvidence(root, config);
  const requiredByRule = conventionExecutableRequirements(root, adapterEvidence.activeRules);
  const required = new Set(requiredByRule.keys());"""
new = """  const adapterEvidence = conventionAdapterEvidence(root, config);
  const requiredByRule = new Map<ConventionExecutableName, Set<string>>();
  for (const [name, rules] of conventionEnforcementExecutableRequirements(
    root,
    discoverComponents(root),
  )) {
    for (const rule of rules) addConventionExecutableRequirement(requiredByRule, name, rule);
  }
  for (const [name, rules] of adapterEvidence.requirements) {
    for (const rule of rules) addConventionExecutableRequirement(requiredByRule, name, rule);
  }
  const required = new Set(requiredByRule.keys());"""
if old not in foundation:
    raise SystemExit("audit merge marker not found")
foundation_path.write_text(foundation.replace(old, new, 1))

test_path = Path("tests/foundation-convention-tooling.test.ts")
test = test_path.read_text()
test = test.replace(
    "  configureLint = true,\n): string {",
    "  configureLint = true,\n  includeTs005Configuration = true,\n): string {",
    1,
)
test = test.replace(
    "  installTypeScriptConventions(root);",
    "  installTypeScriptConventions(root, includeTs005Configuration);",
    1,
)
test = test.replace(
    "function installTypeScriptConventions(root: string): void {",
    "function installTypeScriptConventions(root: string, includeTs005Configuration: boolean): void {",
    1,
)
old_configs = '''        {
          rule: "TS-003",
          path: "modules/typescript/technologies/typescript/TS-003.oxlint.json",
          tool: "oxlint",
          capability: "lint",
          module: "typescript",
        },
        {
          rule: "TS-005",
          path: "modules/typescript/technologies/typescript/TS-005.oxlint.json",
          tool: "oxlint",
          capability: "lint",
          module: "typescript",
        },'''
new_configs = '''        {
          rule: "TS-003",
          path: "modules/typescript/technologies/typescript/TS-003.oxlint.json",
          tool: "oxlint",
          capability: "lint",
          module: "typescript",
        },
        ...(includeTs005Configuration
          ? [
              {
                rule: "TS-005",
                path: "modules/typescript/technologies/typescript/TS-005.oxlint.json",
                tool: "oxlint",
                capability: "lint",
                module: "typescript",
              },
            ]
          : []),'''
if old_configs not in test:
    raise SystemExit("configuration fixture marker not found")
test = test.replace(old_configs, new_configs, 1)
test = test.replace(
    '    "modules/typescript/technologies/typescript/TS-005.oxlint.json": ts005Config,',
    '    ...(includeTs005Configuration\n      ? { "modules/typescript/technologies/typescript/TS-005.oxlint.json": ts005Config }\n      : {}),',
    1,
)
test = test.replace(
    '''    expect(tooling.requiredExecutables).toEqual([]);
    expect(
      result.diagnostics.filter((item) => item.code === "foundation-convention-adapter-unresolved"),''',
    '''    expect(tooling.requiredExecutables.map((item) => [item.name, item.status])).toEqual([
      ["oxlint", "adopted"],
      ["oxlint-tsgolint", "adopted"],
    ]);
    expect(
      result.diagnostics.filter((item) => item.code === "foundation-convention-adapter-unresolved"),''',
    1,
)
test = test.replace(
    '''    expect(tooling.requiredExecutables).toEqual([]);
    expect(
      result.diagnostics.filter((item) => item.code === "foundation-convention-adapter-unresolved"),''',
    '''    expect(tooling.requiredExecutables.map((item) => [item.name, item.status])).toEqual([
      ["oxlint", "missing"],
      ["oxlint-tsgolint", "missing"],
    ]);
    expect(
      result.diagnostics.filter((item) => item.code === "foundation-convention-adapter-unresolved"),''',
    1,
)
insertion = '''

  test("requires type-aware tooling for enforcement-only installed rules", () => {
    const result = foundationAudit(
      repository(
        {
          oxlint: "1.81.0",
        },
        "bunx oxlint@1.81.0 .",
        true,
        false,
      ),
    );
    const tooling = executableTooling(result);

    expect(result.status).toBe("failed");
    expect(tooling.status).toBe("missing");
    expect(tooling.requiredExecutables).toEqual([
      {
        name: "oxlint",
        status: "adopted",
        rules: ["TS-003", "TS-005"],
        declarations: [
          {
            path: "package.json",
            section: "devDependencies",
            version: "1.81.0",
          },
        ],
      },
      {
        name: "oxlint-tsgolint",
        status: "missing",
        rules: ["TS-005"],
        declarations: [],
      },
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "foundation-convention-tool-missing" }),
    );
  });
'''
ending = "\n});\n"
if not test.endswith(ending):
    raise SystemExit("unexpected test ending")
test_path.write_text(test[: -len(ending)] + insertion + ending)

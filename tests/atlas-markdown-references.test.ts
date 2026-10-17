import { expect, test } from "bun:test";

import { buildAtlasIndex } from "../src/decision-atlas.ts";

// A numbered Atlas whose Decision 1.1 owns one checkbox-shaped child line. Whether
// `[z]` is a real task-list marker (malformed: fails closed) or a Markdown
// shortcut reference (prose) depends on actual CommonMark reference definitions.
const atlas = (child: string, tail: string) =>
  "# Decision Atlas\n\n## Entries\n\n- **1** Topic\n  - **1.1** Area\n    - **1.1.1** [decision] Valid owner decision.\n      " +
  child +
  "\n\nReference syntax examples:\n\n" +
  tail +
  "\n";

function index(text: string) {
  return buildAtlasIndex("moritzbrantner/example", "a".repeat(40), [
    { path: "docs/decisions/atlas.md", format: "numbered-list", text },
  ]);
}

for (const [name, definition] of [
  ["destination", "[z]: #target"],
  ["quoted title", '[z]: #target "Navigation title"'],
  ["next-line destination", "[z]:\n  #target"],
  ["blockquote definition", "> [z]: #target"],
  ["list-contained definition", "- [z]: #target"],
  ["case-normalized label", "[Z]: #target"],
  ["unrendered URL scheme", "[z]: javascript:example"],
]) {
  test("actual reference metadata preserves navigation: " + name, () => {
    const built = index(atlas("- [z] Navigation.", definition));
    expect(built.decisions.map((entry) => entry.id)).toEqual(["1.1.1"]);
    expect(built.decisions[0]!.evidence).toEqual([]);
  });
}

for (const [name, definition] of [
  ["trailing text after title", '[z]: #target "title" extra'],
  ["unterminated angle destination", "[z]: <target"],
  ["missing destination", "[z]:"],
  ["unterminated title", '[z]: #target "unfinished'],
  ["paragraph continuation", "This remains a paragraph.\n[z]: #target"],
]) {
  test("invalid whole definition cannot conceal an owner marker: " + name, () => {
    expect(() => index(atlas("- [z] Malformed evidence.", definition))).toThrow();
  });
}

for (const [name, literal] of [
  ["indented code", "    [z]: #target"],
  ["processing instruction", "<?example\n[z]: #target\n?>"],
  ["HTML declaration", "<!DOCTYPE\n[z]: #target\n>"],
  ["CDATA", "<![CDATA[\n[z]: #target\n]]>"],
  ["raw style", "<style>\n[z]: #target\n</style>"],
  ["raw textarea", "<textarea>\n[z]: #target\n</textarea>"],
  ["custom HTML block", "<custom-widget>\n[z]: #target\n</custom-widget>"],
  ["blockquote fence", "> ```\n> [z]: #target\n> ```"],
  ["list-contained fence", "- ```\n  [z]: #target\n  ```"],
  ["mismatched closer", "```\n~~~\n[z]: #target\n```"],
  ["unclosed fence", "~~~\n[z]: #target"],
]) {
  test("inert Markdown region cannot supply checkbox references: " + name, () => {
    expect(() => index(atlas("- [z] Malformed evidence.", literal))).toThrow();
  });
}

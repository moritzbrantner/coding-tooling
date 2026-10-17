import { expect, test } from "bun:test";

import { rustDeclarations } from "../src/rust-items.ts";
import { matchTypeScriptSymbol, typeScriptSymbols } from "../src/typescript-declarations.ts";

function rust(source: string): Map<string, { line: number; test: boolean }[]> {
  const result = rustDeclarations(source);
  if (!result.ok) throw new Error(result.reason);
  const map = new Map<string, { line: number; test: boolean }[]>();
  for (const declaration of result.declarations) {
    const key = declaration.path.join("::");
    map.set(key, [...(map.get(key) ?? []), { line: declaration.line, test: declaration.test }]);
  }
  return map;
}

test("Rust items ignore comments, strings, raw strings, char literals and lifetimes", () => {
  const items = rust(`/* outer /* nested fn ghost_a() {} */ still comment fn ghost_b() {} */
const RAW: &str = r##"fn ghost_c() { "# } "##;
const BRACE: char = '{';
const ESCAPED: char = '\\u{1F600}';
const QUOTE: char = '\\'';
pub struct Holder<'a> { pub text: &'a str }
impl<'a, 'b: 'a> Holder<'a> {
    pub fn get(&'b self) -> &'a str { 'outer: loop { break 'outer; } self.text }
}
pub fn after() {}
`);
  expect([...items.keys()].sort()).toEqual(
    ["BRACE", "ESCAPED", "Holder", "Holder::get", "QUOTE", "RAW", "after"].sort(),
  );
  expect(items.get("after")).toEqual([{ line: 10, test: false }]);
});

test("Rust trait impls, generic impls, traits, extern blocks and macros are addressable", () => {
  const items = rust(`use std::fmt;
pub trait Render { fn render(&self) -> String; const ID: u8; type Out; }
impl<T: Clone + fmt::Debug> fmt::Display for Wrapper<T> where T: Send {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { Ok(()) }
}
unsafe impl Send for crate::engine::Engine {}
impl Engine { pub(crate) const async unsafe fn boot() {} pub const LIMIT: u32 = 3; }
extern "C" { fn ffi_call(); static mut COUNTER: u32; }
macro_rules! farm { () => {}; }
lazy_static! { static ref HIDDEN: u8 = 1; }
mod out_of_line;
pub enum Shape { #[default] Dot, Line(u8, Vec<u8>), Box { w: u8, h: (u8, u8) } = 3 }
`);
  for (const path of [
    "Render",
    "Render::render",
    "Render::ID",
    "Render::Out",
    "Wrapper::fmt",
    "Engine::boot",
    "Engine::LIMIT",
    "ffi_call",
    "COUNTER",
    "farm",
    "out_of_line",
    "Shape::Dot",
    "Shape::Line",
    "Shape::Box",
  ])
    expect({ path, found: items.has(path) }).toEqual({ path, found: true });
  for (const path of ["fmt", "std", "HIDDEN", "w", "h", "Shape::w"])
    expect({ path, found: items.has(path) }).toEqual({ path, found: false });
});

test("Rust test attributes include path-qualified test macros but not cfg(test)", () => {
  const items = rust(`#[cfg(test)]
mod tests {
    #[test] fn plain() {}
    #[tokio::test(flavor = "multi_thread")] async fn tokio_case() {}
    #[test_case(1)] fn parameterised(_: u8) {}
    #[cfg(test)] fn helper() {}
}
`);
  expect(items.get("tests::plain")?.[0]?.test).toBe(true);
  expect(items.get("tests::tokio_case")?.[0]?.test).toBe(true);
  expect(items.get("tests::parameterised")?.[0]?.test).toBe(false);
  expect(items.get("tests::helper")?.[0]?.test).toBe(false);
});

test("Rust sources with unbalanced delimiters fail closed instead of guessing", () => {
  const result = rustDeclarations("pub fn broken() {\n  let x = (1, 2;\n}\n");
  expect(result.ok).toBe(false);
});

test("TypeScript overloads and accessor pairs merge; distinct duplicates stay ambiguous", () => {
  const symbols = typeScriptSymbols(
    "src/x.ts",
    `export function parse(a: string): number;
export function parse(a: number): number;
export function parse(a: unknown): number { return 0; }
export class Box {
  get size(): number { return 1; }
  set size(_: number) {}
  static size2 = 2;
}
export namespace Outer.Inner { export function deep(): void {} }
export enum Color { Red, Green }
let twice = 1;
var twice = 2;
describe.only("Box", () => { describe("size", () => { test.skip("reads", () => {}); }); });
test.each([1])("templated %d", () => {});
`,
  );
  expect(matchTypeScriptSymbol(symbols.declarations, "parse").map((s) => s.line)).toEqual([1]);
  expect(matchTypeScriptSymbol(symbols.declarations, "Box.size").length).toBe(1);
  expect(matchTypeScriptSymbol(symbols.declarations, "Outer.Inner.deep").length).toBe(1);
  expect(matchTypeScriptSymbol(symbols.declarations, "Color.Green").length).toBe(1);
  expect(matchTypeScriptSymbol(symbols.declarations, "twice").length).toBe(2);
  expect(symbols.tests.map((t) => t.name)).toEqual(["Box > size > reads"]);
});

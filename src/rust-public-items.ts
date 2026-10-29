import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { rustDeclarations } from "./rust-items.ts";
import { relativePosix, walkFiles } from "./shared.ts";

/** Where a public Rust item path (`crate::module::Type::method`) is declared. */
export type RustPublicItem = { path: string; line: number };

type ModuleFile = { file: string; module: string[]; public: boolean };
type CrateIndex = { modules: ModuleFile[]; declarations: Map<string, RustPublicItem[]> };

const moduleDeclaration = /^\s*(pub(?:\s*\([^)]*\))?\s+)?mod\s+(?:r#)?([A-Za-z_]\w*)\s*;/u;

function cargoPackageName(content: string): string | undefined {
  const section = content.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
  return section.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
}

/** `mod x;` children of a module file: `x.rs` or `x/mod.rs` beside a root, else under its stem. */
function childModuleFile(parent: string, name: string): string | undefined {
  const stem = basename(parent, ".rs");
  const base = ["lib", "main", "mod"].includes(stem)
    ? dirname(parent)
    : join(dirname(parent), stem);
  return [join(base, `${name}.rs`), join(base, name, "mod.rs")].find((path) => existsSync(path));
}

function read(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** True when the declaration line carries a plain `pub` (not `pub(crate)` etc.) before `name`. */
function isPublic(source: string, line: number, name: string): boolean {
  const text = source.split(/\r?\n/)[line - 1] ?? "";
  const at = text.search(new RegExp(`\\b${name}\\b`, "u"));
  return /(?:^|[\s>])pub\s/u.test(at < 0 ? text : text.slice(0, at));
}

function indexCrate(root: string, lib: string): CrateIndex {
  const modules: ModuleFile[] = [];
  const declarations = new Map<string, RustPublicItem[]>();
  const pending: ModuleFile[] = [{ file: lib, module: [], public: true }];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (seen.has(current.file)) continue;
    seen.add(current.file);
    modules.push(current);
    const source = read(current.file);
    if (source === undefined) continue;
    for (const line of source.split(/\r?\n/)) {
      const match = moduleDeclaration.exec(line);
      if (!match) continue;
      const child = childModuleFile(current.file, match[2]!);
      if (!child) continue;
      pending.push({
        file: child,
        module: [...current.module, match[2]!],
        public: current.public && match[1]?.trim() === "pub",
      });
    }
    const parsed = rustDeclarations(source);
    if (!parsed.ok) continue;
    const path = relativePosix(root, current.file);
    for (const declaration of parsed.declarations) {
      const leaf = declaration.path.at(-1)!;
      if (!isPublic(source, declaration.line, leaf)) continue;
      const key = [...current.module, ...declaration.path].join("::");
      declarations.set(key, [...(declarations.get(key) ?? []), { path, line: declaration.line }]);
      // Associated items are reachable through their type wherever the `impl` block lives.
      if (declaration.path.length >= 2) {
        const member = `*::${declaration.path.slice(-2).join("::")}`;
        declarations.set(member, [
          ...(declarations.get(member) ?? []),
          { path, line: declaration.line },
        ]);
      }
    }
  }
  return { modules, declarations };
}

/**
 * Resolves `crate::module::Item` or `crate::module::Type::member` to its `pub` declaration by
 * following `mod x;` declarations from `src/lib.rs` (both `x.rs` and `x/mod.rs` layouts). Associated
 * items are found in `impl Type` blocks in any module of the crate. `use` re-exports, `#[path]`
 * attributes and macro-generated items are not followed.
 */
export function rustPublicItemResolver(root: string): (itemPath: string) => RustPublicItem | null {
  const crates = new Map<string, string>();
  for (const manifest of walkFiles(root, 4).filter((file) => basename(file) === "Cargo.toml")) {
    const name = cargoPackageName(read(manifest) ?? "");
    const lib = join(dirname(manifest), "src", "lib.rs");
    if (name && existsSync(lib)) crates.set(name.replaceAll("-", "_"), lib);
  }
  const indexes = new Map<string, CrateIndex>();
  return (itemPath) => {
    const [crate, ...segments] = itemPath.split("::");
    const lib = crate === undefined ? undefined : crates.get(crate);
    if (!lib || segments.length === 0) return null;
    let index = indexes.get(lib);
    if (!index) {
      index = indexCrate(root, lib);
      indexes.set(lib, index);
    }
    const publicModules = new Set(
      index.modules.filter((module) => module.public).map((module) => module.module.join("::")),
    );
    // Longest public module prefix; the remainder is an item (and optionally a member) inside it.
    for (let split = segments.length - 1; split >= 0; split -= 1) {
      const module = segments.slice(0, split).join("::");
      if (!publicModules.has(module)) continue;
      const item = segments.slice(split);
      const owner = [...segments.slice(0, split), item[0]!].join("::");
      const ownerDeclaration = index.declarations.get(owner)?.[0];
      if (!ownerDeclaration) continue;
      if (item.length === 1) return ownerDeclaration;
      if (item.length !== 2) continue;
      const direct = index.declarations.get(segments.join("::"))?.[0];
      if (direct) return direct;
      const member = index.declarations.get(`*::${item.join("::")}`)?.[0];
      if (member) return member;
    }
    return null;
  };
}

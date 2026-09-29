import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { walkFiles } from "../src/shared.ts";

const root = join(import.meta.dir, "..");
const site = join(root, "site");
const outdir = join(root, ".artifacts", "pages");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync(site, outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: walkFiles(site, 5)
    .filter((path) => path.endsWith(".js"))
    .toSorted(),
  root: site,
  outdir,
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "Pages browser bundle failed");

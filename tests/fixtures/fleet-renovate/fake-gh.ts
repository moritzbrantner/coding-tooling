// `gh` stand-in for the fleet renovate CLI tests. A shell wrapper named `gh` on PATH runs
// `bun fake-gh.ts "$@"`. FLEET_RENOVATE_MOCK_STATE names a JSON MockState file and
// FLEET_RENOVATE_MOCK_LOG a file that receives one JSON argv line per call.
import { appendFileSync, readFileSync } from "node:fs";

import { handleGh, type MockState } from "./mock-github.ts";

const args = process.argv.slice(2);
const log = process.env.FLEET_RENOVATE_MOCK_LOG;
if (log) appendFileSync(log, `${JSON.stringify(["gh", ...args])}\n`);
const state = JSON.parse(
  readFileSync(process.env.FLEET_RENOVATE_MOCK_STATE ?? "", "utf8"),
) as MockState;
const result = handleGh(state, args);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status);

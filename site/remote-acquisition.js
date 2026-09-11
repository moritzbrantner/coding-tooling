import { selectedRemoteFiles } from "./preflight.js";

export const DEFAULT_REMOTE_MANIFEST_BYTE_BUDGET = 512 * 1024;
export const DEFAULT_REMOTE_FETCH_CONCURRENCY = 6;

export function selectRemoteFilesByByteBudget(
  tree,
  byteBudget = DEFAULT_REMOTE_MANIFEST_BYTE_BUDGET,
) {
  if (!Number.isSafeInteger(byteBudget) || byteBudget < 0) {
    throw new Error("remote manifest byte budget must be a non-negative safe integer");
  }

  const eligible = selectedRemoteFiles(tree, tree.length);
  const unknownSize = eligible.find(
    (entry) => !Number.isSafeInteger(entry.size) || entry.size < 0,
  );
  if (unknownSize) {
    return {
      selected: selectedRemoteFiles(tree),
      eligible,
      complete: false,
      reason: "blob-size-unavailable",
      byteBudget,
      selectedBytes: null,
      blockedPath: unknownSize.path,
    };
  }

  const selected = [];
  let selectedBytes = 0;
  for (const entry of eligible) {
    if (selectedBytes + entry.size > byteBudget) {
      return {
        selected,
        eligible,
        complete: false,
        reason: "byte-budget-exceeded",
        byteBudget,
        selectedBytes,
        blockedPath: entry.path,
      };
    }
    selected.push(entry);
    selectedBytes += entry.size;
  }

  return {
    selected,
    eligible,
    complete: true,
    reason: "within-byte-budget",
    byteBudget,
    selectedBytes,
    blockedPath: null,
  };
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("remote fetch concurrency must be a positive safe integer");
  }
  if (items.length === 0) return [];

  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

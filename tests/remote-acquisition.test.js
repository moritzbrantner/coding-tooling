import { describe, expect, test } from "bun:test";

import {
  DEFAULT_REMOTE_MANIFEST_BYTE_BUDGET,
  mapWithConcurrency,
  selectRemoteFilesByByteBudget,
} from "../site/remote-acquisition.js";

function blob(path, size) {
  return { path, sha: path, type: "blob", size };
}

describe("bounded remote manifest acquisition", () => {
  test("keeps more than 24 small manifests complete within the byte budget", () => {
    const tree = Array.from({ length: 30 }, (_, index) =>
      blob(`packages/package-${String(index).padStart(2, "0")}/package.json`, 1024),
    );

    const result = selectRemoteFilesByByteBudget(tree);

    expect(result.complete).toBe(true);
    expect(result.reason).toBe("within-byte-budget");
    expect(result.selected).toHaveLength(30);
    expect(result.selectedBytes).toBe(30 * 1024);
    expect(result.byteBudget).toBe(DEFAULT_REMOTE_MANIFEST_BYTE_BUDGET);
  });

  test("stops deterministically before the first manifest that exceeds the byte budget", () => {
    const tree = Array.from({ length: 20 }, (_, index) =>
      blob(`packages/package-${String(index).padStart(2, "0")}/package.json`, 40 * 1024),
    );

    const result = selectRemoteFilesByByteBudget(tree);

    expect(result.complete).toBe(false);
    expect(result.reason).toBe("byte-budget-exceeded");
    expect(result.selected).toHaveLength(12);
    expect(result.selectedBytes).toBe(12 * 40 * 1024);
    expect(result.blockedPath).toBe("packages/package-12/package.json");
  });

  test("fails closed when an eligible blob has no trustworthy size", () => {
    const tree = [
      blob("package.json", 1024),
      { path: "packages/app/package.json", sha: "app", type: "blob" },
    ];

    const result = selectRemoteFilesByByteBudget(tree);

    expect(result.complete).toBe(false);
    expect(result.reason).toBe("blob-size-unavailable");
    expect(result.selectedBytes).toBeNull();
    expect(result.blockedPath).toBe("packages/app/package.json");
  });

  test("bounded concurrency preserves input order and never exceeds the configured width", async () => {
    let active = 0;
    let maximumActive = 0;
    const release = [];
    const items = [0, 1, 2, 3, 4, 5];

    const resultPromise = mapWithConcurrency(items, 3, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => release.push(resolve));
      active -= 1;
      return value * 2;
    });

    while (release.length < 3) await Promise.resolve();
    expect(maximumActive).toBe(3);
    release.splice(0, 3).forEach((resolve) => resolve());

    while (release.length < 3) await Promise.resolve();
    expect(maximumActive).toBe(3);
    release.splice(0, 3).forEach((resolve) => resolve());

    await expect(resultPromise).resolves.toEqual([0, 2, 4, 6, 8, 10]);
  });
});

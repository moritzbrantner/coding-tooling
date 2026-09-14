import { describe, expect, test } from "bun:test";

import {
  ANALYSIS_MESSAGE_TYPE,
  analysisErrorMessage,
  analysisMessage,
} from "../site/analysis-message.js";

describe("Pages analysis message contract", () => {
  test("binds successful analysis to the requested repository", () => {
    const analysis = {
      schemaVersion: 1,
      repository: { fullName: "example/project", revision: "0123456789abcdef" },
    };

    expect(analysisMessage("example/project", analysis)).toEqual({
      type: ANALYSIS_MESSAGE_TYPE,
      repository: "example/project",
      analysis,
    });
  });

  test("preserves fail-closed errors without inventing analysis", () => {
    expect(analysisErrorMessage("example/project", "unavailable")).toEqual({
      type: ANALYSIS_MESSAGE_TYPE,
      repository: "example/project",
      error: { message: "unavailable" },
    });
  });
});

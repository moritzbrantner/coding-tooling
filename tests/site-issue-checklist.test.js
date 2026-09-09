import { describe, expect, test } from "bun:test";

import {
  issueChecklistEvidence,
  issueChecklistNextStep,
} from "../site/issue-checklist.js";
import { analyzeOpenWork } from "../site/next-work.js";

const now = new Date("2026-09-09T06:00:00.000Z");

describe("GitHub Pages issue checklist evidence", () => {
  test("finds the first unchecked Markdown task without interpreting its text", () => {
    const checklist = issueChecklistEvidence(`
## Work
- [x] Land evidence seam
- [ ] Migrate Rust/.NET evidence where mechanically equivalent facts exist
- [ ] Calibrate advisory findings
`);

    expect(checklist).toEqual({
      status: "present",
      total: 3,
      completed: 1,
      remaining: 2,
      firstUnchecked: {
        index: 1,
        text: "Migrate Rust/.NET evidence where mechanically equivalent facts exist",
      },
    });
    expect(issueChecklistNextStep(checklist)).toEqual({
      kind: "checklist-item",
      text: "Migrate Rust/.NET evidence where mechanically equivalent facts exist",
    });
  });

  test("ignores task-list-looking text inside fenced code blocks", () => {
    const checklist = issueChecklistEvidence(`
- [x] Real task
\`\`\`md
- [ ] Example only
\`\`\`
~~~text
- [ ] Another example
~~~
`);

    expect(checklist).toEqual({
      status: "present",
      total: 1,
      completed: 1,
      remaining: 0,
      firstUnchecked: null,
    });
    expect(issueChecklistNextStep(checklist)).toEqual({
      kind: "reconcile-completed-checklist",
    });
  });

  test("keeps issues without task lists explicit but unchanged in meaning", () => {
    const checklist = issueChecklistEvidence("Implement a deterministic parser.");

    expect(checklist).toEqual({
      status: "absent",
      total: 0,
      completed: 0,
      remaining: 0,
      firstUnchecked: null,
    });
    expect(issueChecklistNextStep(checklist)).toEqual({ kind: "issue" });
  });

  test("surfaces checklist progress on issue candidates without affecting ranking", () => {
    const result = analyzeOpenWork(
      "example/repo",
      [],
      [
        issue({
          number: 83,
          body: "- [x] Completed slice\n- [ ] Next deterministic slice",
        }),
      ],
      now,
    );

    expect(result.summary.suggestedWork).toEqual(
      expect.objectContaining({
        kind: "issue",
        number: 83,
        checklist: {
          status: "present",
          total: 2,
          completed: 1,
          remaining: 1,
          firstUnchecked: { index: 1, text: "Next deterministic slice" },
        },
        nextStep: { kind: "checklist-item", text: "Next deterministic slice" },
      }),
    );
    expect(result.summary.suggestedWork.signals).toContain("open-checklist-items");
    expect(result.ranking.checklistProgress).toBe("observed-not-ranked");
    expect(result.ranking.checklistAffectsRanking).toBe(false);
  });

  test("flags a completed checklist on an open issue for reconciliation", () => {
    const result = analyzeOpenWork(
      "example/repo",
      [],
      [issue({ number: 85, body: "- [x] One\n- [X] Two" })],
      now,
    );

    expect(result.summary.suggestedWork.nextStep).toEqual({
      kind: "reconcile-completed-checklist",
    });
    expect(result.summary.suggestedWork.signals).toContain("completed-checklist-open-issue");
  });
});

function issue(overrides = {}) {
  const number = overrides.number ?? 1;
  return {
    number,
    title: "Issue",
    body: null,
    html_url: `https://github.com/example/repo/issues/${number}`,
    updated_at: "2026-09-09T05:00:00.000Z",
    user: { login: "example", type: "User" },
    ...overrides,
  };
}

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  formatPlanForExecution,
  PLAN_STATE_ENTRY,
  restorePlanState,
  validatePlanSteps,
  type PlanState,
} from "../src/plan.js";

describe("structured plan state", () => {
  const plan: PlanState = {
    explanation: "Ship safely",
    steps: [
      { step: "Inspect the repository", status: "completed" },
      { step: "Implement the change", status: "in_progress" },
      { step: "Run validation", status: "pending" },
    ],
    revision: 2,
    updatedAt: "2026-07-31T00:00:00.000Z",
  };

  it("restores the latest plan and respects a persisted clear marker", () => {
    const entry = { type: "custom", customType: PLAN_STATE_ENTRY, data: plan } as SessionEntry;
    expect(restorePlanState([entry])).toEqual(plan);
    const cleared = {
      type: "custom",
      customType: PLAN_STATE_ENTRY,
      data: { cleared: true },
    } as SessionEntry;
    expect(restorePlanState([entry, cleared])).toBeUndefined();
  });

  it("formats status-aware execution context", () => {
    expect(formatPlanForExecution(plan)).toBe(
      [
        "1. [completed] Inspect the repository",
        "2. [in_progress] Implement the change",
        "3. [pending] Run validation",
      ].join("\n"),
    );
  });

  it("rejects ambiguous progress and blank steps", () => {
    expect(
      validatePlanSteps([
        { step: "First", status: "in_progress" },
        { step: "Second", status: "in_progress" },
      ]),
    ).toContain("at most one");
    expect(validatePlanSteps([{ step: "  ", status: "pending" }])).toContain("blank");
  });
});

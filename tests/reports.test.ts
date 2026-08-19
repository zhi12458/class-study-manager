import { describe, expect, it } from "vitest";

import type { AttendanceFact } from "../src/shared/types.js";
import {
  buildReportSummary,
  calculateMetricRate,
  detectClassStudyRisk,
} from "../src/server/services/reports.js";

function fact(overrides: Partial<AttendanceFact> = {}): AttendanceFact {
  return {
    enrollmentId: 1,
    studentName: "甲",
    groupId: 1,
    groupName: "第一组",
    lessonId: 1,
    lessonSequence: 1,
    metric: "outline",
    dueDate: "2026-05-01",
    status: "yes",
    ...overrides,
  };
}

describe("calculateMetricRate", () => {
  it("counts all three metrics with their independent completion rules", () => {
    expect(calculateMetricRate("outline", ["yes", "no", null, "not_required"])).toEqual({
      metric: "outline",
      completed: 1,
      recorded: 2,
      pending: 1,
      notRequired: 1,
      rate: 50,
    });
    expect(calculateMetricRate("group_study", ["onsite", "online", "official_duty", "absent", "observer", undefined])).toEqual({
      metric: "group_study",
      completed: 2,
      recorded: 5,
      pending: 1,
      notRequired: 0,
      rate: 40,
    });
    expect(
      calculateMetricRate("class_study", ["onsite", "online", "official_duty", "observer", "absent"]),
    ).toEqual({
      metric: "class_study",
      completed: 2,
      recorded: 5,
      pending: 0,
      notRequired: 0,
      rate: 40,
    });
  });

  it("returns not-applicable when no applicable value was recorded", () => {
    expect(calculateMetricRate("outline", [null, "not_required"])).toMatchObject({
      completed: 0,
      recorded: 0,
      pending: 1,
      notRequired: 1,
      rate: null,
    });
  });

  it("rejects a status from a different metric", () => {
    expect(() => calculateMetricRate("outline", ["onsite"])).toThrow("不适用于指标 outline");
  });
});

describe("buildReportSummary", () => {
  it("uses raw applicable person-lessons for class, group and personal rates", () => {
    const facts: AttendanceFact[] = [
      fact({ enrollmentId: 1, studentName: "甲", groupId: 1, groupName: "第一组", status: "yes" }),
      fact({
        enrollmentId: 1,
        studentName: "甲",
        groupId: 1,
        groupName: "第一组",
        lessonId: 2,
        lessonSequence: 2,
        status: "not_required",
      }),
      fact({ enrollmentId: 2, studentName: "乙", groupId: 2, groupName: "第二组", status: "yes" }),
      fact({
        enrollmentId: 2,
        studentName: "乙",
        groupId: 2,
        groupName: "第二组",
        lessonId: 2,
        lessonSequence: 2,
        status: "no",
      }),
      fact({
        enrollmentId: 2,
        studentName: "乙",
        groupId: 2,
        groupName: "第二组",
        lessonId: 3,
        lessonSequence: 3,
        status: "no",
      }),
      fact({
        enrollmentId: 2,
        studentName: "乙",
        groupId: 2,
        groupName: "第二组",
        lessonId: 4,
        lessonSequence: 4,
        status: null,
      }),
    ];

    const result = buildReportSummary(facts);

    expect(result.classSummary.outline).toMatchObject({
      completed: 2,
      recorded: 4,
      pending: 1,
      notRequired: 1,
      rate: 50,
    });
    expect(result.groupSummaries.map((group) => group.metrics.outline.rate)).toEqual([100, 33.33]);
    expect(result.personalStats.map((person) => person.metrics.outline.rate)).toEqual([100, 33.33]);
    expect(result.classSummary.group_study.rate).toBeNull();
    expect(result.classSummary.class_study.rate).toBeNull();
  });

  it("uses the fact's historical group for group totals and latest group for a personal label", () => {
    const result = buildReportSummary([
      fact({ groupId: 1, groupName: "第一组", lessonSequence: 1 }),
      fact({ groupId: 2, groupName: "第二组", lessonId: 2, lessonSequence: 2, status: "no" }),
    ]);

    expect(result.groupSummaries).toHaveLength(2);
    expect(result.personalStats).toHaveLength(1);
    expect(result.personalStats[0]).toMatchObject({ groupId: 2, groupName: "第二组" });
  });
});

describe("detectClassStudyRisk", () => {
  it("detects the latest three recorded invalid results and ignores blanks or future lessons", () => {
    const result = detectClassStudyRisk(
      [
        { dueDate: "2026-04-01", status: "onsite", lessonSequence: 1 },
        { dueDate: "2026-04-08", status: "observer", lessonSequence: 2 },
        { dueDate: "2026-04-15", status: "absent", lessonSequence: 3 },
        { dueDate: "2026-04-22", status: null, lessonSequence: 4 },
        { dueDate: "2026-04-29", status: "observer", lessonSequence: 5 },
        { dueDate: "2026-05-06", status: "absent", lessonSequence: 6 },
      ],
      "2026-04-30",
    );

    expect(result).toMatchObject({
      needsAttention: true,
      consecutiveTrigger: true,
      rollingThreeMonthTrigger: false,
      consecutiveInvalidCount: 3,
      invalidInThreeMonths: 3,
    });
    expect(result.reasons).toEqual(["最近连续 3 次班修为旁听或旷课"]);
  });

  it("detects five invalid results in the rolling three calendar months", () => {
    const result = detectClassStudyRisk(
      [
        { dueDate: "2026-05-25", status: "onsite" },
        { dueDate: "2026-05-18", status: "observer" },
        { dueDate: "2026-04-20", status: "absent" },
        { dueDate: "2026-03-15", status: "observer" },
        { dueDate: "2026-03-01", status: "absent" },
        { dueDate: "2026-02-28", status: "observer" },
        { dueDate: "2026-02-27", status: "absent" },
      ],
      "2026-05-31",
    );

    expect(result).toMatchObject({
      needsAttention: true,
      consecutiveTrigger: false,
      rollingThreeMonthTrigger: true,
      consecutiveInvalidCount: 0,
      invalidInThreeMonths: 5,
    });
    expect(result.reasons).toEqual(["最近 3 个月有 5 次或以上班修为旁听或旷课"]);
  });

  it("does not treat official duty as attention and lets it break a consecutive warning", () => {
    const result = detectClassStudyRisk(
      [
        { dueDate: "2026-04-01", status: "observer" },
        { dueDate: "2026-04-08", status: "official_duty" },
        { dueDate: "2026-04-15", status: "absent" },
        { dueDate: "2026-04-22", status: "observer" },
      ],
      "2026-04-30",
    );

    expect(result).toMatchObject({
      needsAttention: false,
      consecutiveTrigger: false,
      rollingThreeMonthTrigger: false,
      consecutiveInvalidCount: 2,
      invalidInThreeMonths: 3,
    });
  });
});

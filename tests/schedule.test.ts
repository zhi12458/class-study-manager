import { describe, expect, it } from "vitest";

import {
  generateSchedule,
  insertBreak,
  isMonitorLocked,
  monitorLockDate,
  removeBreak,
  shiftScheduleFrom,
} from "../src/server/services/schedule.js";

describe("generateSchedule", () => {
  it("defaults to 24 same-week lessons, seven days apart", () => {
    const lessons = generateSchedule({ firstFinalDueDate: "2026-01-04" });

    expect(lessons).toHaveLength(24);
    expect(lessons[0]).toEqual({
      sequence: 1,
      title: "第1课",
      lessonType: "regular",
      cadenceMode: "same_week",
      outlineDueDate: "2026-01-04",
      groupStudyDueDate: "2026-01-04",
      classStudyDueDate: "2026-01-04",
    });
    expect(lessons[1].classStudyDueDate).toBe("2026-01-11");
    expect(lessons[23].classStudyDueDate).toBe("2026-06-14");
  });

  it("uses a two-week interval and first-stage due date seven days earlier in parallel mode", () => {
    const lessons = generateSchedule({
      firstFinalDueDate: "2026-01-14",
      count: 3,
      cadenceMode: "parallel_two_week",
    });

    expect(lessons.map((lesson) => lesson.classStudyDueDate)).toEqual([
      "2026-01-14",
      "2026-01-28",
      "2026-02-11",
    ]);
    expect(lessons.map((lesson) => lesson.outlineDueDate)).toEqual([
      "2026-01-07",
      "2026-01-21",
      "2026-02-04",
    ]);
    expect(lessons.map((lesson) => lesson.groupStudyDueDate)).toEqual([
      "2026-01-07",
      "2026-01-21",
      "2026-02-04",
    ]);
  });

  it("lets each future lesson carry its own cadence and type", () => {
    const lessons = generateSchedule({
      firstFinalDueDate: "2026-01-07",
      count: 3,
      cadenceModes: ["same_week", "parallel_two_week", "same_week"],
      lessonTypes: ["regular", "review", "regular"],
      titles: ["基础", "复习", "继续学习"],
    });

    expect(lessons.map((lesson) => lesson.classStudyDueDate)).toEqual([
      "2026-01-07",
      "2026-01-21",
      "2026-01-28",
    ]);
    expect(lessons[1]).toMatchObject({
      title: "复习",
      lessonType: "review",
      outlineDueDate: "2026-01-14",
      classStudyDueDate: "2026-01-21",
    });
  });

  it("rejects invalid dates and lesson counts", () => {
    expect(() => generateSchedule({ firstFinalDueDate: "2026-02-30" })).toThrow("不是有效日期");
    expect(() => generateSchedule({ firstFinalDueDate: "2026-01-01", count: 0 })).toThrow(
      "课次数量",
    );
  });
});

describe("schedule changes", () => {
  it("moves the selected lesson and all following lessons without changing earlier or input rows", () => {
    const original = generateSchedule({ firstFinalDueDate: "2026-01-07", count: 3 });
    const shifted = shiftScheduleFrom(original, 2, 7);

    expect(shifted.map((lesson) => lesson.classStudyDueDate)).toEqual([
      "2026-01-07",
      "2026-01-21",
      "2026-01-28",
    ]);
    expect(original.map((lesson) => lesson.classStudyDueDate)).toEqual([
      "2026-01-07",
      "2026-01-14",
      "2026-01-21",
    ]);
    expect(shifted[0]).not.toBe(original[0]);
    expect(() => shiftScheduleFrom(original, 9, 7)).toThrow("找不到第 9 课");
  });

  it("inserts a break by moving every phase on or after its first day", () => {
    const original = generateSchedule({
      firstFinalDueDate: "2026-01-14",
      count: 2,
      cadenceMode: "parallel_two_week",
    });
    const result = insertBreak(original, "2026-01-14", "春节放假");

    expect(result.breakWeek).toEqual({
      startsOn: "2026-01-14",
      endsOn: "2026-01-20",
      title: "春节放假",
    });
    expect(result.lessons[0]).toMatchObject({
      outlineDueDate: "2026-01-07",
      groupStudyDueDate: "2026-01-07",
      classStudyDueDate: "2026-01-21",
    });
    expect(result.lessons[1]).toMatchObject({
      outlineDueDate: "2026-01-28",
      groupStudyDueDate: "2026-01-28",
      classStudyDueDate: "2026-02-04",
    });
    expect(original[0].classStudyDueDate).toBe("2026-01-14");
  });

  it("撤销暂停周时精确恢复原课表", () => {
    const original = generateSchedule({ firstFinalDueDate: "2026-01-14", count: 3 });
    const shifted = insertBreak(original, "2026-01-08", "暂停一周").lessons;

    expect(removeBreak(shifted, "2026-01-08")).toEqual(original);
    expect(shifted).not.toEqual(original);
  });

  it("多个暂停周可以按创建顺序撤销并重新应用", () => {
    const original = generateSchedule({ firstFinalDueDate: "2026-01-10", count: 3 });
    const first = insertBreak(original, "2026-01-04", "第一次暂停").lessons;
    const both = insertBreak(first, "2026-01-11", "第二次暂停").lessons;
    const withoutSecond = removeBreak(both, "2026-01-11");
    const base = removeBreak(withoutSecond, "2026-01-04");
    const onlySecond = insertBreak(base, "2026-01-11", "第二次暂停").lessons;

    expect(withoutSecond).toEqual(first);
    expect(base).toEqual(original);
    expect(onlySecond.map((lesson) => lesson.classStudyDueDate)).toEqual([
      "2026-01-10", "2026-01-24", "2026-01-31"
    ]);
  });
});

describe("monitor lock", () => {
  it("locks at 00:00 on final due date plus fourteen calendar days", () => {
    expect(monitorLockDate("2026-01-01")).toBe("2026-01-15");
    expect(isMonitorLocked("2026-01-01", "2026-01-14")).toBe(false);
    expect(isMonitorLocked("2026-01-01", "2026-01-15")).toBe(true);
    expect(isMonitorLocked("2026-01-01", "2026-02-01")).toBe(true);
  });
});

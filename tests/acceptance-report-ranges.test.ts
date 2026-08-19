import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AttendanceStatus, Metric, ReportRange } from "../src/shared/types.js";
import { openDatabase } from "../src/server/db.js";
import { createClass } from "../src/server/services/classes.js";
import { buildClassReport } from "../src/server/services/reportBuilder.js";

interface FixtureLesson {
  id: number;
  sequence: number;
}

function addLesson(
  db: DatabaseSync,
  classId: number,
  sequence: number,
  outlineDueDate: string,
  classStudyDueDate = outlineDueDate,
): FixtureLesson {
  const result = db.prepare(
    `insert into lessons
       (class_id, sequence, title, lesson_type, cadence_mode, outline_due_date,
        group_study_due_date, class_study_due_date, roster_frozen_at)
     values (?, ?, ?, 'regular', 'same_week', ?, ?, ?, '2026-01-01 00:00:00')`,
  ).run(classId, sequence, `第${sequence}课`, outlineDueDate, outlineDueDate, classStudyDueDate);
  return { id: Number(result.lastInsertRowid), sequence };
}

function addAttendance(
  db: DatabaseSync,
  lessonId: number,
  rosterId: number,
  actorId: number,
  values: Partial<Record<Metric, AttendanceStatus>>,
): void {
  const insert = db.prepare(
    `insert into attendance_entries (lesson_id, lesson_roster_id, metric, status, modified_by)
     values (?, ?, ?, ?, ?)`,
  );
  for (const [metric, status] of Object.entries(values)) {
    insert.run(lessonId, rosterId, metric, status, actorId);
  }
}

describe("报表时间范围验收", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => db.close());

  it("按指标实际日期筛选四范围，排除未来阶段，并让明细与页面汇总使用同一事实集合", () => {
    const admin = db.prepare("select id from users where is_admin = 1").get() as { id: number };
    db.prepare("update users set can_counsel = 1 where id = ?").run(admin.id);
    const classId = createClass(db, {
      name: "报表验收班",
      counselorUserId: admin.id,
      createdBy: admin.id,
      groupCount: 1,
      cadenceMode: "same_week",
    });
    const group = db.prepare("select id, name from groups where class_id = ?").get(classId) as {
      id: number;
      name: string;
    };
    const personId = Number(db.prepare(
      "insert into persons (name, phone) values ('范围学员', '+8613700000100')",
    ).run().lastInsertRowid);
    const enrollmentId = Number(db.prepare(
      "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 1)",
    ).run(classId, personId).lastInsertRowid);
    db.prepare(
      "insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)",
    ).run(enrollmentId, group.id);

    const lessons = [
      addLesson(db, classId, 1, "2026-02-20"),
      addLesson(db, classId, 2, "2026-04-20"),
      addLesson(db, classId, 3, "2026-06-10", "2026-06-20"),
      addLesson(db, classId, 4, "2026-07-01"),
    ];
    const statuses: Array<Partial<Record<Metric, AttendanceStatus>>> = [
      { outline: "yes", group_study: "onsite", class_study: "onsite" },
      { outline: "no", group_study: "onsite", class_study: "observer" },
      { outline: "yes", group_study: "absent", class_study: "absent" },
      { outline: "yes", group_study: "onsite", class_study: "onsite" },
    ];
    lessons.forEach((lesson, index) => {
      const rosterId = Number(db.prepare(
        `insert into lesson_roster
           (lesson_id, enrollment_id, student_name, group_id, group_name)
         values (?, ?, '范围学员', ?, ?)`,
      ).run(lesson.id, enrollmentId, group.id, group.name).lastInsertRowid);
      addAttendance(db, lesson.id, rosterId, admin.id, statuses[index]);
    });

    const reports = Object.fromEntries(
      (["recent", "month", "three_months", "history"] satisfies ReportRange[])
        .map((range) => [range, buildClassReport(db, classId, range, "2026-06-15")]),
    ) as Record<ReportRange, ReturnType<typeof buildClassReport>>;

    expect(reports.recent.details).toHaveLength(2);
    expect(reports.recent.details.map((detail) => detail.metric)).toEqual(["outline", "group_study"]);
    expect(reports.recent.details.every((detail) => detail.lessonSequence === 3)).toBe(true);
    expect(reports.recent.classSummary).toMatchObject({
      outline: { completed: 1, applicable: 1, pending: 0, rate: 100 },
      group_study: { completed: 0, applicable: 1, pending: 0, rate: 0 },
      class_study: { completed: 0, applicable: 0, pending: 0, rate: null },
    });

    expect(reports.month.details).toHaveLength(2);
    expect(reports.month.filters).toEqual({ from: "2026-06-01", to: "2026-06-15" });
    expect(reports.three_months.details).toHaveLength(5);
    expect(reports.three_months.filters).toEqual({ from: "2026-03-15", to: "2026-06-15" });
    expect(reports.three_months.classSummary).toMatchObject({
      outline: { completed: 1, applicable: 2, rate: 50 },
      group_study: { completed: 1, applicable: 2, rate: 50 },
      class_study: { completed: 0, applicable: 1, rate: 0 },
    });

    expect(reports.history.details).toHaveLength(8);
    expect(reports.history.classSummary).toMatchObject({
      outline: { completed: 2, applicable: 3, rate: 66.67 },
      group_study: { completed: 2, applicable: 3, rate: 66.67 },
      class_study: { completed: 1, applicable: 2, rate: 50 },
    });

    const custom = buildClassReport(db, classId, "custom", "2026-06-15", {
      from: "2026-04-20",
      to: "2026-06-10",
    });
    expect(custom.filters).toEqual({ from: "2026-04-20", to: "2026-06-10" });
    expect(custom.rangeLabel).toBe("2026-04-20 至 2026-06-10");
    expect(custom.details).toHaveLength(5);
    expect(custom.details.map((detail) => [detail.lessonSequence, detail.metric])).toEqual([
      [2, "outline"], [2, "group_study"], [2, "class_study"],
      [3, "outline"], [3, "group_study"],
    ]);
    expect(custom.classSummary).toMatchObject({
      outline: { completed: 1, applicable: 2, rate: 50 },
      group_study: { completed: 1, applicable: 2, rate: 50 },
      class_study: { completed: 0, applicable: 1, rate: 0 },
    });

    for (const report of Object.values(reports)) {
      expect(report.details.every((detail) => String(detail.dueDate) <= "2026-06-15")).toBe(true);
      for (const metric of ["outline", "group_study", "class_study"] as const) {
        const detail = report.details.filter((row) => row.metric === metric);
        const summary = report.classSummary[metric];
        expect(summary.applicable + summary.pending + summary.notRequired).toBe(detail.length);
        expect(summary.applicable).toBe(detail.filter((row) => row.status !== null && row.status !== "not_required").length);
      }
    }
    expect(custom.attention).toEqual(reports.history.attention);
  });
});

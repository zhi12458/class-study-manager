import ExcelJS from "exceljs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";
import { createClass } from "../src/server/services/classes.js";
import { parseRosterWorkbook } from "../src/server/services/importRoster.js";
import { freezeLessonRoster, setEnrollmentGroupFromSequence } from "../src/server/services/roster.js";

function setupClass(db: DatabaseSync, options: { lessonCount?: number } = {}) {
  const admin = db.prepare("select id from users where is_admin = 1").get() as { id: number };
  db.prepare("update users set can_counsel = 1 where id = ?").run(admin.id);
  const classId = createClass(db, {
    name: "验收班",
    counselorUserId: admin.id,
    createdBy: admin.id,
    groupCount: 3,
    cadenceMode: "same_week",
    firstDueDate: "2026-01-07",
    lessonCount: options.lessonCount ?? 2,
  });
  const groups = db.prepare(
    "select id, name from groups where class_id = ? order by sort_order",
  ).all(classId) as Array<{ id: number; name: string }>;
  const lessons = db.prepare(
    "select id, sequence from lessons where class_id = ? order by sequence",
  ).all(classId) as Array<{ id: number; sequence: number }>;
  return { adminId: admin.id, classId, groups, lessons };
}

function addEnrollment(
  db: DatabaseSync,
  input: {
    classId: number;
    groupId: number;
    name: string;
    phone: string;
    dharmaName?: string | null;
    note?: string | null;
  },
): { personId: number; enrollmentId: number } {
  const person = db.prepare(
    "insert into persons (name, dharma_name, phone) values (?, ?, ?)",
  ).run(input.name, input.dharmaName ?? null, input.phone);
  const personId = Number(person.lastInsertRowid);
  const enrollment = db.prepare(
    "insert into enrollments (class_id, person_id, note, active_from_sequence) values (?, ?, ?, 1)",
  ).run(input.classId, personId, input.note ?? null);
  const enrollmentId = Number(enrollment.lastInsertRowid);
  db.prepare(
    "insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)",
  ).run(enrollmentId, input.groupId);
  return { personId, enrollmentId };
}

describe("名单快照与 Excel 导入验收", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => db.close());

  it("保留已开始课次的小组快照，并把连续待生效转组折叠为下一课的最终小组", () => {
    const { classId, groups, lessons } = setupClass(db);
    const student = addEnrollment(db, {
      classId,
      groupId: groups[0].id,
      name: "连续转组学员",
      phone: "+8613700000001",
    });

    freezeLessonRoster(db, lessons[0].id);
    setEnrollmentGroupFromSequence(db, student.enrollmentId, groups[1].id, 2);
    setEnrollmentGroupFromSequence(db, student.enrollmentId, groups[2].id, 2);
    freezeLessonRoster(db, lessons[1].id);

    const snapshots = db.prepare(
      `select l.sequence, lr.group_id as groupId, lr.group_name as groupName
         from lesson_roster lr join lessons l on l.id = lr.lesson_id
        where lr.enrollment_id = ? order by l.sequence`,
    ).all(student.enrollmentId) as Array<{ sequence: number; groupId: number; groupName: string }>;
    expect(snapshots).toEqual([
      { sequence: 1, groupId: groups[0].id, groupName: "第一组" },
      { sequence: 2, groupId: groups[2].id, groupName: "第三组" },
    ]);

    const assignments = db.prepare(
      `select group_id as groupId, effective_from_sequence as fromSequence,
              effective_to_sequence as toSequence
         from group_assignments where enrollment_id = ? order by effective_from_sequence`,
    ).all(student.enrollmentId);
    expect(assignments).toEqual([
      { groupId: groups[0].id, fromSequence: 1, toSequence: 2 },
      { groupId: groups[2].id, fromSequence: 2, toSequence: null },
    ]);
  });

  it("复习课冻结名单时自动写入 outline=not_required，并只生成一次审计记录", () => {
    const { classId, adminId, groups, lessons } = setupClass(db, { lessonCount: 1 });
    const student = addEnrollment(db, {
      classId,
      groupId: groups[0].id,
      name: "复习课学员",
      phone: "+8613700000002",
    });
    db.prepare("update lessons set lesson_type = 'review' where id = ?").run(lessons[0].id);

    freezeLessonRoster(db, lessons[0].id);
    freezeLessonRoster(db, lessons[0].id);

    const entry = db.prepare(
      `select a.metric, a.status, a.modified_by as modifiedBy
         from attendance_entries a join lesson_roster lr on lr.id = a.lesson_roster_id
        where a.lesson_id = ? and lr.enrollment_id = ?`,
    ).get(lessons[0].id, student.enrollmentId);
    expect(entry).toEqual({ metric: "outline", status: "not_required", modifiedBy: adminId });

    const audits = db.prepare(
      `select aa.metric, aa.previous_status as previousStatus, aa.new_status as newStatus,
              aa.modified_by as modifiedBy
         from attendance_audit aa join lesson_roster lr on lr.id = aa.lesson_roster_id
        where aa.lesson_id = ? and lr.enrollment_id = ?`,
    ).all(lessons[0].id, student.enrollmentId);
    expect(audits).toEqual([{
      metric: "outline",
      previousStatus: null,
      newStatus: "not_required",
      modifiedBy: adminId,
    }]);
  });

  it("从真实 Excel 工作簿预览 create、update、skip、conflict 四种分类", async () => {
    const { classId, groups } = setupClass(db, { lessonCount: 1 });
    addEnrollment(db, {
      classId,
      groupId: groups[0].id,
      name: "完全相同",
      dharmaName: "同法",
      phone: "+8613700000011",
      note: "同备注",
    });
    addEnrollment(db, {
      classId,
      groupId: groups[0].id,
      name: "待更新旧名",
      phone: "+8613700000012",
      note: "旧备注",
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("学员名单");
    sheet.addRow(["姓名", "法名", "电话", "小组", "备注"]);
    sheet.addRow(["新学员", "新法", "13700000010", "第一组", "新增"]);
    sheet.addRow(["完全相同", "同法", "13700000011", "第一组", "同备注"]);
    sheet.addRow(["更新后姓名", "", "13700000012", "第二组", "新备注"]);
    sheet.addRow(["错误小组", "", "13700000013", "不存在组", ""]);

    const rows = await parseRosterWorkbook(
      db,
      classId,
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );

    expect(rows.map((row) => row.action)).toEqual(["create", "skip", "update", "conflict"]);
    expect(rows[0]).toMatchObject({ phone: "+8613700000010", groupName: "第一组" });
    expect(rows[1].message).toContain("现有资料相同");
    expect(rows[2]).toMatchObject({ name: "更新后姓名", groupName: "第二组", note: "新备注" });
    expect(rows[3].message).toContain("找不到小组");
  });
});

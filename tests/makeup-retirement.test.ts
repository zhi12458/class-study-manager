import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";

describe("补课状态退役迁移", () => {
  it("把现有班修补课及其历史统一改为缺勤，并阻止再次写入补课", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "class-study-makeup-retirement-"));
    const databasePath = path.join(directory, "legacy.sqlite");
    try {
      const legacy = openDatabase(databasePath);
      legacy.exec(`
        drop trigger attendance_entries_reject_makeup_insert;
        drop trigger attendance_entries_reject_makeup_update;
        delete from schema_migrations where version = 12;
      `);
      const adminId = Number((legacy.prepare("select id from users where is_admin = 1").get() as { id: number }).id);
      const classId = Number(legacy.prepare(
        "insert into classes (name, counselor_user_id, created_by) values ('历史补课班', ?, ?) returning id",
      ).get(adminId, adminId)!.id);
      const groupId = Number(legacy.prepare(
        "insert into groups (class_id, name, sort_order) values (?, '第一组', 1) returning id",
      ).get(classId)!.id);
      const personId = Number(legacy.prepare(
        "insert into persons (name) values ('历史学员') returning id",
      ).get()!.id);
      const enrollmentId = Number(legacy.prepare(
        "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 1) returning id",
      ).get(classId, personId)!.id);
      legacy.prepare(
        "insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)",
      ).run(enrollmentId, groupId);
      const lessonId = Number(legacy.prepare(
        `insert into lessons
           (class_id, sequence, title, lesson_type, cadence_mode, outline_due_date, group_study_due_date, class_study_due_date)
         values (?, 1, '历史课', 'regular', 'same_week', '2026-08-01', '2026-08-01', '2026-08-01') returning id`,
      ).get(classId)!.id);
      const rosterId = Number(legacy.prepare(
        `insert into lesson_roster
           (lesson_id, enrollment_id, student_name, group_id, group_name)
         values (?, ?, '历史学员', ?, '第一组') returning id`,
      ).get(lessonId, enrollmentId, groupId)!.id);
      legacy.prepare(
        `insert into attendance_entries
           (lesson_id, lesson_roster_id, metric, status, modified_by)
         values (?, ?, 'class_study', 'makeup', ?)`,
      ).run(lessonId, rosterId, adminId);
      legacy.prepare(
        `insert into attendance_audit
           (lesson_id, lesson_roster_id, metric, previous_status, new_status, modified_by)
         values (?, ?, 'class_study', null, 'makeup', ?)`,
      ).run(lessonId, rosterId, adminId);
      legacy.close();

      const migrated = openDatabase(databasePath);
      expect((migrated.prepare("select status from attendance_entries where lesson_roster_id = ?").get(rosterId) as { status: string }).status)
        .toBe("absent");
      expect(migrated.prepare(
        "select previous_status as previousStatus, new_status as newStatus from attendance_audit where lesson_roster_id = ?",
      ).get(rosterId)).toEqual({ previousStatus: null, newStatus: "absent" });
      expect(() => migrated.prepare(
        `insert into attendance_entries
           (lesson_id, lesson_roster_id, metric, status, modified_by)
         values (?, ?, 'class_study', 'makeup', ?)`,
      ).run(lessonId, rosterId, adminId)).toThrow("makeup attendance status has been retired");
      const event = migrated.prepare(
        "select details_json as detailsJson from system_audit_events where event_type = 'attendance_makeup_retired'",
      ).get() as { detailsJson: string };
      expect(JSON.parse(event.detailsJson)).toEqual({ convertedAttendanceEntries: 1, convertedAuditRows: 1 });
      migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

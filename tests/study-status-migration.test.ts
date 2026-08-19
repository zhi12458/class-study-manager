import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";

describe("组修班修五项状态迁移", () => {
  it("转换出勤、分享及其审计历史，并拒绝再次写入旧状态", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "class-study-status-migration-"));
    const databasePath = path.join(directory, "legacy.sqlite");
    try {
      const legacy = openDatabase(databasePath);
      legacy.exec(`
        drop trigger attendance_entries_reject_makeup_insert;
        drop trigger attendance_entries_reject_makeup_update;
        drop trigger attendance_entries_reject_legacy_study_insert;
        drop trigger attendance_entries_reject_legacy_study_update;
        delete from schema_migrations where version = 14;

        alter table attendance_entries rename to attendance_entries_latest;
        create table attendance_entries (
          id integer primary key autoincrement,
          lesson_id integer not null references lessons(id) on delete cascade,
          lesson_roster_id integer not null references lesson_roster(id) on delete cascade,
          metric text not null check(metric in ('outline', 'group_study', 'class_study')),
          status text not null check(status in (
            'yes', 'no', 'not_required', 'present', 'absent', 'onsite', 'online', 'makeup', 'share'
          )),
          modified_by integer not null references users(id),
          modified_at text not null default current_timestamp,
          unique(lesson_roster_id, metric)
        );
        drop table attendance_entries_latest;
        create index attendance_lesson_idx on attendance_entries(lesson_id);
      `);

      const adminId = Number((legacy.prepare("select id from users where is_admin = 1").get() as { id: number }).id);
      const classId = Number(legacy.prepare(
        "insert into classes (name, counselor_user_id, created_by) values ('旧状态班', ?, ?) returning id",
      ).get(adminId, adminId)!.id);
      const groupId = Number(legacy.prepare(
        "insert into groups (class_id, name, sort_order) values (?, '第一组', 1) returning id",
      ).get(classId)!.id);
      const personId = Number(legacy.prepare("insert into persons (name) values ('旧状态学员') returning id").get()!.id);
      const enrollmentId = Number(legacy.prepare(
        "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 1) returning id",
      ).get(classId, personId)!.id);
      legacy.prepare("insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)")
        .run(enrollmentId, groupId);
      const lessonId = Number(legacy.prepare(
        `insert into lessons
           (class_id, sequence, title, lesson_type, cadence_mode, outline_due_date, group_study_due_date, class_study_due_date)
         values (?, 1, '旧状态课', 'regular', 'same_week', '2026-08-01', '2026-08-01', '2026-08-01') returning id`,
      ).get(classId)!.id);
      const rosterId = Number(legacy.prepare(
        `insert into lesson_roster (lesson_id, enrollment_id, student_name, group_id, group_name)
         values (?, ?, '旧状态学员', ?, '第一组') returning id`,
      ).get(lessonId, enrollmentId, groupId)!.id);
      const secondPersonId = Number(legacy.prepare("insert into persons (name) values ('旧分享学员') returning id").get()!.id);
      const secondEnrollmentId = Number(legacy.prepare(
        "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 1) returning id",
      ).get(classId, secondPersonId)!.id);
      legacy.prepare("insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)")
        .run(secondEnrollmentId, groupId);
      const secondRosterId = Number(legacy.prepare(
        `insert into lesson_roster (lesson_id, enrollment_id, student_name, group_id, group_name)
         values (?, ?, '旧分享学员', ?, '第一组') returning id`,
      ).get(lessonId, secondEnrollmentId, groupId)!.id);
      legacy.prepare(
        `insert into attendance_entries (lesson_id, lesson_roster_id, metric, status, modified_by)
         values (?, ?, 'group_study', 'present', ?)`,
      ).run(lessonId, rosterId, adminId);
      legacy.prepare(
        `insert into attendance_audit (lesson_id, lesson_roster_id, metric, previous_status, new_status, modified_by)
         values (?, ?, 'group_study', null, 'present', ?)`,
      ).run(lessonId, rosterId, adminId);
      legacy.prepare(
        `insert into attendance_audit (lesson_id, lesson_roster_id, metric, previous_status, new_status, modified_by)
         values (?, ?, 'class_study', 'absent', 'share', ?)`,
      ).run(lessonId, secondRosterId, adminId);
      legacy.prepare(
        `insert into attendance_entries (lesson_id, lesson_roster_id, metric, status, modified_by)
         values (?, ?, 'class_study', 'share', ?)`,
      ).run(lessonId, secondRosterId, adminId);
      legacy.close();

      const migrated = openDatabase(databasePath);
      expect(migrated.prepare(
        "select metric, status from attendance_entries order by lesson_roster_id",
      ).all()).toEqual([
        { metric: "group_study", status: "onsite" },
        { metric: "class_study", status: "observer" },
      ]);
      expect(migrated.prepare(
        `select metric, previous_status as previousStatus, new_status as newStatus
           from attendance_audit where lesson_id = ? order by id`,
      ).all(lessonId)).toEqual([
        { metric: "group_study", previousStatus: null, newStatus: "onsite" },
        { metric: "class_study", previousStatus: "absent", newStatus: "observer" },
      ]);
      expect(() => migrated.prepare(
        `insert into attendance_entries (lesson_id, lesson_roster_id, metric, status, modified_by)
         values (?, ?, 'group_study', 'present', ?)`,
      ).run(lessonId, rosterId, adminId)).toThrow("legacy study attendance status has been retired");
      expect(() => migrated.prepare(
        `insert into attendance_entries (lesson_id, lesson_roster_id, metric, status, modified_by)
         values (?, ?, 'class_study', 'share', ?)`,
      ).run(lessonId, rosterId, adminId)).toThrow("legacy study attendance status has been retired");
      const event = migrated.prepare(
        "select details_json as detailsJson from system_audit_events where event_type = 'attendance_study_statuses_migrated'",
      ).get() as { detailsJson: string };
      expect(JSON.parse(event.detailsJson)).toEqual({
        presentToOnsite: 1,
        shareToObserver: 1,
        convertedAuditRows: 2,
      });
      expect(migrated.prepare("pragma foreign_key_check").all()).toEqual([]);
      expect(migrated.prepare("pragma quick_check").all()).toEqual([{ quick_check: "ok" }]);
      migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

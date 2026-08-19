import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const tempDir = path.join(root, "tmp");
const dbPath = path.join(tempDir, "e2e.sqlite");
mkdirSync(tempDir, { recursive: true });
for (const suffix of ["", "-shm", "-wal"]) rmSync(`${dbPath}${suffix}`, { force: true });

process.env.NODE_ENV = "production";
process.env.PORT = "4182";
process.env.DB_PATH = dbPath;
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "E2eAdmin!2026";
process.env.COOKIE_SECURE = "false";

const { openDatabase } = await import("../../dist/server/db.js");
const { createPasswordHash } = await import("../../dist/server/auth.js");
const { createClass } = await import("../../dist/server/services/classes.js");
const { shanghaiToday } = await import("../../dist/server/services/roster.js");

const addDays = (value, days) => new Date(
  new Date(`${value}T00:00:00.000Z`).getTime() + days * 86_400_000,
).toISOString().slice(0, 10);

const db = openDatabase(dbPath);
const admin = db.prepare("select id from users where username = 'admin'").get();
db.prepare("update users set can_counsel = 1, must_change_password = 0 where id = ?").run(admin.id);
const classId = createClass(db, {
  name: "浏览器回归测试班",
  counselorUserId: admin.id,
  createdBy: admin.id,
  groupCount: 2,
  cadenceMode: "same_week",
});
const groups = db.prepare("select id, name from groups where class_id = ? order by sort_order").all(classId);
const personId = Number(db.prepare(
  "insert into persons (name, dharma_name, phone) values ('测试学员', '善测', '+8613700000999')",
).run().lastInsertRowid);
const enrollmentId = Number(db.prepare(
  "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 1)",
).run(classId, personId).lastInsertRowid);
db.prepare(
  "insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)",
).run(enrollmentId, groups[0].id);
const monitorUserId = Number(db.prepare(
  `insert into users (person_id, username, password_hash, display_name, must_change_password)
   values (?, 'monitor-e2e', ?, '测试班长', 0)`,
).run(personId, createPasswordHash("E2eMonitor!2026")).lastInsertRowid);
db.prepare(
  "insert into class_monitors (class_id, enrollment_id, user_id, assigned_by) values (?, ?, ?, ?)",
).run(classId, enrollmentId, monitorUserId, admin.id);

const assistantPersonId = Number(db.prepare(
  "insert into persons (name, dharma_name, phone) values ('考勤协助', '善勤', '+8613700000998')",
).run().lastInsertRowid);
const assistantEnrollmentId = Number(db.prepare(
  "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 1)",
).run(classId, assistantPersonId).lastInsertRowid);
db.prepare(
  "insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)",
).run(assistantEnrollmentId, groups[1].id);
const assistantUserId = Number(db.prepare(
  `insert into users (person_id, username, password_hash, display_name, must_change_password)
   values (?, 'attendance-e2e', ?, '测试考勤员', 0)`,
).run(assistantPersonId, createPasswordHash("E2eAttendance!2026")).lastInsertRowid);
db.prepare(
  `insert into class_attendance_assistants
     (class_id, enrollment_id, user_id, assigned_by) values (?, ?, ?, ?)`,
).run(classId, assistantEnrollmentId, assistantUserId, admin.id);

const counselorCandidatePersonId = Number(db.prepare(
  "insert into persons (name, dharma_name) values ('辅导候选', '善选')",
).run().lastInsertRowid);
const counselorCandidateEnrollmentId = Number(db.prepare(
  "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 1)",
).run(classId, counselorCandidatePersonId).lastInsertRowid);
db.prepare(
  "insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)",
).run(counselorCandidateEnrollmentId, groups[1].id);

const today = shanghaiToday();
const dueDates = [addDays(today, -14), addDays(today, -7), addDays(today, 7)];
const lessonIds = dueDates.map((dueDate, index) => Number(db.prepare(
  `insert into lessons
     (class_id, sequence, title, lesson_type, cadence_mode, outline_due_date,
      group_study_due_date, class_study_due_date, roster_frozen_at, course_position)
   values (?, ?, ?, 'regular', 'same_week', ?, ?, ?, ?, ?)`,
).run(
  classId,
  index + 1,
  `浏览器测试第${index + 1}课`,
  dueDate,
  dueDate,
  dueDate,
  index < 2 ? new Date().toISOString() : null,
  index + 1,
).lastInsertRowid));

for (const lessonId of lessonIds.slice(0, 2)) {
  db.prepare(
    `insert into lesson_roster
       (lesson_id, enrollment_id, student_name, dharma_name, group_id, group_name)
     values (?, ?, '测试学员', '善测', ?, ?)`,
  ).run(lessonId, enrollmentId, groups[0].id, groups[0].name);
  db.prepare(
    `insert into lesson_roster
       (lesson_id, enrollment_id, student_name, dharma_name, group_id, group_name)
     values (?, ?, '考勤协助', '善勤', ?, ?)`,
  ).run(lessonId, assistantEnrollmentId, groups[1].id, groups[1].name);
}
const firstRoster = db.prepare("select id from lesson_roster where lesson_id = ?").get(lessonIds[0]);
const insertAttendance = db.prepare(
  `insert into attendance_entries (lesson_id, lesson_roster_id, metric, status, modified_by)
   values (?, ?, ?, ?, ?)`,
);
insertAttendance.run(lessonIds[0], firstRoster.id, "outline", "yes", admin.id);
insertAttendance.run(lessonIds[0], firstRoster.id, "group_study", "onsite", admin.id);
insertAttendance.run(lessonIds[0], firstRoster.id, "class_study", "online", admin.id);
db.close();

await import("../../dist/server/index.js");

import type { DatabaseSync } from "node:sqlite";
import type { EnrollmentStatus } from "../../shared/types.js";

const DAY_MS = 86_400_000;

export function shanghaiToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function lessonStartDate(lesson: { outlineDueDate: string }): string {
  return addDays(lesson.outlineDueDate, -6);
}

export function getNextEffectiveSequence(db: DatabaseSync, classId: number, today = shanghaiToday()): number {
  const lessons = db.prepare(
    `select sequence, outline_due_date as outlineDueDate, class_study_due_date as classStudyDueDate
       from lessons where class_id = ? order by sequence`
  ).all(classId) as Array<{ sequence: number; outlineDueDate: string; classStudyDueDate: string }>;
  const current = lessons.find((lesson) => lessonStartDate(lesson) <= today && lesson.classStudyDueDate >= today);
  if (current) return current.sequence + 1;
  const next = lessons.find((lesson) => lessonStartDate(lesson) > today);
  if (next) return next.sequence;
  return (lessons.at(-1)?.sequence ?? 0) + 1;
}

export function freezeLessonRoster(db: DatabaseSync, lessonId: number): void {
  const lesson = db.prepare(
    "select id, class_id as classId, sequence, lesson_type as lessonType, roster_frozen_at as frozenAt from lessons where id = ?"
  ).get(lessonId) as { id: number; classId: number; sequence: number; lessonType: string; frozenAt: string | null } | undefined;
  if (!lesson || lesson.frozenAt) return;

  const rows = db.prepare(
    `select e.id as enrollmentId, p.name, p.dharma_name as dharmaName,
            g.id as groupId, g.name as groupName
       from enrollments e
       join persons p on p.id = e.person_id
       join group_assignments ga on ga.enrollment_id = e.id
         and ga.effective_from_sequence <= ?
         and (ga.effective_to_sequence is null or ga.effective_to_sequence > ?)
       join groups g on g.id = ga.group_id
       join enrollment_status_history es on es.enrollment_id = e.id
         and es.effective_from_sequence <= ?
         and (es.effective_to_sequence is null or es.effective_to_sequence > ?)
      where e.class_id = ?
        and e.active_from_sequence <= ?
        and es.status = 'normal'
      order by g.sort_order, p.name`
  ).all(lesson.sequence, lesson.sequence, lesson.sequence, lesson.sequence, lesson.classId, lesson.sequence) as Array<{
    enrollmentId: number; name: string; dharmaName: string | null; groupId: number; groupName: string;
  }>;

  const insertRoster = db.prepare(
    `insert or ignore into lesson_roster
       (lesson_id, enrollment_id, student_name, dharma_name, group_id, group_name)
     values (?, ?, ?, ?, ?, ?)`
  );
  const insertAttendance = db.prepare(
    `insert or ignore into attendance_entries
       (lesson_id, lesson_roster_id, metric, status, modified_by)
     values (?, ?, 'outline', 'not_required', ?)`
  );
  const insertAudit = db.prepare(
    `insert into attendance_audit
       (lesson_id, lesson_roster_id, metric, previous_status, new_status, modified_by)
     values (?, ?, 'outline', null, 'not_required', ?)`
  );
  const actor = db.prepare("select id from users where is_admin = 1 order by id limit 1").get() as { id: number };

  db.exec("begin immediate");
  try {
    for (const row of rows) {
      insertRoster.run(lesson.id, row.enrollmentId, row.name, row.dharmaName, row.groupId, row.groupName);
      if (lesson.lessonType === "review") {
        const roster = db.prepare("select id from lesson_roster where lesson_id = ? and enrollment_id = ?").get(
          lesson.id, row.enrollmentId
        ) as { id: number };
        const result = insertAttendance.run(lesson.id, roster.id, actor.id);
        if (Number(result.changes) > 0) insertAudit.run(lesson.id, roster.id, actor.id);
      }
    }
    db.prepare("update lessons set roster_frozen_at = current_timestamp where id = ?").run(lesson.id);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function freezeStartedLessons(db: DatabaseSync, classId: number, today = shanghaiToday()): void {
  const lessons = db.prepare(
    `select id, outline_due_date as outlineDueDate
       from lessons where class_id = ? and roster_frozen_at is null order by sequence`
  ).all(classId) as Array<{ id: number; outlineDueDate: string }>;
  for (const lesson of lessons) {
    if (addDays(lesson.outlineDueDate, -6) <= today) freezeLessonRoster(db, lesson.id);
  }
}

export function assertPersonAvailableForEnrollment(db: DatabaseSync, personId: number, targetClassId: number): void {
  const other = db.prepare(
    `select c.name
       from enrollments e
       join classes c on c.id = e.class_id
       join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
      where e.person_id = ? and es.status != 'withdrawn' and c.archived = 0 and c.id != ?
      limit 1`
  ).get(personId, targetClassId) as { name: string } | undefined;
  if (other) throw new Error(`该学员已作为学员加入“${other.name}”`);
}

export function setEnrollmentStatusFromSequence(
  db: DatabaseSync,
  enrollmentId: number,
  status: EnrollmentStatus,
  effectiveSequence: number
): void {
  const current = db.prepare(
    `select id, status, effective_from_sequence as effectiveFromSequence
       from enrollment_status_history
      where enrollment_id = ? and effective_to_sequence is null`
  ).get(enrollmentId) as { id: number; status: EnrollmentStatus; effectiveFromSequence: number } | undefined;
  if (!current) throw new Error("学员缺少有效的状态记录");
  if (current.status === status) return;

  if (current.effectiveFromSequence === effectiveSequence) {
    const previous = db.prepare(
      `select id, status from enrollment_status_history
        where enrollment_id = ? and effective_to_sequence = ?
        order by effective_from_sequence desc limit 1`
    ).get(enrollmentId, effectiveSequence) as { id: number; status: EnrollmentStatus } | undefined;
    if (previous?.status === status) {
      db.prepare("delete from enrollment_status_history where id = ?").run(current.id);
      db.prepare("update enrollment_status_history set effective_to_sequence = null where id = ?").run(previous.id);
    } else {
      db.prepare("update enrollment_status_history set status = ? where id = ?").run(status, current.id);
    }
  } else {
    db.prepare("update enrollment_status_history set effective_to_sequence = ? where id = ?").run(effectiveSequence, current.id);
    db.prepare(
      "insert into enrollment_status_history (enrollment_id, status, effective_from_sequence) values (?, ?, ?)"
    ).run(enrollmentId, status, effectiveSequence);
  }
  const enrollment = db.prepare("select active_from_sequence as activeFromSequence from enrollments where id = ?")
    .get(enrollmentId) as { activeFromSequence: number };
  const inactiveFrom = status === "withdrawn" && effectiveSequence > enrollment.activeFromSequence ? effectiveSequence : null;
  db.prepare("update enrollments set inactive_from_sequence = ?, updated_at = current_timestamp where id = ?")
    .run(inactiveFrom, enrollmentId);
}

export function setEnrollmentGroupFromSequence(
  db: DatabaseSync,
  enrollmentId: number,
  groupId: number,
  effectiveSequence: number
): void {
  const current = db.prepare(
    `select id, group_id as groupId, effective_from_sequence as effectiveFromSequence
       from group_assignments where enrollment_id = ? and effective_to_sequence is null`
  ).get(enrollmentId) as { id: number; groupId: number; effectiveFromSequence: number } | undefined;
  if (!current) throw new Error("学员缺少有效的小组归属");
  if (current.groupId === groupId) return;

  if (current.effectiveFromSequence === effectiveSequence) {
    const previous = db.prepare(
      `select id, group_id as groupId from group_assignments
        where enrollment_id = ? and effective_to_sequence = ? order by effective_from_sequence desc limit 1`
    ).get(enrollmentId, effectiveSequence) as { id: number; groupId: number } | undefined;
    if (previous?.groupId === groupId) {
      db.prepare("delete from group_assignments where id = ?").run(current.id);
      db.prepare("update group_assignments set effective_to_sequence = null where id = ?").run(previous.id);
    } else {
      db.prepare("update group_assignments set group_id = ? where id = ?").run(groupId, current.id);
    }
    return;
  }

  db.prepare("update group_assignments set effective_to_sequence = ? where id = ?").run(effectiveSequence, current.id);
  db.prepare("insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, ?)")
    .run(enrollmentId, groupId, effectiveSequence);
}

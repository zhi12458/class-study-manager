import type { DatabaseSync } from "node:sqlite";
import type { CadenceMode, LessonScheduleItem, LessonType } from "../../shared/types.js";
import { coursePlanForRange } from "../../shared/courseCatalog.js";
import { generateSchedule, insertBreak, shiftScheduleFrom } from "./schedule.js";
import { freezeStartedLessons, shanghaiToday } from "./roster.js";

const DAY_MS = 86_400_000;
const DEFAULT_GROUP_NAMES = ["第一组", "第二组", "第三组", "第四组", "第五组"];

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

type StoredLesson = LessonScheduleItem & { id: number; frozenAt: string | null; coursePosition: number | null };
type RosterSnapshotRow = {
  enrollmentId: number;
  studentName: string;
  dharmaName: string | null;
  groupId: number;
  groupName: string;
};

function lessonRows(db: DatabaseSync, classId: number): StoredLesson[] {
  return db.prepare(
    `select id, sequence, title, lesson_type as lessonType, cadence_mode as cadenceMode,
            outline_due_date as outlineDueDate, group_study_due_date as groupStudyDueDate,
            class_study_due_date as classStudyDueDate, roster_frozen_at as frozenAt,
            course_position as coursePosition
       from lessons where class_id = ? order by sequence`
  ).all(classId) as unknown as StoredLesson[];
}

function insertLessons(db: DatabaseSync, classId: number, lessons: LessonScheduleItem[], coursePositions?: number[]): void {
  const insert = db.prepare(
    `insert into lessons
       (class_id, sequence, title, lesson_type, cadence_mode, outline_due_date, group_study_due_date, class_study_due_date, course_position)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [index, lesson] of lessons.entries()) {
    insert.run(classId, lesson.sequence, lesson.title, lesson.lessonType, lesson.cadenceMode,
      lesson.outlineDueDate, lesson.groupStudyDueDate, lesson.classStudyDueDate, coursePositions?.[index] ?? null);
  }
}

function catalogPlan(db: DatabaseSync, seriesKey: string, startPosition: number, count: number) {
  const rows = db.prepare(
    `select position, title, lesson_type as lessonType
       from course_catalog_items where series_key = ? and position >= ?
      order by position limit ?`
  ).all(seriesKey, startPosition, count) as Array<{ position: number; title: string; lessonType: LessonType }>;
  if (!rows.length) throw new Error("所选课程起点不存在，请刷新课程目录后重试");
  return {
    titles: rows.map((row) => row.title), lessonTypes: rows.map((row) => row.lessonType),
    positions: rows.map((row) => row.position)
  };
}

function applySavedBreaks(db: DatabaseSync, classId: number, lessons: LessonScheduleItem[]): LessonScheduleItem[] {
  if (!lessons.length) return lessons;
  const savedBreaks = db.prepare(
    `select start_date as startDate, weeks, reason
       from schedule_breaks
      where class_id = ?
      order by start_date, id`
  ).all(classId) as Array<{ startDate: string; weeks: number; reason: string }>;
  let scheduled = lessons;
  const firstStageStart = addDays(lessons[0].outlineDueDate, -6);
  for (const savedBreak of savedBreaks) {
    for (let week = 0; week < savedBreak.weeks; week += 1) {
      const weekStart = addDays(savedBreak.startDate, week * 7);
      if (addDays(weekStart, 6) < firstStageStart) continue;
      scheduled = insertBreak(scheduled, weekStart, savedBreak.reason).lessons;
    }
  }
  return scheduled;
}

/**
 * Schedule-wide operations may only touch the continuous suffix after the
 * final locked lesson. An attendance record only locks the schedule after its
 * final due date has passed; the due date itself remains adjustable.
 */
function adjustableScheduleSuffixStart(
  db: DatabaseSync,
  lessons: readonly { id: number; classStudyDueDate: string }[],
  allowLockedOverride = false,
): number {
  if (allowLockedOverride) return 0;
  for (let index = lessons.length - 1; index >= 0; index -= 1) {
    if (lessonScheduleLocked(db, lessons[index])) return index + 1;
  }
  return 0;
}

/**
 * A frozen roster only means the lesson week has arrived. It is not evidence
 * that a person has started entering attendance. Review lessons receive an
 * automatic outline/not-required record when their roster freezes, so that
 * system-generated value must not lock schedule editing by itself.
 */
export function lessonHasRecordedAttendance(db: DatabaseSync, lessonId: number): boolean {
  const entry = db.prepare(
    `select 1
       from attendance_entries ae
       join lessons l on l.id = ae.lesson_id
      where ae.lesson_id = ?
        and not (l.lesson_type = 'review' and ae.metric = 'outline' and ae.status = 'not_required')
      limit 1`
  ).get(lessonId);
  if (entry) return true;
  return Boolean(db.prepare(
    `select 1
       from attendance_audit aa
       join lessons l on l.id = aa.lesson_id
      where aa.lesson_id = ?
        and not (
          l.lesson_type = 'review' and aa.metric = 'outline'
          and aa.previous_status is null and aa.new_status = 'not_required'
        )
      limit 1`
  ).get(lessonId));
}

export function lessonScheduleLocked(
  db: DatabaseSync,
  lesson: { id: number; classStudyDueDate: string },
  today = shanghaiToday(),
): boolean {
  return lesson.classStudyDueDate < today && lessonHasRecordedAttendance(db, lesson.id);
}

type AttendanceDiscardImpact = {
  discardedAttendanceLessonCount: number;
  discardedAttendanceEntryCount: number;
  discardedAttendanceAuditCount: number;
};

function attendanceDiscardImpact(
  db: DatabaseSync,
  lessons: readonly { id: number; lessonType: LessonType }[],
): AttendanceDiscardImpact {
  let discardedAttendanceLessonCount = 0;
  let discardedAttendanceEntryCount = 0;
  let discardedAttendanceAuditCount = 0;
  for (const lesson of lessons) {
    if (!lessonHasRecordedAttendance(db, lesson.id)) continue;
    discardedAttendanceLessonCount += 1;
    const entries = db.prepare(
      `select count(*) as count
         from attendance_entries
        where lesson_id = ?
          and not (? = 'review' and metric = 'outline' and status = 'not_required')`,
    ).get(lesson.id, lesson.lessonType) as { count: number };
    const audits = db.prepare(
      `select count(*) as count
         from attendance_audit
        where lesson_id = ?
          and not (
            ? = 'review' and metric = 'outline'
            and previous_status is null and new_status = 'not_required'
          )`,
    ).get(lesson.id, lesson.lessonType) as { count: number };
    discardedAttendanceEntryCount += entries.count;
    discardedAttendanceAuditCount += audits.count;
  }
  return {
    discardedAttendanceLessonCount,
    discardedAttendanceEntryCount,
    discardedAttendanceAuditCount,
  };
}

function requireAttendanceDiscardConfirmation(
  impact: AttendanceDiscardImpact,
  confirmed: boolean,
): void {
  if (impact.discardedAttendanceLessonCount === 0 || confirmed) return;
  throw new Error(
    `该操作会清除${impact.discardedAttendanceLessonCount}个尚未截止课次的`
    + `${impact.discardedAttendanceEntryCount}条考勤和${impact.discardedAttendanceAuditCount}条变更历史；`
    + "请确认后以 confirmDiscardAttendance=true 重试",
  );
}

function resetUnattendedLessonRoster(db: DatabaseSync, lessonId: number): void {
  if (lessonHasRecordedAttendance(db, lessonId)) throw new Error("本课已有考勤记录，不能修改课表");
  db.prepare("delete from lesson_roster where lesson_id = ?").run(lessonId);
  db.prepare("update lessons set roster_frozen_at = null where id = ?").run(lessonId);
}

function copyRosterSnapshotToLesson(
  db: DatabaseSync,
  lessonId: number,
  lessonType: LessonType,
  rows: readonly RosterSnapshotRow[],
): void {
  const insertRoster = db.prepare(
    `insert into lesson_roster
       (lesson_id, enrollment_id, student_name, dharma_name, group_id, group_name)
     values (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insertRoster.run(lessonId, row.enrollmentId, row.studentName, row.dharmaName, row.groupId, row.groupName);
  }
  if (lessonType === "review" && rows.length > 0) {
    const actor = db.prepare("select id from users where is_admin = 1 order by id limit 1").get() as { id: number };
    const insertAttendance = db.prepare(
      `insert into attendance_entries
         (lesson_id, lesson_roster_id, metric, status, modified_by)
       values (?, ?, 'outline', 'not_required', ?)`,
    );
    const insertAudit = db.prepare(
      `insert into attendance_audit
         (lesson_id, lesson_roster_id, metric, previous_status, new_status, modified_by)
       values (?, ?, 'outline', null, 'not_required', ?)`,
    );
    const rosterId = db.prepare(
      "select id from lesson_roster where lesson_id = ? and enrollment_id = ?",
    );
    for (const row of rows) {
      const roster = rosterId.get(lessonId, row.enrollmentId) as { id: number };
      insertAttendance.run(lessonId, roster.id, actor.id);
      insertAudit.run(lessonId, roster.id, actor.id);
    }
  }
  db.prepare("update lessons set roster_frozen_at = current_timestamp where id = ?").run(lessonId);
}

function shiftSequenceBoundariesForInsertion(db: DatabaseSync, classId: number, fromSequence: number): void {
  const offset = 1_000_000;
  db.prepare("update lessons set sequence = sequence + ? where class_id = ? and sequence >= ?")
    .run(offset, classId, fromSequence);
  db.prepare("update lessons set sequence = sequence - ? where class_id = ? and sequence >= ?")
    .run(offset - 1, classId, fromSequence + offset);

  db.prepare(
    `update enrollments
        set active_from_sequence = case when active_from_sequence >= ? then active_from_sequence + 1 else active_from_sequence end,
            inactive_from_sequence = case when inactive_from_sequence >= ? then inactive_from_sequence + 1 else inactive_from_sequence end
      where class_id = ?`
  ).run(fromSequence, fromSequence, classId);

  for (const table of ["group_assignments", "enrollment_status_history"] as const) {
    db.prepare(
      `update ${table}
          set effective_from_sequence = case when effective_from_sequence >= ? then effective_from_sequence + ? else effective_from_sequence end,
              effective_to_sequence = case when effective_to_sequence >= ? then effective_to_sequence + ? else effective_to_sequence end
        where enrollment_id in (select id from enrollments where class_id = ?)`
    ).run(fromSequence, offset, fromSequence, offset, classId);
    db.prepare(
      `update ${table}
          set effective_from_sequence = case when effective_from_sequence >= ? then effective_from_sequence - ? else effective_from_sequence end,
              effective_to_sequence = case when effective_to_sequence >= ? then effective_to_sequence - ? else effective_to_sequence end
        where enrollment_id in (select id from enrollments where class_id = ?)`
    ).run(fromSequence + offset, offset - 1, fromSequence + offset, offset - 1, classId);
  }
}

function shiftSequenceBoundariesForDeletion(db: DatabaseSync, classId: number, deletedSequence: number): void {
  const offset = 1_000_000;
  db.prepare("update lessons set sequence = sequence + ? where class_id = ? and sequence > ?")
    .run(offset, classId, deletedSequence);
  db.prepare("update lessons set sequence = sequence - ? where class_id = ? and sequence > ?")
    .run(offset + 1, classId, deletedSequence + offset);

  db.prepare(
    `update enrollments
        set active_from_sequence = case when active_from_sequence > ? then active_from_sequence - 1 else active_from_sequence end,
            inactive_from_sequence = case when inactive_from_sequence > ? then inactive_from_sequence - 1 else inactive_from_sequence end
      where class_id = ?`
  ).run(deletedSequence, deletedSequence, classId);

  const groupRows = db.prepare(
    `select ga.id, ga.enrollment_id as enrollmentId, ga.group_id as groupId,
            ga.effective_from_sequence as effectiveFromSequence, ga.effective_to_sequence as effectiveToSequence,
            ga.created_at as createdAt
       from group_assignments ga
       join enrollments e on e.id = ga.enrollment_id
      where e.class_id = ?
      order by ga.enrollment_id, ga.effective_from_sequence, ga.id`
  ).all(classId) as Array<{
    id: number; enrollmentId: number; groupId: number; effectiveFromSequence: number;
    effectiveToSequence: number | null; createdAt: string;
  }>;
  db.prepare("delete from group_assignments where enrollment_id in (select id from enrollments where class_id = ?)")
    .run(classId);
  const insertGroup = db.prepare(
    `insert into group_assignments
       (id, enrollment_id, group_id, effective_from_sequence, effective_to_sequence, created_at)
     values (?, ?, ?, ?, ?, ?)`
  );
  for (const row of groupRows) {
    const from = row.effectiveFromSequence > deletedSequence ? row.effectiveFromSequence - 1 : row.effectiveFromSequence;
    const to = row.effectiveToSequence != null && row.effectiveToSequence > deletedSequence
      ? row.effectiveToSequence - 1 : row.effectiveToSequence;
    if (to != null && to <= from) continue;
    insertGroup.run(row.id, row.enrollmentId, row.groupId, from, to, row.createdAt);
  }

  const statusRows = db.prepare(
    `select es.id, es.enrollment_id as enrollmentId, es.status,
            es.effective_from_sequence as effectiveFromSequence, es.effective_to_sequence as effectiveToSequence,
            es.created_at as createdAt
       from enrollment_status_history es
       join enrollments e on e.id = es.enrollment_id
      where e.class_id = ?
      order by es.enrollment_id, es.effective_from_sequence, es.id`
  ).all(classId) as Array<{
    id: number; enrollmentId: number; status: string; effectiveFromSequence: number;
    effectiveToSequence: number | null; createdAt: string;
  }>;
  db.prepare("delete from enrollment_status_history where enrollment_id in (select id from enrollments where class_id = ?)")
    .run(classId);
  const insertStatus = db.prepare(
    `insert into enrollment_status_history
       (id, enrollment_id, status, effective_from_sequence, effective_to_sequence, created_at)
     values (?, ?, ?, ?, ?, ?)`
  );
  for (const row of statusRows) {
    const from = row.effectiveFromSequence > deletedSequence ? row.effectiveFromSequence - 1 : row.effectiveFromSequence;
    const to = row.effectiveToSequence != null && row.effectiveToSequence > deletedSequence
      ? row.effectiveToSequence - 1 : row.effectiveToSequence;
    if (to != null && to <= from) continue;
    insertStatus.run(row.id, row.enrollmentId, row.status, from, to, row.createdAt);
  }
}

function assertEnrollmentBoundariesSurviveDeletion(
  db: DatabaseSync,
  classId: number,
  deletedSequence: number,
): void {
  const collapsed = db.prepare(
    `select p.name, p.dharma_name as dharmaName
       from enrollments e
       join persons p on p.id = e.person_id
      where e.class_id = ?
        and e.active_from_sequence = ?
        and e.inactive_from_sequence = ?
      order by e.id
      limit 1`,
  ).get(classId, deletedSequence, deletedSequence + 1) as {
    name: string;
    dharmaName: string | null;
  } | undefined;
  if (!collapsed) return;
  const studentName = collapsed.dharmaName?.trim() || collapsed.name.trim() || "该学员";
  throw new Error(`不能删除：${studentName}的学籍只在本课生效，请先调整该学员的入班或停用课次`);
}

export function createClass(db: DatabaseSync, input: {
  name: string; counselorUserId: number; createdBy: number; groupCount: number;
  cadenceMode: CadenceMode; firstDueDate?: string; lessonCount?: number; meetingTime?: string | null;
}): number {
  if (!input.name.trim()) throw new Error("班级名称必填");
  if (!Number.isInteger(input.groupCount) || input.groupCount < 1 || input.groupCount > 5) throw new Error("小组数必须为1至5");
  const counselor = db.prepare("select id from users where id = ? and can_counsel = 1 and active = 1").get(input.counselorUserId);
  if (!counselor) throw new Error("请选择有效的辅导员账号");
  db.exec("begin immediate");
  try {
    const result = db.prepare(
      `insert into classes (name, counselor_user_id, cadence_mode, created_by, meeting_time) values (?, ?, ?, ?, ?)`
    ).run(input.name.trim(), input.counselorUserId, input.cadenceMode, input.createdBy, input.meetingTime ?? null);
    const classId = Number(result.lastInsertRowid);
    db.prepare(
      "insert into class_counselor_history (class_id, counselor_user_id, assigned_by) values (?, ?, ?)"
    ).run(classId, input.counselorUserId, input.createdBy);
    const insertGroup = db.prepare("insert into groups (class_id, name, sort_order) values (?, ?, ?)");
    for (let index = 0; index < input.groupCount; index += 1) insertGroup.run(classId, DEFAULT_GROUP_NAMES[index], index + 1);
    if (input.firstDueDate) {
      const coursePlan = coursePlanForRange(1, input.lessonCount ?? 50);
      insertLessons(db, classId, generateSchedule({
        firstFinalDueDate: input.firstDueDate, count: input.lessonCount ?? 50, cadenceMode: input.cadenceMode,
        ...coursePlan
      }));
    }
    db.exec("commit");
    return classId;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function appendLessons(db: DatabaseSync, classId: number, count = 24): number {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("追加课数必须为1至100");
  const cls = db.prepare(
    "select cadence_mode as cadenceMode, course_series_key as courseSeriesKey, course_start_position as courseStartPosition from classes where id = ?"
  ).get(classId) as { cadenceMode: CadenceMode; courseSeriesKey: string | null; courseStartPosition: number };
  const existing = lessonRows(db, classId);
  if (existing.length === 0) throw new Error("请先设置第一课截止日");
  const last = existing.at(-1)!;
  const nextDue = addDays(last.classStudyDueDate, cls.cadenceMode === "parallel_two_week" ? 14 : 7);
  const nextCoursePosition = last.coursePosition == null
    ? cls.courseStartPosition + existing.length
    : last.coursePosition + 1;
  const plan = cls.courseSeriesKey
    ? catalogPlan(db, cls.courseSeriesKey, nextCoursePosition, count)
    : { ...coursePlanForRange(last.sequence + 1, count), positions: [] as number[] };
  const generated = generateSchedule({
    firstFinalDueDate: nextDue, count: plan.titles.length, cadenceMode: cls.cadenceMode,
    startSequence: last.sequence + 1, titles: plan.titles, lessonTypes: plan.lessonTypes
  });
  db.exec("begin immediate");
  try { insertLessons(db, classId, generated, plan.positions); db.exec("commit"); }
  catch (error) { db.exec("rollback"); throw error; }
  return generated.length;
}

export function rebuildFutureSchedule(
  db: DatabaseSync,
  classId: number,
  input: {
    firstDueDate: string;
    count: number;
    cadenceMode: CadenceMode;
    seriesKey: string;
    startPosition: number;
    round: number;
    confirmDiscardAttendance?: boolean;
    allowLockedOverride?: boolean;
  }
): {
  preservedCount: number;
  replacedCount: number;
  generatedCount: number;
  firstFutureSequence: number;
} & AttendanceDiscardImpact {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 100) throw new Error("课次数量必须为1至100");
  freezeStartedLessons(db, classId);
  const existing = lessonRows(db, classId);
  const firstFutureIndex = adjustableScheduleSuffixStart(db, existing, input.allowLockedOverride === true);
  if (firstFutureIndex >= existing.length) throw new Error("最后一个已锁定课次之后，没有可重新生成的课次");
  const firstFutureSequence = existing[firstFutureIndex].sequence;
  const replacedLessons = existing.slice(firstFutureIndex);
  const discardImpact = attendanceDiscardImpact(db, replacedLessons);
  requireAttendanceDiscardConfirmation(discardImpact, input.confirmDiscardAttendance === true);
  const plan = catalogPlan(db, input.seriesKey, input.startPosition, input.count);
  const generated = applySavedBreaks(db, classId, generateSchedule({
    firstFinalDueDate: input.firstDueDate,
    count: plan.titles.length,
    cadenceMode: input.cadenceMode,
    startSequence: firstFutureSequence,
    titles: plan.titles,
    lessonTypes: plan.lessonTypes
  }));
  const replacedCount = replacedLessons.length;

  db.exec("begin immediate");
  try {
    db.prepare("delete from lessons where class_id = ? and sequence >= ?").run(classId, firstFutureSequence);
    db.prepare(
      `update classes
          set cadence_mode = ?, course_series_key = ?, course_round = ?, course_start_position = ?,
              updated_at = current_timestamp
        where id = ?`
    ).run(input.cadenceMode, input.seriesKey, input.round, input.startPosition, classId);
    insertLessons(db, classId, generated, plan.positions);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return {
    preservedCount: firstFutureIndex,
    replacedCount,
    generatedCount: generated.length,
    firstFutureSequence,
    ...discardImpact,
  };
}

export function insertLesson(
  db: DatabaseSync,
  classId: number,
  input: {
    beforeLessonId: number;
    title: string;
    lessonType: LessonType;
    classStudyDueDate: string;
    coursePosition?: number | null;
  },
  options: { allowLockedOverride?: boolean } = {},
): { lessonId: number; sequence: number } {
  freezeStartedLessons(db, classId);
  const existing = lessonRows(db, classId);
  const target = existing.find((lesson) => lesson.id === input.beforeLessonId);
  if (!target) throw new Error("插入位置不存在");
  const targetIndex = existing.indexOf(target);
  const adjustableStart = adjustableScheduleSuffixStart(db, existing, options.allowLockedOverride === true);
  if (targetIndex < adjustableStart) {
    throw new Error("只能在最后一个已锁定课次之后插入，避免移动已锁定课次");
  }
  const affectedLessons = existing.slice(targetIndex);
  if (!options.allowLockedOverride && affectedLessons.some((lesson) => lessonScheduleLocked(db, lesson))) {
    throw new Error("插入位置或后续存在已截止且已有考勤的锁定课次，不能整体顺延");
  }
  if (!input.title.trim()) throw new Error("课名不能为空");
  const targetRoster = target.frozenAt ? db.prepare(
    `select enrollment_id as enrollmentId, student_name as studentName, dharma_name as dharmaName,
            group_id as groupId, group_name as groupName
       from lesson_roster where lesson_id = ? order by id`,
  ).all(target.id) as RosterSnapshotRow[] : [];

  let title = input.title.trim();
  let lessonType = input.lessonType;
  let coursePosition = input.coursePosition ?? null;
  if (coursePosition != null) {
    if (!Number.isInteger(coursePosition) || coursePosition < 1) throw new Error("课程目录位置无效");
    const catalogItem = db.prepare(
      `select cci.title, cci.lesson_type as lessonType
         from classes c
         join course_catalog_items cci on cci.series_key = c.course_series_key
        where c.id = ? and cci.position = ?`
    ).get(classId, coursePosition) as { title: string; lessonType: LessonType } | undefined;
    if (!catalogItem) throw new Error("所选课程不在本班当前课程目录中");
    title = catalogItem.title;
    lessonType = catalogItem.lessonType;
  }

  const rebuilt = applySavedBreaks(db, classId, generateSchedule({
    firstFinalDueDate: input.classStudyDueDate,
    count: existing.length - existing.indexOf(target) + 1,
    cadenceMode: target.cadenceMode,
    cadenceModes: [target.cadenceMode, ...existing.slice(existing.indexOf(target)).map((lesson) => lesson.cadenceMode)],
    startSequence: target.sequence,
    titles: [title, ...existing.slice(existing.indexOf(target)).map((lesson) => lesson.title)],
    lessonTypes: [lessonType, ...existing.slice(existing.indexOf(target)).map((lesson) => lesson.lessonType)]
  }));

  db.exec("begin immediate");
  try {
    for (const lesson of affectedLessons) {
      if (lesson.frozenAt && !lessonHasRecordedAttendance(db, lesson.id)) resetUnattendedLessonRoster(db, lesson.id);
    }
    shiftSequenceBoundariesForInsertion(db, classId, target.sequence);
    const inserted = rebuilt[0];
    const result = db.prepare(
      `insert into lessons
         (class_id, sequence, title, lesson_type, cadence_mode, outline_due_date, group_study_due_date,
          class_study_due_date, course_position)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(classId, inserted.sequence, inserted.title, inserted.lessonType, inserted.cadenceMode,
      inserted.outlineDueDate, inserted.groupStudyDueDate, inserted.classStudyDueDate, coursePosition);
    const insertedLessonId = Number(result.lastInsertRowid);
    if (target.frozenAt && addDays(inserted.outlineDueDate, -6) <= shanghaiToday()) {
      copyRosterSnapshotToLesson(db, insertedLessonId, inserted.lessonType, targetRoster);
    }
    const update = db.prepare(
      `update lessons
          set outline_due_date = ?, group_study_due_date = ?, class_study_due_date = ?, updated_at = current_timestamp
        where id = ?`
    );
    existing.slice(existing.indexOf(target)).forEach((lesson, index) => {
      const scheduled = rebuilt[index + 1];
      update.run(scheduled.outlineDueDate, scheduled.groupStudyDueDate, scheduled.classStudyDueDate, lesson.id);
    });
    db.exec("commit");
    return { lessonId: insertedLessonId, sequence: target.sequence };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function deleteLesson(
  db: DatabaseSync,
  classId: number,
  lessonId: number,
  options: { confirmDiscardAttendance?: boolean; allowLockedOverride?: boolean } = {},
): {
  deletedSequence: number;
  deletedTitle: string;
  renumberedFutureLessons: boolean;
} & AttendanceDiscardImpact {
  freezeStartedLessons(db, classId);
  const target = lessonRows(db, classId).find((lesson) => lesson.id === lessonId);
  if (!target) throw new Error("课次不存在");
  if (!options.allowLockedOverride && lessonScheduleLocked(db, target)) {
    throw new Error("本课已截止且已有考勤记录，课表已锁定，不能删除");
  }
  const discardImpact = attendanceDiscardImpact(db, [target]);
  requireAttendanceDiscardConfirmation(discardImpact, options.confirmDiscardAttendance === true);
  const isFutureLesson = addDays(target.outlineDueDate, -6) > shanghaiToday();
  if (isFutureLesson) assertEnrollmentBoundariesSurviveDeletion(db, classId, target.sequence);

  db.exec("begin immediate");
  try {
    db.prepare("delete from lessons where id = ? and class_id = ?").run(lessonId, classId);
    if (isFutureLesson) shiftSequenceBoundariesForDeletion(db, classId, target.sequence);
    db.exec("commit");
    return {
      deletedSequence: target.sequence,
      deletedTitle: target.title,
      renumberedFutureLessons: isFutureLesson,
      ...discardImpact,
    };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function setInitialSchedule(
  db: DatabaseSync,
  classId: number,
  firstDueDate: string,
  count = 50,
  cadenceOverride?: CadenceMode,
  course?: { seriesKey: string; startPosition: number; round: number }
): number {
  const existing = lessonRows(db, classId);
  if (existing.length > 0) throw new Error("课表已存在");
  const cls = db.prepare("select cadence_mode as cadenceMode from classes where id = ?").get(classId) as { cadenceMode: CadenceMode };
  const cadenceMode = cadenceOverride ?? cls.cadenceMode;
  const plan = course
    ? catalogPlan(db, course.seriesKey, course.startPosition, count)
    : { ...coursePlanForRange(1, count), positions: [] as number[] };
  const generated = applySavedBreaks(db, classId, generateSchedule({
    firstFinalDueDate: firstDueDate, count: plan.titles.length, cadenceMode,
    titles: plan.titles, lessonTypes: plan.lessonTypes
  }));
  db.exec("begin immediate");
  try {
    if (cadenceOverride) {
      db.prepare("update classes set cadence_mode = ?, updated_at = current_timestamp where id = ?").run(cadenceOverride, classId);
    }
    if (course) {
      db.prepare(
        "update classes set course_series_key = ?, course_round = ?, course_start_position = ?, updated_at = current_timestamp where id = ?"
      ).run(course.seriesKey, course.round, course.startPosition, classId);
    }
    insertLessons(db, classId, generated, plan.positions);
    db.exec("commit");
    return generated.length;
  }
  catch (error) { db.exec("rollback"); throw error; }
}

export function updateFutureCadence(
  db: DatabaseSync,
  classId: number,
  cadenceMode: CadenceMode,
  options: { manageTransaction?: boolean; freezeStarted?: boolean } = {}
): void {
  const manageTransaction = options.manageTransaction ?? true;
  if (options.freezeStarted !== false) freezeStartedLessons(db, classId);
  const rows = lessonRows(db, classId);
  const firstFutureIndex = rows.findIndex((lesson) => !lesson.frozenAt);
  if (manageTransaction) db.exec("begin immediate");
  try {
    db.prepare("update classes set cadence_mode = ?, updated_at = current_timestamp where id = ?").run(cadenceMode, classId);
    if (firstFutureIndex >= 0) {
      const future = rows.slice(firstFutureIndex);
      const previous = rows[firstFutureIndex - 1];
      const firstDue = previous
        ? addDays(previous.classStudyDueDate, cadenceMode === "parallel_two_week" ? 14 : 7)
        : future[0].classStudyDueDate;
      const regenerated = generateSchedule({
        firstFinalDueDate: firstDue, count: future.length, cadenceMode, startSequence: future[0].sequence,
        lessonTypes: future.map((lesson) => lesson.lessonType), titles: future.map((lesson) => lesson.title)
      });
      const scheduled = applySavedBreaks(db, classId, regenerated);
      const update = db.prepare(
        `update lessons set cadence_mode = ?, outline_due_date = ?, group_study_due_date = ?,
          class_study_due_date = ?, updated_at = current_timestamp where id = ?`
      );
      scheduled.forEach((lesson, index) => update.run(
        lesson.cadenceMode, lesson.outlineDueDate, lesson.groupStudyDueDate, lesson.classStudyDueDate, future[index].id
      ));
    }
    if (manageTransaction) db.exec("commit");
  } catch (error) {
    if (manageTransaction) db.exec("rollback");
    throw error;
  }
}

export function patchLesson(db: DatabaseSync, classId: number, lessonId: number, patch: {
  title?: string; lessonType?: LessonType; classStudyDueDate?: string;
}, options: { allowLockedOverride?: boolean } = {}): void {
  freezeStartedLessons(db, classId);
  const rows = lessonRows(db, classId);
  const target = rows.find((lesson) => lesson.id === lessonId);
  if (!target) throw new Error("课次不存在");
  const hasAttendance = lessonHasRecordedAttendance(db, target.id);
  const scheduleLocked = lessonScheduleLocked(db, target);
  const changesType = patch.lessonType !== undefined && patch.lessonType !== target.lessonType;
  const changesDate = patch.classStudyDueDate !== undefined && patch.classStudyDueDate !== target.classStudyDueDate;
  if (!options.allowLockedOverride && scheduleLocked) throw new Error("本课已截止且已有考勤记录，课表已锁定，不能修改");
  if (hasAttendance && changesType) throw new Error("本课已有考勤记录，不能修改课次类型");
  const affectedByDateChange = changesDate ? rows.filter((lesson) => lesson.sequence >= target.sequence) : [];
  if (!options.allowLockedOverride && affectedByDateChange.some((lesson) => lessonScheduleLocked(db, lesson))) {
    throw new Error("本课或后续存在已截止且已有考勤的锁定课次，不能整体顺延");
  }
  db.exec("begin immediate");
  try {
    const rostersToReset = new Set<number>();
    if (changesType && target.frozenAt) rostersToReset.add(target.id);
    for (const lesson of affectedByDateChange) {
      if (lesson.frozenAt && !lessonHasRecordedAttendance(db, lesson.id)) rostersToReset.add(lesson.id);
    }
    for (const affectedLessonId of rostersToReset) resetUnattendedLessonRoster(db, affectedLessonId);
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error("课名不能为空");
      db.prepare("update lessons set title = ?, updated_at = current_timestamp where id = ?").run(patch.title.trim(), lessonId);
    }
    if (changesType) db.prepare("update lessons set lesson_type = ?, updated_at = current_timestamp where id = ?").run(patch.lessonType!, lessonId);
    if (changesDate) {
      const delta = Math.round((new Date(`${patch.classStudyDueDate}T00:00:00Z`).getTime() - new Date(`${target.classStudyDueDate}T00:00:00Z`).getTime()) / DAY_MS);
      const shifted = shiftScheduleFrom(rows, target.sequence, delta);
      const update = db.prepare(
        `update lessons set outline_due_date = ?, group_study_due_date = ?, class_study_due_date = ?,
          updated_at = current_timestamp where id = ?`
      );
      shifted.filter((lesson) => lesson.sequence >= target.sequence).forEach((lesson) => {
        const original = rows.find((row) => row.sequence === lesson.sequence)!;
        update.run(lesson.outlineDueDate, lesson.groupStudyDueDate, lesson.classStudyDueDate, original.id);
      });
    }
    db.exec("commit");
  } catch (error) { db.exec("rollback"); throw error; }
}

export function addScheduleBreak(
  db: DatabaseSync,
  classId: number,
  startsOn: string,
  weeks: number,
  reason: string,
  userId: number,
  options: { allowLockedOverride?: boolean } = {},
): void {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw new Error("暂停周数必须为1至52");
  freezeStartedLessons(db, classId);
  const originalRows = lessonRows(db, classId);
  let rows = originalRows;
  for (let index = 0; index < weeks; index += 1) rows = insertBreak(rows, addDays(startsOn, index * 7), reason).lessons as typeof rows;
  const changedLessons = rows.filter((lesson) => {
    const original = originalRows.find((row) => row.id === lesson.id)!;
    return lesson.outlineDueDate !== original.outlineDueDate
      || lesson.groupStudyDueDate !== original.groupStudyDueDate
      || lesson.classStudyDueDate !== original.classStudyDueDate;
  });
  if (!options.allowLockedOverride && changedLessons.some((lesson) => {
    const original = originalRows.find((row) => row.id === lesson.id)!;
    return lessonScheduleLocked(db, original);
  })) {
    throw new Error("暂停周影响到已截止且已有考勤的锁定课次，不能整体顺延");
  }
  db.exec("begin immediate");
  try {
    for (const lesson of changedLessons) {
      const original = originalRows.find((row) => row.id === lesson.id)!;
      if (original.frozenAt && !lessonHasRecordedAttendance(db, lesson.id)) resetUnattendedLessonRoster(db, lesson.id);
    }
    const update = db.prepare(
      `update lessons set outline_due_date = ?, group_study_due_date = ?, class_study_due_date = ?, updated_at = current_timestamp where id = ?`
    );
    rows.forEach((lesson) => {
      const original = originalRows.find((row) => row.sequence === lesson.sequence)!;
      update.run(lesson.outlineDueDate, lesson.groupStudyDueDate, lesson.classStudyDueDate, original.id);
    });
    db.prepare("insert into schedule_breaks (class_id, start_date, weeks, reason, created_by) values (?, ?, ?, ?, ?)").run(
      classId, startsOn, weeks, reason.trim() || "放假/暂停", userId
    );
    db.exec("commit");
  } catch (error) { db.exec("rollback"); throw error; }
}

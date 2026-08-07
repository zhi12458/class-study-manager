import type { DatabaseSync } from "node:sqlite";
import type { CadenceMode, LessonScheduleItem, LessonType } from "../../shared/types.js";
import { coursePlanForRange } from "../../shared/courseCatalog.js";
import { generateSchedule, insertBreak, shiftScheduleFrom } from "./schedule.js";
import { freezeStartedLessons } from "./roster.js";

const DAY_MS = 86_400_000;
const DEFAULT_GROUP_NAMES = ["第一组", "第二组", "第三组", "第四组", "第五组"];

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function lessonRows(db: DatabaseSync, classId: number): Array<LessonScheduleItem & { id: number; frozenAt: string | null }> {
  return db.prepare(
    `select id, sequence, title, lesson_type as lessonType, cadence_mode as cadenceMode,
            outline_due_date as outlineDueDate, group_study_due_date as groupStudyDueDate,
            class_study_due_date as classStudyDueDate, roster_frozen_at as frozenAt
       from lessons where class_id = ? order by sequence`
  ).all(classId) as unknown as Array<LessonScheduleItem & { id: number; frozenAt: string | null }>;
}

function insertLessons(db: DatabaseSync, classId: number, lessons: LessonScheduleItem[]): void {
  const insert = db.prepare(
    `insert into lessons
       (class_id, sequence, title, lesson_type, cadence_mode, outline_due_date, group_study_due_date, class_study_due_date)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const lesson of lessons) {
    insert.run(classId, lesson.sequence, lesson.title, lesson.lessonType, lesson.cadenceMode,
      lesson.outlineDueDate, lesson.groupStudyDueDate, lesson.classStudyDueDate);
  }
}

export function createClass(db: DatabaseSync, input: {
  name: string; counselorUserId: number; createdBy: number; groupCount: number;
  cadenceMode: CadenceMode; firstDueDate?: string; lessonCount?: number;
}): number {
  if (!input.name.trim()) throw new Error("班级名称必填");
  if (!Number.isInteger(input.groupCount) || input.groupCount < 1 || input.groupCount > 5) throw new Error("小组数必须为1至5");
  const counselor = db.prepare("select id from users where id = ? and can_counsel = 1 and active = 1").get(input.counselorUserId);
  if (!counselor) throw new Error("请选择有效的辅导员账号");
  db.exec("begin immediate");
  try {
    const result = db.prepare(
      `insert into classes (name, counselor_user_id, cadence_mode, created_by) values (?, ?, ?, ?)`
    ).run(input.name.trim(), input.counselorUserId, input.cadenceMode, input.createdBy);
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
  const cls = db.prepare("select cadence_mode as cadenceMode from classes where id = ?").get(classId) as { cadenceMode: CadenceMode };
  const existing = lessonRows(db, classId);
  if (existing.length === 0) throw new Error("请先设置第一课截止日");
  const last = existing.at(-1)!;
  const nextDue = addDays(last.classStudyDueDate, cls.cadenceMode === "parallel_two_week" ? 14 : 7);
  const generated = generateSchedule({
    firstFinalDueDate: nextDue, count, cadenceMode: cls.cadenceMode, startSequence: last.sequence + 1,
    ...coursePlanForRange(last.sequence + 1, count)
  });
  db.exec("begin immediate");
  try { insertLessons(db, classId, generated); db.exec("commit"); }
  catch (error) { db.exec("rollback"); throw error; }
  return generated.length;
}

export function setInitialSchedule(
  db: DatabaseSync,
  classId: number,
  firstDueDate: string,
  count = 50,
  cadenceOverride?: CadenceMode
): void {
  const existing = lessonRows(db, classId);
  if (existing.length > 0) throw new Error("课表已存在");
  const cls = db.prepare("select cadence_mode as cadenceMode from classes where id = ?").get(classId) as { cadenceMode: CadenceMode };
  const cadenceMode = cadenceOverride ?? cls.cadenceMode;
  const generated = generateSchedule({
    firstFinalDueDate: firstDueDate, count, cadenceMode,
    ...coursePlanForRange(1, count)
  });
  db.exec("begin immediate");
  try {
    if (cadenceOverride) {
      db.prepare("update classes set cadence_mode = ?, updated_at = current_timestamp where id = ?").run(cadenceOverride, classId);
    }
    insertLessons(db, classId, generated);
    db.exec("commit");
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
      const savedBreaks = db.prepare(
        `select start_date as startDate, weeks, reason
           from schedule_breaks
          where class_id = ?
          order by start_date, id`
      ).all(classId) as Array<{ startDate: string; weeks: number; reason: string }>;
      let scheduled = regenerated;
      const firstRegeneratedStageStart = addDays(regenerated[0].outlineDueDate, -6);
      for (const savedBreak of savedBreaks) {
        for (let week = 0; week < savedBreak.weeks; week += 1) {
          const weekStart = addDays(savedBreak.startDate, week * 7);
          if (addDays(weekStart, 6) < firstRegeneratedStageStart) continue;
          scheduled = insertBreak(scheduled, weekStart, savedBreak.reason).lessons;
        }
      }
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
}): void {
  freezeStartedLessons(db, classId);
  const rows = lessonRows(db, classId);
  const target = rows.find((lesson) => lesson.id === lessonId);
  if (!target) throw new Error("课次不存在");
  if (target.frozenAt && (patch.lessonType || patch.classStudyDueDate)) throw new Error("已开始课次不能修改类型或日期");
  db.exec("begin immediate");
  try {
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error("课名不能为空");
      db.prepare("update lessons set title = ?, updated_at = current_timestamp where id = ?").run(patch.title.trim(), lessonId);
    }
    if (patch.lessonType) db.prepare("update lessons set lesson_type = ?, updated_at = current_timestamp where id = ?").run(patch.lessonType, lessonId);
    if (patch.classStudyDueDate && patch.classStudyDueDate !== target.classStudyDueDate) {
      const delta = Math.round((new Date(`${patch.classStudyDueDate}T00:00:00Z`).getTime() - new Date(`${target.classStudyDueDate}T00:00:00Z`).getTime()) / DAY_MS);
      const shifted = shiftScheduleFrom(rows, target.sequence, delta);
      const update = db.prepare(
        `update lessons set outline_due_date = ?, group_study_due_date = ?, class_study_due_date = ?,
          updated_at = current_timestamp where id = ?`
      );
      shifted.filter((lesson) => lesson.sequence >= target.sequence).forEach((lesson) => {
        const original = rows.find((row) => row.sequence === lesson.sequence)!;
        if (original.frozenAt) throw new Error("不能移动已开始课次");
        update.run(lesson.outlineDueDate, lesson.groupStudyDueDate, lesson.classStudyDueDate, original.id);
      });
    }
    db.exec("commit");
  } catch (error) { db.exec("rollback"); throw error; }
}

export function addScheduleBreak(db: DatabaseSync, classId: number, startsOn: string, weeks: number, reason: string, userId: number): void {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw new Error("暂停周数必须为1至52");
  freezeStartedLessons(db, classId);
  let rows = lessonRows(db, classId);
  if (rows.some((row) => row.frozenAt && row.classStudyDueDate >= startsOn)) throw new Error("不能移动已开始课次");
  for (let index = 0; index < weeks; index += 1) rows = insertBreak(rows, addDays(startsOn, index * 7), reason).lessons as typeof rows;
  db.exec("begin immediate");
  try {
    const update = db.prepare(
      `update lessons set outline_due_date = ?, group_study_due_date = ?, class_study_due_date = ?, updated_at = current_timestamp where id = ?`
    );
    rows.forEach((lesson) => {
      const original = lessonRows(db, classId).find((row) => row.sequence === lesson.sequence)!;
      update.run(lesson.outlineDueDate, lesson.groupStudyDueDate, lesson.classStudyDueDate, original.id);
    });
    db.prepare("insert into schedule_breaks (class_id, start_date, weeks, reason, created_by) values (?, ?, ?, ?, ?)").run(
      classId, startsOn, weeks, reason.trim() || "放假/暂停", userId
    );
    db.exec("commit");
  } catch (error) { db.exec("rollback"); throw error; }
}

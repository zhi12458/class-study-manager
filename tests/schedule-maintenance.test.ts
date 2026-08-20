import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";
import { shanghaiToday } from "../src/server/services/roster.js";
import { startTestApi } from "./support/apiHarness.js";

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function addStudent(db: ReturnType<typeof openDatabase>, classId: number, name: string): number {
  const groupId = (db.prepare("select id from groups where class_id = ? order by sort_order limit 1").get(classId) as { id: number }).id;
  const personId = Number(db.prepare("insert into persons (name) values (?)").run(name).lastInsertRowid);
  const enrollmentId = Number(db.prepare(
    "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 1)"
  ).run(classId, personId).lastInsertRowid);
  db.prepare(
    "insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)"
  ).run(enrollmentId, groupId);
  return enrollmentId;
}

async function createScheduledClass(firstDueDate = "2099-01-10", count = 3) {
  const db = openDatabase(":memory:");
  const server = await startTestApi(db);
  const admin = server.client();
  expect((await admin.post("/auth/login", { identifier: "admin", password: "admin12345" })).status).toBe(200);
  const counselorAccount = await admin.post<{
    id: number; loginIdentifier: string; temporaryPassword: string;
  }>("/admin/counselors", {
    dharmaName: "课表测试辅导员",
    username: `schedule-test-${Math.random().toString(36).slice(2, 8)}`
  });
  expect(counselorAccount.status).toBe(200);
  const created = await admin.post<{ classId: number }>("/classes", {
    name: "课表维护测试班",
    counselorId: counselorAccount.body.id,
    groupCount: 1
  });
  expect(created.status).toBe(200);
  expect((await admin.post(`/classes/${created.body.classId}/schedule/generate`, {
    firstDueDate,
    count,
    cadenceMode: "same_week",
    seriesKey: "wisdom_life",
    startPosition: 1,
    round: 1
  })).status).toBe(200);
  const counselor = server.client();
  expect((await counselor.post("/auth/login", {
    identifier: counselorAccount.body.loginIdentifier,
    password: counselorAccount.body.temporaryPassword
  })).status).toBe(200);
  expect((await counselor.post("/auth/change-password", {
    currentPassword: counselorAccount.body.temporaryPassword,
    newPassword: "ScheduleCounselor!2026"
  })).status).toBe(200);
  return { db, server, admin, counselor, classId: created.body.classId };
}

describe("未来课表重建与课次插入", () => {
  it("删除未作用于重建课表的历史暂停周不会提前新课表", async () => {
    const { db, server, admin, classId } = await createScheduledClass("2099-01-10", 2);
    try {
      expect((await admin.post(`/classes/${classId}/breaks`, {
        date: "2099-01-04",
        reason: "旧课表暂停"
      })).status).toBe(200);
      const savedBreak = (await admin.get<{ breaks: Array<{ id: number }> }>(
        `/classes/${classId}/breaks`
      )).body.breaks[0];

      const rebuilt = await admin.post(`/classes/${classId}/schedule/rebuild-future`, {
        firstDueDate: "2099-03-14",
        count: 2,
        cadenceMode: "same_week",
        seriesKey: "wisdom_life",
        startPosition: 3,
        round: 1
      });
      expect(rebuilt.status).toBe(200);
      expect((db.prepare(
        "select applied_to_schedule as applied from schedule_breaks where id = ?"
      ).get(savedBreak.id) as { applied: number }).applied).toBe(0);

      const beforeDelete = (await admin.get<{ lessons: Array<{ classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons.map((lesson) => lesson.classStudyDueDate);
      expect(beforeDelete).toEqual(["2099-03-14", "2099-03-21"]);

      const deleted = await admin.delete<{ affectedLessonCount: number }>(
        `/classes/${classId}/breaks/${savedBreak.id}`
      );
      expect(deleted.status).toBe(200);
      expect(deleted.body.affectedLessonCount).toBe(0);
      const afterDelete = (await admin.get<{ lessons: Array<{ classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons.map((lesson) => lesson.classStudyDueDate);
      expect(afterDelete).toEqual(beforeDelete);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("历史暂停移入新课表范围后才生效，删除后恢复原日期", async () => {
    const { db, server, admin, classId } = await createScheduledClass("2099-01-10", 2);
    try {
      expect((await admin.post(`/classes/${classId}/breaks`, {
        date: "2099-01-04",
        reason: "待调整暂停"
      })).status).toBe(200);
      const savedBreak = (await admin.get<{ breaks: Array<{ id: number }> }>(
        `/classes/${classId}/breaks`
      )).body.breaks[0];
      expect((await admin.post(`/classes/${classId}/schedule/rebuild-future`, {
        firstDueDate: "2099-03-14",
        count: 2,
        cadenceMode: "same_week",
        seriesKey: "wisdom_life",
        startPosition: 3,
        round: 1
      })).status).toBe(200);

      const edited = await admin.patch<{ affectedLessonCount: number }>(
        `/classes/${classId}/breaks/${savedBreak.id}`,
        { date: "2099-03-08", weeks: 1, reason: "新课表暂停" }
      );
      expect(edited.status).toBe(200);
      expect(edited.body.affectedLessonCount).toBe(2);
      expect((db.prepare(
        "select applied_to_schedule as applied from schedule_breaks where id = ?"
      ).get(savedBreak.id) as { applied: number }).applied).toBe(1);
      expect((await admin.get<{ lessons: Array<{ classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons.map((lesson) => lesson.classStudyDueDate)).toEqual(["2099-03-21", "2099-03-28"]);

      expect((await admin.delete(`/classes/${classId}/breaks/${savedBreak.id}`)).status).toBe(200);
      expect((await admin.get<{ lessons: Array<{ classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons.map((lesson) => lesson.classStudyDueDate)).toEqual(["2099-03-14", "2099-03-21"]);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("支持修改和删除暂停周，并按创建顺序重算多个暂停对课表的影响", async () => {
    const { db, server, admin, classId } = await createScheduledClass("2099-01-10", 3);
    try {
      expect((await admin.post(`/classes/${classId}/breaks`, { date: "2099-01-04", reason: "第一次暂停" })).status).toBe(200);
      expect((await admin.post(`/classes/${classId}/breaks`, { date: "2099-01-11", reason: "第二次暂停" })).status).toBe(200);
      const before = (await admin.get<{
        lessons: Array<{ classStudyDueDate: string }>;
        breaks: Array<{ id: number; startDate: string }>;
      }>(`/classes/${classId}/lessons`)).body;
      expect(before.lessons.map((lesson) => lesson.classStudyDueDate)).toEqual(["2099-01-24", "2099-01-31", "2099-02-07"]);

      const firstBreak = before.breaks.find((item) => item.startDate === "2099-01-04")!;
      expect((await admin.delete(`/classes/${classId}/breaks/${firstBreak.id}`)).status).toBe(200);
      const afterDelete = (await admin.get<{
        lessons: Array<{ classStudyDueDate: string }>;
        breaks: Array<{ id: number; startDate: string }>;
      }>(`/classes/${classId}/lessons`)).body;
      expect(afterDelete.lessons.map((lesson) => lesson.classStudyDueDate)).toEqual(["2099-01-10", "2099-01-24", "2099-01-31"]);

      const remainingBreak = afterDelete.breaks[0];
      const edited = await admin.patch<{ affectedLessonCount: number }>(`/classes/${classId}/breaks/${remainingBreak.id}`, {
        date: "2099-01-18",
        weeks: 1,
        reason: "调整后的暂停周"
      });
      expect(edited.status).toBe(200);
      expect(edited.body.affectedLessonCount).toBe(1);
      const afterEdit = (await admin.get<{
        lessons: Array<{ classStudyDueDate: string }>;
        breaks: Array<{ startDate: string; reason: string }>;
      }>(`/classes/${classId}/lessons`)).body;
      expect(afterEdit.lessons.map((lesson) => lesson.classStudyDueDate)).toEqual(["2099-01-10", "2099-01-17", "2099-01-31"]);
      expect(afterEdit.breaks).toEqual([
        expect.objectContaining({ startDate: "2099-01-18", reason: "调整后的暂停周" })
      ]);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("本周已开始但无考勤的暂停周仍允许辅导员修改和删除", async () => {
    const dueDate = addDays(shanghaiToday(), 2);
    const breakDate = addDays(shanghaiToday(), -3);
    const { db, server, counselor, classId } = await createScheduledClass(dueDate, 2);
    try {
      expect((await counselor.post(`/classes/${classId}/breaks`, { date: breakDate, reason: "本周暂停" })).status).toBe(200);
      const savedBreak = (await counselor.get<{ breaks: Array<{ id: number }> }>(`/classes/${classId}/breaks`)).body.breaks[0];
      expect((await counselor.patch(`/classes/${classId}/breaks/${savedBreak.id}`, {
        date: breakDate,
        weeks: 1,
        reason: "本周暂停（已修改）"
      })).status).toBe(200);
      expect((await counselor.delete(`/classes/${classId}/breaks/${savedBreak.id}`)).status).toBe(200);
      expect((await counselor.get<{ breaks: unknown[] }>(`/classes/${classId}/breaks`)).body.breaks).toEqual([]);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("已过截止日且有考勤的受影响课次仍受保护，管理员二次确认后可调整且保留考勤", async () => {
    const originalDueDate = addDays(shanghaiToday(), -21);
    const breakDate = addDays(originalDueDate, -6);
    const { db, server, admin, counselor, classId } = await createScheduledClass(originalDueDate, 1);
    try {
      expect((await counselor.post(`/classes/${classId}/breaks`, { date: breakDate, reason: "历史暂停" })).status).toBe(200);
      const lesson = (await admin.get<{ lessons: Array<{ id: number }> }>(`/classes/${classId}/lessons`)).body.lessons[0];
      const groupId = (db.prepare("select id from groups where class_id = ? limit 1").get(classId) as { id: number }).id;
      const personId = Number(db.prepare("insert into persons (name) values ('暂停锁定学员')").run().lastInsertRowid);
      const enrollmentId = Number(db.prepare(
        "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 1)"
      ).run(classId, personId).lastInsertRowid);
      const rosterId = Number(db.prepare(
        `insert into lesson_roster (lesson_id, enrollment_id, student_name, group_id, group_name)
         values (?, ?, '暂停锁定学员', ?, '第一组')`
      ).run(lesson.id, enrollmentId, groupId).lastInsertRowid);
      db.prepare("update lessons set roster_frozen_at = current_timestamp where id = ?").run(lesson.id);
      const adminId = (db.prepare("select id from users where username = 'admin'").get() as { id: number }).id;
      db.prepare(
        `insert into attendance_entries (lesson_id, lesson_roster_id, metric, status, modified_by)
         values (?, ?, 'outline', 'yes', ?)`
      ).run(lesson.id, rosterId, adminId);
      const savedBreak = (await admin.get<{ breaks: Array<{ id: number }> }>(`/classes/${classId}/breaks`)).body.breaks[0];

      const counselorDenied = await counselor.delete<{ error: string }>(`/classes/${classId}/breaks/${savedBreak.id}`);
      expect(counselorDenied.status).toBe(400);
      expect(counselorDenied.body.error).toContain("锁定课次");
      const adminNeedsConfirmation = await admin.delete<{ error: string }>(`/classes/${classId}/breaks/${savedBreak.id}`);
      expect(adminNeedsConfirmation.status).toBe(409);
      expect(adminNeedsConfirmation.body.error).toContain("管理员确认后");
      expect((await admin.delete(`/classes/${classId}/breaks/${savedBreak.id}`, { confirmLockedImpact: true })).status).toBe(200);
      expect((db.prepare("select count(*) as count from attendance_entries where lesson_id = ?").get(lesson.id) as { count: number }).count).toBe(1);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("允许修改已经进入本周但尚无考勤记录的课次", async () => {
    const originalDueDate = addDays(shanghaiToday(), 2);
    const { db, server, admin, classId } = await createScheduledClass(originalDueDate, 2);
    try {
      const before = (await admin.get<{
        lessons: Array<{ id: number; started: boolean; scheduleEditable: boolean; classStudyDueDate: string }>;
      }>(`/classes/${classId}/lessons`)).body.lessons;
      expect(before[0]).toMatchObject({ started: true, scheduleEditable: true, classStudyDueDate: originalDueDate });

      const nextDueDate = addDays(originalDueDate, 1);
      const edited = await admin.patch<{ ok: boolean }>(`/classes/${classId}/lessons/${before[0].id}`, {
        title: "本周尚无考勤，可调整",
        lessonType: "regular",
        classStudyDueDate: nextDueDate
      });
      expect(edited.status).toBe(200);
      expect(db.prepare("select roster_frozen_at as frozenAt from lessons where id = ?").get(before[0].id)).toEqual({ frozenAt: null });

      const after = (await admin.get<{
        lessons: Array<{ title: string; scheduleEditable: boolean; classStudyDueDate: string }>;
      }>(`/classes/${classId}/lessons`)).body.lessons;
      expect(after[0]).toMatchObject({ title: "本周尚无考勤，可调整", scheduleEditable: true, classStudyDueDate: nextDueDate });
    } finally {
      await server.close();
      db.close();
    }
  });

  it("一次只插入用户指定的一个课次并顺延", async () => {
    const dueDate = addDays(shanghaiToday(), 2);
    const { db, server, admin, classId } = await createScheduledClass(dueDate, 2);
    try {
      addStudent(db, classId, "本周插课学员");
      const lesson = (await admin.get<{ lessons: Array<{ id: number }> }>(`/classes/${classId}/lessons`)).body.lessons[0];
      expect((await admin.get(`/classes/${classId}/attendance/${lesson.id}`)).status).toBe(200);
      const inserted = await admin.post<{ lessonId: number; sequence: number }>(`/classes/${classId}/lessons/insert`, {
        beforeLessonId: lesson.id,
        title: "慈心",
        lessonType: "regular",
        classStudyDueDate: dueDate
      });
      expect(inserted.status).toBe(200);
      expect(inserted.body.sequence).toBe(1);
      const lessons = (await admin.get<{ lessons: Array<{ title: string; classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      expect(lessons).toHaveLength(3);
      expect(lessons[0]).toMatchObject({ title: "慈心", classStudyDueDate: dueDate });
      expect(lessons.some((item) => item.title.includes("慈经"))).toBe(false);
      expect(lessons[1].classStudyDueDate).toBe(addDays(dueDate, 7));
      const insertedAttendance = await admin.get<{
        rows: Array<{ studentId: number; name: string }>;
      }>(`/classes/${classId}/attendance/${inserted.body.lessonId}`);
      expect(insertedAttendance.status).toBe(200);
      expect(insertedAttendance.body.rows).toEqual([
        expect.objectContaining({ name: "本周插课学员" }),
      ]);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("允许在本周尚无考勤时插入暂停周", async () => {
    const dueDate = addDays(shanghaiToday(), 2);
    const { db, server, admin, classId } = await createScheduledClass(dueDate, 2);
    try {
      addStudent(db, classId, "本周暂停学员");
      const lesson = (await admin.get<{ lessons: Array<{ id: number }> }>(`/classes/${classId}/lessons`)).body.lessons[0];
      expect((await admin.get(`/classes/${classId}/attendance/${lesson.id}`)).status).toBe(200);
      const paused = await admin.post(`/classes/${classId}/breaks`, {
        date: addDays(dueDate, -6),
        reason: "本周临时暂停"
      });
      expect(paused.status).toBe(200);
      const lessons = (await admin.get<{ lessons: Array<{ classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      expect(lessons[0].classStudyDueDate).toBe(addDays(dueDate, 7));
      expect((db.prepare("select roster_frozen_at as frozenAt from lessons where id = ?").get(lesson.id) as { frozenAt: string | null }).frozenAt).toBeNull();
    } finally {
      await server.close();
      db.close();
    }
  });

  it("允许从本周尚无考勤的课次开始重新生成", async () => {
    const dueDate = addDays(shanghaiToday(), 2);
    const { db, server, admin, classId } = await createScheduledClass(dueDate, 2);
    try {
      addStudent(db, classId, "本周重建学员");
      const lesson = (await admin.get<{ lessons: Array<{ id: number }> }>(`/classes/${classId}/lessons`)).body.lessons[0];
      expect((await admin.get(`/classes/${classId}/attendance/${lesson.id}`)).status).toBe(200);
      const rebuilt = await admin.post<{
        preservedCount: number; replacedCount: number; generatedCount: number;
      }>(`/classes/${classId}/schedule/rebuild-future`, {
        firstDueDate: addDays(dueDate, 1),
        count: 2,
        cadenceMode: "same_week",
        seriesKey: "wisdom_life",
        startPosition: 3,
        round: 1
      });
      expect(rebuilt.status).toBe(200);
      expect(rebuilt.body).toMatchObject({ preservedCount: 0, replacedCount: 2, generatedCount: 2 });
    } finally {
      await server.close();
      db.close();
    }
  });

  it("截止日当天已有考勤仍可改标题和日期，插入及暂停会保留考勤名单", async () => {
    const dueDate = shanghaiToday();
    const { db, server, admin, classId } = await createScheduledClass(dueDate, 2);
    try {
      const enrollmentId = addStudent(db, classId, "截止日考勤学员");
      const lesson = (await admin.get<{ lessons: Array<{ id: number }> }>(`/classes/${classId}/lessons`)).body.lessons[0];
      expect((await admin.get(`/classes/${classId}/attendance/${lesson.id}`)).status).toBe(200);
      expect((await admin.put(`/classes/${classId}/attendance/${lesson.id}`, {
        records: [{ studentId: enrollmentId, outline: "yes" }]
      })).status).toBe(200);

      const listed = (await admin.get<{
        lessons: Array<{
          id: number; hasRecordedAttendance: boolean; scheduleLocked: boolean;
          scheduleEditable: boolean; classStudyDueDate: string;
        }>;
      }>(`/classes/${classId}/lessons`)).body.lessons;
      expect(listed[0]).toMatchObject({
        hasRecordedAttendance: true,
        scheduleLocked: false,
        scheduleEditable: true,
        classStudyDueDate: dueDate
      });
      const rosterCountBefore = (db.prepare(
        "select count(*) as count from lesson_roster where lesson_id = ?"
      ).get(lesson.id) as { count: number }).count;
      const attendanceCountBefore = (db.prepare(
        "select count(*) as count from attendance_entries where lesson_id = ?"
      ).get(lesson.id) as { count: number }).count;
      const auditCountBefore = (db.prepare(
        "select count(*) as count from attendance_audit where lesson_id = ?"
      ).get(lesson.id) as { count: number }).count;

      const nextDueDate = addDays(dueDate, 1);
      expect((await admin.patch(`/classes/${classId}/lessons/${lesson.id}`, {
        title: "截止日已登记但仍可修正课名",
        lessonType: "regular",
        classStudyDueDate: nextDueDate
      })).status).toBe(200);
      const deniedTypeChange = await admin.patch<{ error: string }>(`/classes/${classId}/lessons/${lesson.id}`, {
        lessonType: "review"
      });
      expect(deniedTypeChange.status).toBe(400);
      expect(deniedTypeChange.body.error).toContain("不能修改课次类型");

      const inserted = await admin.post<{ lessonId: number }>(`/classes/${classId}/lessons/insert`, {
        beforeLessonId: lesson.id,
        title: "截止日插入课",
        lessonType: "regular",
        classStudyDueDate: nextDueDate
      });
      expect(inserted.status).toBe(200);
      const movedLesson = db.prepare(
        `select sequence, title, class_study_due_date as classStudyDueDate, roster_frozen_at as frozenAt
           from lessons where id = ?`
      ).get(lesson.id) as { sequence: number; title: string; classStudyDueDate: string; frozenAt: string | null };
      expect(movedLesson).toMatchObject({
        sequence: 2,
        title: "截止日已登记但仍可修正课名",
        classStudyDueDate: addDays(nextDueDate, 7)
      });
      expect(movedLesson.frozenAt).not.toBeNull();
      expect((db.prepare("select count(*) as count from lesson_roster where lesson_id = ?").get(lesson.id) as { count: number }).count)
        .toBe(rosterCountBefore);
      expect((db.prepare("select count(*) as count from attendance_entries where lesson_id = ?").get(lesson.id) as { count: number }).count)
        .toBe(attendanceCountBefore);
      expect((db.prepare("select count(*) as count from attendance_audit where lesson_id = ?").get(lesson.id) as { count: number }).count)
        .toBe(auditCountBefore);

      expect((await admin.post(`/classes/${classId}/breaks`, {
        date: movedLesson.classStudyDueDate,
        reason: "截止日前考勤保留暂停"
      })).status).toBe(200);
      expect((db.prepare("select count(*) as count from lesson_roster where lesson_id = ?").get(lesson.id) as { count: number }).count)
        .toBe(rosterCountBefore);
      expect((db.prepare("select count(*) as count from attendance_entries where lesson_id = ?").get(lesson.id) as { count: number }).count)
        .toBe(attendanceCountBefore);
      expect((db.prepare("select count(*) as count from attendance_audit where lesson_id = ?").get(lesson.id) as { count: number }).count)
        .toBe(auditCountBefore);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("截止前删除或重建已有考勤课次必须显式确认并返回清除影响", async () => {
    const dueDate = shanghaiToday();

    const deleteSetup = await createScheduledClass(dueDate, 1);
    try {
      const enrollmentId = addStudent(deleteSetup.db, deleteSetup.classId, "删除确认学员");
      const lesson = (await deleteSetup.admin.get<{ lessons: Array<{ id: number }> }>(
        `/classes/${deleteSetup.classId}/lessons`
      )).body.lessons[0];
      expect((await deleteSetup.admin.get(`/classes/${deleteSetup.classId}/attendance/${lesson.id}`)).status).toBe(200);
      expect((await deleteSetup.admin.put(`/classes/${deleteSetup.classId}/attendance/${lesson.id}`, {
        records: [{ studentId: enrollmentId, outline: "yes" }]
      })).status).toBe(200);
      deleteSetup.db.prepare("delete from attendance_entries where lesson_id = ?").run(lesson.id);
      const auditOnlyState = (await deleteSetup.admin.get<{
        lessons: Array<{ id: number; hasRecordedAttendance: boolean; scheduleLocked: boolean }>;
      }>(`/classes/${deleteSetup.classId}/lessons`)).body.lessons[0];
      expect(auditOnlyState).toMatchObject({ hasRecordedAttendance: true, scheduleLocked: false });

      const denied = await deleteSetup.admin.delete<{ error: string }>(
        `/classes/${deleteSetup.classId}/lessons/${lesson.id}`
      );
      expect(denied.status).toBe(400);
      expect(denied.body.error).toContain("1个尚未截止课次");
      expect(denied.body.error).toContain("confirmDiscardAttendance=true");
      expect((deleteSetup.db.prepare("select count(*) as count from lessons where id = ?").get(lesson.id) as { count: number }).count).toBe(1);

      const deleted = await deleteSetup.admin.delete<{
        discardedAttendanceLessonCount: number;
        discardedAttendanceEntryCount: number;
        discardedAttendanceAuditCount: number;
      }>(`/classes/${deleteSetup.classId}/lessons/${lesson.id}`, { confirmDiscardAttendance: true });
      expect(deleted.status).toBe(200);
      expect(deleted.body).toMatchObject({
        discardedAttendanceLessonCount: 1,
        discardedAttendanceEntryCount: 0,
        discardedAttendanceAuditCount: 1
      });
      expect((deleteSetup.db.prepare("select count(*) as count from lessons where id = ?").get(lesson.id) as { count: number }).count).toBe(0);
      expect((deleteSetup.db.prepare("select count(*) as count from attendance_entries where lesson_id = ?").get(lesson.id) as { count: number }).count).toBe(0);
      expect((deleteSetup.db.prepare("select count(*) as count from attendance_audit where lesson_id = ?").get(lesson.id) as { count: number }).count).toBe(0);
    } finally {
      await deleteSetup.server.close();
      deleteSetup.db.close();
    }

    const rebuildSetup = await createScheduledClass(dueDate, 2);
    try {
      const enrollmentId = addStudent(rebuildSetup.db, rebuildSetup.classId, "重建确认学员");
      const lessons = (await rebuildSetup.admin.get<{ lessons: Array<{ id: number }> }>(
        `/classes/${rebuildSetup.classId}/lessons`
      )).body.lessons;
      expect((await rebuildSetup.admin.get(`/classes/${rebuildSetup.classId}/attendance/${lessons[0].id}`)).status).toBe(200);
      expect((await rebuildSetup.admin.put(`/classes/${rebuildSetup.classId}/attendance/${lessons[0].id}`, {
        records: [{ studentId: enrollmentId, outline: "yes" }]
      })).status).toBe(200);
      const rebuildBody = {
        firstDueDate: addDays(dueDate, 1),
        count: 2,
        cadenceMode: "same_week",
        seriesKey: "wisdom_life",
        startPosition: 3,
        round: 1
      };
      const denied = await rebuildSetup.admin.post<{ error: string }>(
        `/classes/${rebuildSetup.classId}/schedule/rebuild-future`, rebuildBody
      );
      expect(denied.status).toBe(400);
      expect(denied.body.error).toContain("confirmDiscardAttendance=true");
      expect((rebuildSetup.db.prepare("select count(*) as count from lessons where id = ?").get(lessons[0].id) as { count: number }).count).toBe(1);

      const rebuilt = await rebuildSetup.admin.post<{
        discardedAttendanceLessonCount: number;
        discardedAttendanceEntryCount: number;
        discardedAttendanceAuditCount: number;
      }>(`/classes/${rebuildSetup.classId}/schedule/rebuild-future`, {
        ...rebuildBody,
        confirmDiscardAttendance: true
      });
      expect(rebuilt.status).toBe(200);
      expect(rebuilt.body).toMatchObject({
        discardedAttendanceLessonCount: 1,
        discardedAttendanceEntryCount: 1,
        discardedAttendanceAuditCount: 1
      });
      expect((rebuildSetup.db.prepare("select count(*) as count from lessons where id = ?").get(lessons[0].id) as { count: number }).count).toBe(0);
      expect((rebuildSetup.db.prepare("select count(*) as count from attendance_entries where lesson_id = ?").get(lessons[0].id) as { count: number }).count).toBe(0);
      expect((rebuildSetup.db.prepare("select count(*) as count from attendance_audit where lesson_id = ?").get(lessons[0].id) as { count: number }).count).toBe(0);
    } finally {
      await rebuildSetup.server.close();
      rebuildSetup.db.close();
    }
  });

  it("截止日过后有实际考勤的课次全部锁定", async () => {
    const dueDate = addDays(shanghaiToday(), -1);
    const { db, server, admin, counselor, classId } = await createScheduledClass(dueDate, 2);
    try {
      const enrollmentId = addStudent(db, classId, "逾期锁定学员");
      const lessons = (await admin.get<{ lessons: Array<{ id: number }> }>(`/classes/${classId}/lessons`)).body.lessons;
      expect((await admin.get(`/classes/${classId}/attendance/${lessons[0].id}`)).status).toBe(200);
      expect((await admin.put(`/classes/${classId}/attendance/${lessons[0].id}`, {
        records: [{ studentId: enrollmentId, outline: "yes" }]
      })).status).toBe(200);
      db.prepare("delete from attendance_entries where lesson_id = ?").run(lessons[0].id);
      const counselorListed = (await counselor.get<{
        lessons: Array<{
          id: number; hasRecordedAttendance: boolean; scheduleLocked: boolean; scheduleEditable: boolean;
        }>;
      }>(`/classes/${classId}/lessons`)).body.lessons;
      expect(counselorListed[0]).toMatchObject({
        hasRecordedAttendance: true,
        scheduleLocked: true,
        scheduleEditable: false
      });
      expect((await counselor.patch(`/classes/${classId}/lessons/${lessons[0].id}`, {
        title: "不应修改锁定课"
      })).status).toBe(400);
      expect((await counselor.post(`/classes/${classId}/lessons/insert`, {
        beforeLessonId: lessons[0].id,
        title: "不应插入锁定课之前",
        lessonType: "regular",
        classStudyDueDate: dueDate
      })).status).toBe(400);
      expect((await counselor.post(`/classes/${classId}/breaks`, {
        date: dueDate,
        reason: "不应移动锁定课"
      })).status).toBe(400);
      expect((await counselor.delete(
        `/classes/${classId}/lessons/${lessons[0].id}?confirmDiscardAttendance=true`
      )).status).toBe(400);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("管理员可调整锁定课次但仍不能直接改变有考勤课次的类型", async () => {
    const dueDate = addDays(shanghaiToday(), -1);
    const { db, server, admin, classId } = await createScheduledClass(dueDate, 2);
    try {
      const enrollmentId = addStudent(db, classId, "管理员锁定课调整学员");
      const lessons = (await admin.get<{ lessons: Array<{ id: number }> }>(`/classes/${classId}/lessons`)).body.lessons;
      expect((await admin.get(`/classes/${classId}/attendance/${lessons[0].id}`)).status).toBe(200);
      expect((await admin.put(`/classes/${classId}/attendance/${lessons[0].id}`, {
        records: [{ studentId: enrollmentId, outline: "yes" }]
      })).status).toBe(200);
      const adminListed = (await admin.get<{
        lessons: Array<{
          id: number; hasRecordedAttendance: boolean; scheduleLocked: boolean; scheduleEditable: boolean;
        }>;
      }>(`/classes/${classId}/lessons`)).body.lessons;
      expect(adminListed[0]).toMatchObject({
        hasRecordedAttendance: true,
        scheduleLocked: true,
        scheduleEditable: true
      });
      const rosterCount = (db.prepare("select count(*) as count from lesson_roster where lesson_id = ?").get(lessons[0].id) as { count: number }).count;
      const entryCount = (db.prepare("select count(*) as count from attendance_entries where lesson_id = ?").get(lessons[0].id) as { count: number }).count;

      expect((await admin.patch(`/classes/${classId}/lessons/${lessons[0].id}`, {
        title: "管理员修正锁定课名"
      })).status).toBe(200);
      const deniedType = await admin.patch<{ error: string }>(`/classes/${classId}/lessons/${lessons[0].id}`, {
        lessonType: "review"
      });
      expect(deniedType.status).toBe(400);
      expect(deniedType.body.error).toContain("不能修改课次类型");

      const inserted = await admin.post<{ lessonId: number }>(`/classes/${classId}/lessons/insert`, {
        beforeLessonId: lessons[0].id,
        title: "管理员插入锁定课之前",
        lessonType: "regular",
        classStudyDueDate: dueDate
      });
      expect(inserted.status).toBe(200);
      expect((db.prepare("select count(*) as count from lesson_roster where lesson_id = ?").get(lessons[0].id) as { count: number }).count).toBe(rosterCount);
      expect((db.prepare("select count(*) as count from attendance_entries where lesson_id = ?").get(lessons[0].id) as { count: number }).count).toBe(entryCount);

      db.prepare(
        `update lessons
            set outline_due_date = ?, group_study_due_date = ?, class_study_due_date = ?
          where id = ?`
      ).run(dueDate, dueDate, dueDate, lessons[0].id);
      expect((await admin.post(`/classes/${classId}/breaks`, {
        date: dueDate,
        reason: "管理员顺延锁定课"
      })).status).toBe(200);
      expect((db.prepare("select count(*) as count from lesson_roster where lesson_id = ?").get(lessons[0].id) as { count: number }).count).toBe(rosterCount);
      expect((db.prepare("select count(*) as count from attendance_entries where lesson_id = ?").get(lessons[0].id) as { count: number }).count).toBe(entryCount);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("管理员删除或重建锁定考勤仍必须二次确认", async () => {
    const dueDate = addDays(shanghaiToday(), -1);

    const deleteSetup = await createScheduledClass(dueDate, 1);
    try {
      const enrollmentId = addStudent(deleteSetup.db, deleteSetup.classId, "管理员删除锁定课学员");
      const lesson = (await deleteSetup.admin.get<{ lessons: Array<{ id: number }> }>(
        `/classes/${deleteSetup.classId}/lessons`
      )).body.lessons[0];
      expect((await deleteSetup.admin.get(`/classes/${deleteSetup.classId}/attendance/${lesson.id}`)).status).toBe(200);
      expect((await deleteSetup.admin.put(`/classes/${deleteSetup.classId}/attendance/${lesson.id}`, {
        records: [{ studentId: enrollmentId, outline: "yes" }]
      })).status).toBe(200);
      const denied = await deleteSetup.admin.delete<{ error: string }>(
        `/classes/${deleteSetup.classId}/lessons/${lesson.id}`
      );
      expect(denied.status).toBe(400);
      expect(denied.body.error).toContain("confirmDiscardAttendance=true");
      const deleted = await deleteSetup.admin.delete<{ discardedAttendanceLessonCount: number }>(
        `/classes/${deleteSetup.classId}/lessons/${lesson.id}`,
        { confirmDiscardAttendance: true }
      );
      expect(deleted.status).toBe(200);
      expect(deleted.body.discardedAttendanceLessonCount).toBe(1);
    } finally {
      await deleteSetup.server.close();
      deleteSetup.db.close();
    }

    const rebuildSetup = await createScheduledClass(dueDate, 2);
    try {
      const enrollmentId = addStudent(rebuildSetup.db, rebuildSetup.classId, "管理员重建锁定课学员");
      const lessons = (await rebuildSetup.admin.get<{ lessons: Array<{ id: number }> }>(
        `/classes/${rebuildSetup.classId}/lessons`
      )).body.lessons;
      expect((await rebuildSetup.admin.get(`/classes/${rebuildSetup.classId}/attendance/${lessons[0].id}`)).status).toBe(200);
      expect((await rebuildSetup.admin.put(`/classes/${rebuildSetup.classId}/attendance/${lessons[0].id}`, {
        records: [{ studentId: enrollmentId, outline: "yes" }]
      })).status).toBe(200);
      const body = {
        firstDueDate: addDays(shanghaiToday(), 7),
        count: 2,
        cadenceMode: "same_week",
        seriesKey: "wisdom_life",
        startPosition: 4,
        round: 1
      };
      const denied = await rebuildSetup.admin.post<{ error: string }>(
        `/classes/${rebuildSetup.classId}/schedule/rebuild-future`, body
      );
      expect(denied.status).toBe(400);
      expect(denied.body.error).toContain("confirmDiscardAttendance=true");
      const rebuilt = await rebuildSetup.admin.post<{
        preservedCount: number; discardedAttendanceLessonCount: number;
      }>(`/classes/${rebuildSetup.classId}/schedule/rebuild-future`, {
        ...body,
        confirmDiscardAttendance: true
      });
      expect(rebuilt.status).toBe(200);
      expect(rebuilt.body).toMatchObject({ preservedCount: 0, discardedAttendanceLessonCount: 1 });
      expect((rebuildSetup.db.prepare("select count(*) as count from lessons where id = ?").get(lessons[0].id) as { count: number }).count).toBe(0);
    } finally {
      await rebuildSetup.server.close();
      rebuildSetup.db.close();
    }
  });

  it("复习课自动生成的不需要记录不会误锁课表", async () => {
    const dueDate = addDays(shanghaiToday(), 2);
    const { db, server, admin, classId } = await createScheduledClass(dueDate, 2);
    try {
      addStudent(db, classId, "复习课学员");
      const lesson = (await admin.get<{ lessons: Array<{ id: number }> }>(`/classes/${classId}/lessons`)).body.lessons[0];
      db.prepare("update lessons set lesson_type = 'review' where id = ?").run(lesson.id);
      expect((await admin.get(`/classes/${classId}/attendance/${lesson.id}`)).status).toBe(200);
      expect((db.prepare("select count(*) as count from attendance_entries where lesson_id = ?").get(lesson.id) as { count: number }).count).toBe(1);

      const listed = (await admin.get<{
        lessons: Array<{ id: number; scheduleEditable: boolean }>;
      }>(`/classes/${classId}/lessons`)).body.lessons;
      expect(listed[0].scheduleEditable).toBe(true);
      expect((await admin.patch(`/classes/${classId}/lessons/${lesson.id}`, {
        lessonType: "review",
        classStudyDueDate: addDays(dueDate, 1)
      })).status).toBe(200);
      expect((db.prepare("select count(*) as count from lesson_roster where lesson_id = ?").get(lesson.id) as { count: number }).count).toBe(0);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("已结束课次无考勤时也纳入重新生成", async () => {
    const { db, server, admin, classId } = await createScheduledClass();
    try {
      const before = (await admin.get<{ lessons: Array<{ id: number; title: string; classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      const historicalDueDate = "2020-01-10";
      db.prepare(
        `update lessons
            set outline_due_date = ?, group_study_due_date = ?, class_study_due_date = ?, roster_frozen_at = current_timestamp
          where id = ?`
      ).run(historicalDueDate, historicalDueDate, historicalDueDate, before[0].id);

      const rebuilt = await admin.post<{
        preservedCount: number;
        replacedCount: number;
        generatedCount: number;
        firstFutureSequence: number;
      }>(`/classes/${classId}/schedule/rebuild-future`, {
        firstDueDate: "2099-02-14",
        count: 2,
        cadenceMode: "parallel_two_week",
        seriesKey: "wisdom_life",
        startPosition: 5,
        round: 2
      });
      expect(rebuilt.status).toBe(200);
      expect(rebuilt.body).toEqual({
        preservedCount: 0,
        replacedCount: 3,
        generatedCount: 2,
        firstFutureSequence: 1,
        discardedAttendanceLessonCount: 0,
        discardedAttendanceEntryCount: 0,
        discardedAttendanceAuditCount: 0
      });

      const after = (await admin.get<{ lessons: Array<{ id: number; lessonNumber: number; title: string; classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      expect(after).toHaveLength(2);
      expect(after.map((lesson) => lesson.lessonNumber)).toEqual([1, 2]);
      expect(after[0].classStudyDueDate).toBe("2099-02-14");
      expect(after[0].id).not.toBe(before[0].id);
      expect(after[0].title).not.toBe(before[0].title);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("已结束课次只要无实际考勤也可编辑和插入", async () => {
    const { db, server, admin, classId } = await createScheduledClass("2099-01-10", 2);
    try {
      const before = (await admin.get<{ lessons: Array<{ id: number; title: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      db.prepare(
        `update lessons
            set outline_due_date = '2020-01-10', group_study_due_date = '2020-01-10',
                class_study_due_date = '2020-01-10', roster_frozen_at = current_timestamp
          where id = ?`
      ).run(before[0].id);

      const listed = (await admin.get<{
        lessons: Array<{
          id: number; hasRecordedAttendance: boolean; scheduleLocked: boolean; scheduleEditable: boolean;
        }>;
      }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      expect(listed[0]).toMatchObject({
        hasRecordedAttendance: false,
        scheduleLocked: false,
        scheduleEditable: true
      });
      expect((await admin.patch(`/classes/${classId}/lessons/${before[0].id}`, {
        title: "历史无考勤课次已修正",
        lessonType: "regular",
        classStudyDueDate: "2020-01-11"
      })).status).toBe(200);

      const inserted = await admin.post<{ lessonId: number }>(`/classes/${classId}/lessons/insert`, {
        beforeLessonId: before[0].id,
        title: "慈心",
        lessonType: "regular",
        classStudyDueDate: "2020-01-04"
      });
      expect(inserted.status).toBe(200);
      const after = (await admin.get<{ lessons: Array<{ title: string }> }>(`/classes/${classId}/lessons`)).body.lessons;
      expect(after).toHaveLength(3);
      expect(after[0].title).toBe("慈心");
      expect(after.filter((lesson) => lesson.title === "慈心")).toHaveLength(1);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("删除无考勤的历史课次时保留后续编号，删除未来课次时才前移编号", async () => {
    const { db, server, admin, classId } = await createScheduledClass("2099-01-10", 4);
    try {
      const original = (await admin.get<{ lessons: Array<{ id: number; lessonNumber: number }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      db.prepare(
        `update lessons
            set outline_due_date = '2020-01-10', group_study_due_date = '2020-01-10',
                class_study_due_date = '2020-01-10', roster_frozen_at = current_timestamp
          where id = ?`
      ).run(original[0].id);

      const historicalDelete = await admin.delete<{ renumberedFutureLessons: boolean }>(
        `/classes/${classId}/lessons/${original[0].id}`
      );
      expect(historicalDelete.status).toBe(200);
      expect(historicalDelete.body.renumberedFutureLessons).toBe(false);
      let remaining = (await admin.get<{ lessons: Array<{ id: number; lessonNumber: number }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      expect(remaining.map((lesson) => lesson.lessonNumber)).toEqual([2, 3, 4]);

      const futureEnrollmentId = addStudent(db, classId, "未来生效边界学员");
      db.prepare("update enrollments set active_from_sequence = 4 where id = ?").run(futureEnrollmentId);
      db.prepare("update group_assignments set effective_from_sequence = 4 where enrollment_id = ?").run(futureEnrollmentId);
      db.prepare("update enrollment_status_history set effective_from_sequence = 4 where enrollment_id = ?").run(futureEnrollmentId);

      const futureDelete = await admin.delete<{ renumberedFutureLessons: boolean }>(
        `/classes/${classId}/lessons/${remaining[1].id}`
      );
      expect(futureDelete.status).toBe(200);
      expect(futureDelete.body.renumberedFutureLessons).toBe(true);
      remaining = (await admin.get<{ lessons: Array<{ id: number; lessonNumber: number }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      expect(remaining.map((lesson) => lesson.lessonNumber)).toEqual([2, 3]);
      expect(db.prepare(
        `select e.active_from_sequence as activeFrom, ga.effective_from_sequence as groupFrom,
                es.effective_from_sequence as statusFrom
           from enrollments e
           join group_assignments ga on ga.enrollment_id = e.id
           join enrollment_status_history es on es.enrollment_id = e.id
          where e.id = ?`
      ).get(futureEnrollmentId)).toEqual({ activeFrom: 3, groupFrom: 3, statusFrom: 3 });
    } finally {
      await server.close();
      db.close();
    }
  });

  it("删除未来课次不会把只在该课生效的学籍压成无效区间", async () => {
    const { db, server, admin, classId } = await createScheduledClass("2099-01-10", 3);
    try {
      const enrollmentId = addStudent(db, classId, "单课学籍学员");
      db.prepare(
        "update enrollments set active_from_sequence = 2, inactive_from_sequence = 3 where id = ?"
      ).run(enrollmentId);
      db.prepare(
        "update group_assignments set effective_from_sequence = 2, effective_to_sequence = 3 where enrollment_id = ?"
      ).run(enrollmentId);
      db.prepare(
        "update enrollment_status_history set effective_from_sequence = 2, effective_to_sequence = 3 where enrollment_id = ?"
      ).run(enrollmentId);
      const lessons = (await admin.get<{ lessons: Array<{ id: number; lessonNumber: number }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;

      const denied = await admin.delete<{ error: string }>(`/classes/${classId}/lessons/${lessons[1].id}`);
      expect(denied.status).toBe(400);
      expect(denied.body.error).toContain("学籍只在本课生效");
      expect(denied.body.error).toContain("先调整");
      expect((await admin.get<{ lessons: Array<{ lessonNumber: number }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons.map((lesson) => lesson.lessonNumber)).toEqual([1, 2, 3]);
      expect(db.prepare(
        "select active_from_sequence as activeFrom, inactive_from_sequence as inactiveFrom from enrollments where id = ?"
      ).get(enrollmentId)).toEqual({ activeFrom: 2, inactiveFrom: 3 });
    } finally {
      await server.close();
      db.close();
    }
  });

  it("只重建最后一个已锁定课次之后的连续可调整后缀", async () => {
    const { db, server, admin, counselor, classId } = await createScheduledClass();
    try {
      const before = (await admin.get<{
        lessons: Array<{ id: number; lessonNumber: number; title: string }>;
      }>(`/classes/${classId}/lessons`)).body.lessons;
      const lessonId = before[1].id;
      const lockedDueDate = addDays(shanghaiToday(), -1);
      db.prepare(
        `update lessons
            set outline_due_date = ?, group_study_due_date = ?, class_study_due_date = ?,
                roster_frozen_at = current_timestamp
          where id = ?`
      ).run(lockedDueDate, lockedDueDate, lockedDueDate, lessonId);
      const groupId = (db.prepare("select id from groups where class_id = ? limit 1").get(classId) as { id: number }).id;
      const personId = Number(db.prepare("insert into persons (name) values ('未来考勤学员')").run().lastInsertRowid);
      const enrollmentId = Number(db.prepare(
        "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 1)"
      ).run(classId, personId).lastInsertRowid);
      const rosterId = Number(db.prepare(
        `insert into lesson_roster (lesson_id, enrollment_id, student_name, group_id, group_name)
         values (?, ?, '未来考勤学员', ?, '第一组')`
      ).run(lessonId, enrollmentId, groupId).lastInsertRowid);
      const adminId = (db.prepare("select id from users where username = 'admin'").get() as { id: number }).id;
      db.prepare(
        `insert into attendance_entries (lesson_id, lesson_roster_id, metric, status, modified_by)
         values (?, ?, 'outline', 'yes', ?)`
      ).run(lessonId, rosterId, adminId);

      const deniedInsert = await counselor.post<{ error: string }>(`/classes/${classId}/lessons/insert`, {
        beforeLessonId: before[0].id,
        title: "不应插到考勤课次之前",
        lessonType: "regular",
        classStudyDueDate: "2099-02-07"
      });
      expect(deniedInsert.status).toBe(400);
      expect(deniedInsert.body.error).toContain("最后一个已锁定课次之后");

      const rebuilt = await counselor.post<{
        preservedCount: number; replacedCount: number; generatedCount: number; firstFutureSequence: number;
      }>(`/classes/${classId}/schedule/rebuild-future`, {
        firstDueDate: "2099-02-14",
        count: 2,
        cadenceMode: "same_week",
        seriesKey: "wisdom_life",
        startPosition: 2,
        round: 1
      });
      expect(rebuilt.status).toBe(200);
      expect(rebuilt.body).toEqual({
        preservedCount: 2,
        replacedCount: 1,
        generatedCount: 2,
        firstFutureSequence: 3,
        discardedAttendanceLessonCount: 0,
        discardedAttendanceEntryCount: 0,
        discardedAttendanceAuditCount: 0
      });
      const after = (await counselor.get<{
        lessons: Array<{ id: number; lessonNumber: number; title: string; classStudyDueDate: string }>;
      }>(`/classes/${classId}/lessons`)).body.lessons;
      expect(after.map((lesson) => lesson.lessonNumber)).toEqual([1, 2, 3, 4]);
      expect(after[0]).toMatchObject({ id: before[0].id, title: before[0].title });
      expect(after[1]).toMatchObject({ id: before[1].id, title: before[1].title });
      expect(after[2].id).not.toBe(before[2].id);
      expect(after[2].classStudyDueDate).toBe("2099-02-14");
    } finally {
      await server.close();
      db.close();
    }
  });

  it("删空课表后重新生成仍会应用已保存的暂停周", async () => {
    const originalDueDate = "2099-01-10";
    const breakStartDate = "2099-01-04";
    const { db, server, admin, classId } = await createScheduledClass(originalDueDate, 1);
    try {
      expect((await admin.post(`/classes/${classId}/breaks`, {
        date: breakStartDate,
        reason: "保留的暂停周"
      })).status).toBe(200);
      const shiftedLesson = (await admin.get<{
        lessons: Array<{ id: number; classStudyDueDate: string }>;
      }>(`/classes/${classId}/lessons`)).body.lessons[0];
      expect(shiftedLesson.classStudyDueDate).toBe("2099-01-17");
      expect((await admin.delete(`/classes/${classId}/lessons/${shiftedLesson.id}`)).status).toBe(200);
      expect((await admin.get<{ lessons: unknown[] }>(`/classes/${classId}/lessons`)).body.lessons).toEqual([]);

      const generated = await admin.post<{ generatedCount: number }>(`/classes/${classId}/schedule/generate`, {
        firstDueDate: originalDueDate,
        count: 1,
        cadenceMode: "same_week",
        seriesKey: "wisdom_life",
        startPosition: 1,
        round: 1
      });
      expect(generated.status).toBe(200);
      expect(generated.body.generatedCount).toBe(1);
      const regenerated = (await admin.get<{
        lessons: Array<{ classStudyDueDate: string }>;
        breaks: Array<{ startDate: string; reason: string }>;
      }>(`/classes/${classId}/lessons`)).body;
      expect(regenerated.lessons[0].classStudyDueDate).toBe("2099-01-17");
      expect(regenerated.breaks).toEqual([
        expect.objectContaining({ startDate: breakStartDate, reason: "保留的暂停周" })
      ]);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("真正插入新课次并同步后移课表和下一课生效边界", async () => {
    const { db, server, admin, classId } = await createScheduledClass();
    try {
      const before = (await admin.get<{ lessons: Array<{ id: number; lessonNumber: number; title: string; classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      const personId = Number(db.prepare("insert into persons (name) values ('边界学员')").run().lastInsertRowid);
      const enrollmentId = Number(db.prepare(
        "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 2)"
      ).run(classId, personId).lastInsertRowid);
      db.prepare("update enrollment_status_history set effective_from_sequence = 2 where enrollment_id = ?").run(enrollmentId);

      const inserted = await admin.post<{ lessonId: number; sequence: number }>(`/classes/${classId}/lessons/insert`, {
        beforeLessonId: before[1].id,
        title: "插入测试课",
        lessonType: "regular",
        classStudyDueDate: before[1].classStudyDueDate
      });
      expect(inserted.status).toBe(200);
      expect(inserted.body.sequence).toBe(2);

      const after = (await admin.get<{ lessons: Array<{ id: number; lessonNumber: number; title: string; classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      expect(after.map((lesson) => lesson.lessonNumber)).toEqual([1, 2, 3, 4]);
      expect(after[1].title).toBe("插入测试课");
      expect(after[2].id).toBe(before[1].id);
      expect(after[2].classStudyDueDate).toBe("2099-01-24");
      expect((db.prepare("select active_from_sequence as sequence from enrollments where id = ?").get(enrollmentId) as { sequence: number }).sequence).toBe(3);
      expect((db.prepare(
        "select effective_from_sequence as sequence from enrollment_status_history where enrollment_id = ?"
      ).get(enrollmentId) as { sequence: number }).sequence).toBe(3);

      expect((await admin.post(`/classes/${classId}/lessons/append`, { count: 1 })).status).toBe(200);
      const appended = (await admin.get<{ lessons: Array<{ lessonNumber: number }> }>(`/classes/${classId}/lessons`)).body.lessons;
      expect(appended.map((lesson) => lesson.lessonNumber)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await server.close();
      db.close();
    }
  });
});

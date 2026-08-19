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
  const counselor = await admin.post<{ id: number }>("/admin/counselors", {
    dharmaName: "课表测试辅导员",
    username: `schedule-test-${Math.random().toString(36).slice(2, 8)}`
  });
  expect(counselor.status).toBe(200);
  const created = await admin.post<{ classId: number }>("/classes", {
    name: "课表维护测试班",
    counselorId: counselor.body.id,
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
  return { db, server, admin, classId: created.body.classId };
}

describe("未来课表重建与课次插入", () => {
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

  it("允许在本周尚无考勤时插入课次并顺延", async () => {
    const dueDate = addDays(shanghaiToday(), 2);
    const { db, server, admin, classId } = await createScheduledClass(dueDate, 2);
    try {
      addStudent(db, classId, "本周插课学员");
      const lesson = (await admin.get<{ lessons: Array<{ id: number }> }>(`/classes/${classId}/lessons`)).body.lessons[0];
      expect((await admin.get(`/classes/${classId}/attendance/${lesson.id}`)).status).toBe(200);
      const inserted = await admin.post<{ lessonId: number; sequence: number }>(`/classes/${classId}/lessons/insert`, {
        beforeLessonId: lesson.id,
        title: "本周插入课程",
        lessonType: "regular",
        classStudyDueDate: dueDate
      });
      expect(inserted.status).toBe(200);
      expect(inserted.body.sequence).toBe(1);
      const lessons = (await admin.get<{ lessons: Array<{ title: string; classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      expect(lessons).toHaveLength(3);
      expect(lessons[0]).toMatchObject({ title: "本周插入课程", classStudyDueDate: dueDate });
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

  it("已有人工考勤后锁定课表修改", async () => {
    const dueDate = addDays(shanghaiToday(), 2);
    const { db, server, admin, classId } = await createScheduledClass(dueDate, 2);
    try {
      const enrollmentId = addStudent(db, classId, "已有考勤学员");
      const lesson = (await admin.get<{ lessons: Array<{ id: number }> }>(`/classes/${classId}/lessons`)).body.lessons[0];
      expect((await admin.get(`/classes/${classId}/attendance/${lesson.id}`)).status).toBe(200);
      expect((await admin.put(`/classes/${classId}/attendance/${lesson.id}`, {
        records: [{ studentId: enrollmentId, outline: "yes" }]
      })).status).toBe(200);

      const listed = (await admin.get<{
        lessons: Array<{ id: number; scheduleEditable: boolean }>;
      }>(`/classes/${classId}/lessons`)).body.lessons;
      expect(listed[0].scheduleEditable).toBe(false);
      const denied = await admin.patch<{ error: string }>(`/classes/${classId}/lessons/${lesson.id}`, {
        lessonType: "regular",
        classStudyDueDate: addDays(dueDate, 1)
      });
      expect(denied.status).toBe(400);
      expect(denied.body.error).toContain("已有考勤记录");
      expect((await admin.post(`/classes/${classId}/lessons/insert`, {
        beforeLessonId: lesson.id,
        title: "不应插入",
        lessonType: "regular",
        classStudyDueDate: dueDate
      })).status).toBe(400);
      expect((await admin.post(`/classes/${classId}/breaks`, {
        date: addDays(dueDate, -6),
        reason: "不应暂停"
      })).status).toBe(400);
      const rebuiltAfterRecordedLesson = await admin.post<{
        preservedCount: number; replacedCount: number; generatedCount: number;
      }>(`/classes/${classId}/schedule/rebuild-future`, {
        firstDueDate: addDays(dueDate, 1),
        count: 2,
        cadenceMode: "same_week",
        seriesKey: "wisdom_life",
        startPosition: 3,
        round: 1
      });
      expect(rebuiltAfterRecordedLesson.status).toBe(200);
      expect(rebuiltAfterRecordedLesson.body).toMatchObject({ preservedCount: 1, replacedCount: 1, generatedCount: 2 });
    } finally {
      await server.close();
      db.close();
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

  it("保留已结束课次，只重新生成当前或未来的未登记部分", async () => {
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
      expect(rebuilt.body).toEqual({ preservedCount: 1, replacedCount: 2, generatedCount: 2, firstFutureSequence: 2 });

      const after = (await admin.get<{ lessons: Array<{ id: number; lessonNumber: number; title: string; classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      expect(after).toHaveLength(3);
      expect(after[0]).toMatchObject({ id: before[0].id, title: before[0].title, classStudyDueDate: historicalDueDate });
      expect(after.slice(1).map((lesson) => lesson.lessonNumber)).toEqual([2, 3]);
      expect(after[1].classStudyDueDate).toBe("2099-02-14");
      expect(after[1].title).not.toBe(before[1].title);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("未来课次已有考勤时拒绝重新生成", async () => {
    const { db, server, admin, classId } = await createScheduledClass();
    try {
      const lessonId = (db.prepare("select id from lessons where class_id = ? and sequence = 2").get(classId) as { id: number }).id;
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

      const rebuilt = await admin.post<{ error: string }>(`/classes/${classId}/schedule/rebuild-future`, {
        firstDueDate: "2099-02-14",
        count: 2,
        cadenceMode: "same_week",
        seriesKey: "wisdom_life",
        startPosition: 2,
        round: 1
      });
      expect(rebuilt.status).toBe(400);
      expect(rebuilt.body.error).toContain("已有考勤记录");
      expect((db.prepare("select count(*) as count from lessons where class_id = ?").get(classId) as { count: number }).count).toBe(3);
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

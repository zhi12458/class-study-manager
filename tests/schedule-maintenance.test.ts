import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";
import { startTestApi } from "./support/apiHarness.js";

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
  it("保留已开始课次，只重新生成未来部分", async () => {
    const { db, server, admin, classId } = await createScheduledClass();
    try {
      const before = (await admin.get<{ lessons: Array<{ id: number; title: string; classStudyDueDate: string }> }>(
        `/classes/${classId}/lessons`
      )).body.lessons;
      db.prepare("update lessons set roster_frozen_at = current_timestamp where id = ?").run(before[0].id);

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
      expect(after[0]).toMatchObject({ id: before[0].id, title: before[0].title, classStudyDueDate: before[0].classStudyDueDate });
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
      const lessonId = (db.prepare("select id from lessons where class_id = ? and sequence = 1").get(classId) as { id: number }).id;
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

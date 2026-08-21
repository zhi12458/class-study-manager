import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/db.js";
import { startTestApi } from "./support/apiHarness.js";

describe("拼音账号与课程起点", () => {
  it("允许仅法名的辅导员使用拼音账号，并从所选课程位置连续排课", async () => {
    const db = openDatabase(":memory:");
    const server = await startTestApi(db);
    const admin = server.client();
    try {
      expect((await admin.post("/auth/login", { identifier: "admin", password: "admin12345" })).status).toBe(200);
      const counselor = await admin.post<{ id: number; username: string; phone: null; temporaryPassword: string }>(
        "/admin/counselors",
        { name: "", dharmaName: "明觉", phone: "" }
      );
      expect(counselor.status).toBe(200);
      expect(counselor.body).toMatchObject({ username: "mingjue", phone: null });
      expect(counselor.body.temporaryPassword).toBeTruthy();

      const created = await admin.post<{ classId: number }>("/classes", {
        name: "课程起点测试班", counselorId: counselor.body.id, groupCount: 1
      });
      expect(created.status).toBe(200);
      const generated = await admin.post<{ generatedCount: number }>(`/classes/${created.body.classId}/schedule/generate`, {
        firstDueDate: "2026-08-09", cadenceMode: "same_week", count: 2,
        seriesKey: "wisdom_life", startPosition: 2, round: 1
      });
      expect(generated.body.generatedCount).toBe(2);
      expect((await admin.post(`/classes/${created.body.classId}/lessons/append`, { count: 2 })).status).toBe(200);
      const lessons = await admin.get<{ lessons: Array<{ lessonNumber: number; title: string }> }>(
        `/classes/${created.body.classId}/lessons`
      );
      expect(lessons.body.lessons.map((lesson) => lesson.lessonNumber)).toEqual([1, 2, 3, 4]);
      expect(lessons.body.lessons[0].title).toContain("当代宗教信仰");
      expect(lessons.body.lessons[2].title).toContain("人生五大问题");
    } finally {
      await server.close();
      db.close();
    }
  });

  it("当前课程结束后可选择下一套课程继续追加", async () => {
    const db = openDatabase(":memory:");
    const server = await startTestApi(db);
    const admin = server.client();
    try {
      expect((await admin.post("/auth/login", { identifier: "admin", password: "admin12345" })).status).toBe(200);
      const counselor = await admin.post<{ id: number }>("/admin/counselors", {
        dharmaName: "续课辅导员",
        username: "continue-course-counselor"
      });
      expect(counselor.status).toBe(200);
      const created = await admin.post<{ classId: number }>("/classes", {
        name: "跨课程追加测试班", counselorId: counselor.body.id, groupCount: 1
      });
      expect(created.status).toBe(200);
      expect((await admin.post(`/classes/${created.body.classId}/schedule/generate`, {
        firstDueDate: "2099-01-02", cadenceMode: "same_week", count: 1,
        seriesKey: "wisdom_life", startPosition: 50, round: 1
      })).status).toBe(200);

      db.prepare(
        `insert into course_catalog_series (key, display_name, source_name, sort_order)
         values ('next_course', '下一套课程', '下一套课程', 2)`
      ).run();
      db.prepare(
        `insert into course_catalog_items (series_key, position, title, lesson_type)
         values ('next_course', 1, '《下一套课程》第1课', 'regular')`
      ).run();

      const appended = await admin.post<{ generatedCount: number }>(
        `/classes/${created.body.classId}/lessons/append`,
        { count: 1, course: { seriesKey: "next_course", startPosition: 1, round: 1 } }
      );
      expect(appended.status).toBe(200);
      expect(appended.body.generatedCount).toBe(1);
      const lessons = await admin.get<{
        lessons: Array<{ title: string; coursePosition: number; classStudyDueDate: string }>;
      }>(`/classes/${created.body.classId}/lessons`);
      expect(lessons.body.lessons).toHaveLength(2);
      expect(lessons.body.lessons[1]).toMatchObject({
        title: "《下一套课程》第1课",
        coursePosition: 1,
        classStudyDueDate: "2099-01-09"
      });
      expect(db.prepare(
        `select course_series_key as seriesKey, course_start_position as startPosition, course_round as round
           from classes where id = ?`
      ).get(created.body.classId)).toEqual({ seriesKey: "next_course", startPosition: 1, round: 1 });
    } finally {
      await server.close();
      db.close();
    }
  });
});

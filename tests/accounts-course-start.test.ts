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
});

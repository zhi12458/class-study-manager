import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";
import { freezeLessonRoster } from "../src/server/services/roster.js";
import { startTestApi, type TestApiClient } from "./support/apiHarness.js";

async function withAdmin(run: (db: DatabaseSync, admin: TestApiClient) => Promise<void>) {
  const db = openDatabase(":memory:");
  const server = await startTestApi(db);
  const admin = server.client();
  try {
    expect((await admin.post("/auth/login", { identifier: "admin", password: "admin12345" })).status).toBe(200);
    const adminId = (db.prepare("select id from users where is_admin = 1").get() as { id: number }).id;
    db.prepare("update users set can_counsel = 1 where id = ?").run(adminId);
    await run(db, admin);
  } finally {
    await server.close();
    db.close();
  }
}

async function createClass(admin: TestApiClient, db: DatabaseSync, name: string) {
  const adminId = (db.prepare("select id from users where is_admin = 1").get() as { id: number }).id;
  const response = await admin.post<{ classId: number }>("/classes", { name, counselorId: adminId, groupCount: 1 });
  expect(response.status).toBe(200);
  return response.body.classId;
}

async function addStudent(admin: TestApiClient, classId: number, groupId: number, name: string, phone: string) {
  const response = await admin.post<{ studentId: number }>(`/classes/${classId}/students`, { name, phone, groupId });
  expect(response.status).toBe(200);
  return response.body.studentId;
}

function insertPastLesson(db: DatabaseSync, classId: number, sequence: number) {
  const result = db.prepare(
    `insert into lessons
      (class_id, sequence, title, lesson_type, cadence_mode, outline_due_date, group_study_due_date, class_study_due_date)
     values (?, ?, ?, 'regular', 'same_week', ?, ?, ?)`
  ).run(classId, sequence, `第${sequence}课`, `2026-07-${String(sequence).padStart(2, "0")}`,
    `2026-07-${String(sequence).padStart(2, "0")}`, `2026-07-${String(sequence).padStart(2, "0")}`);
  return Number(result.lastInsertRowid);
}

describe("学员状态、名册身份与班级状态", () => {
  it("只有课次当时为正常状态的学员进入完成率名册，休学后可以恢复且不改变历史", async () => {
    await withAdmin(async (db, admin) => {
      const classId = await createClass(admin, db, "状态统计班");
      const groupId = (await admin.get<{ groups: Array<{ id: number }> }>(`/classes/${classId}/groups`)).body.groups[0].id;
      const first = await addStudent(admin, classId, groupId, "正常学员", "13700001101");
      const second = await addStudent(admin, classId, groupId, "休学学员", "13700001102");

      const lesson1 = insertPastLesson(db, classId, 1);
      freezeLessonRoster(db, lesson1);
      expect((db.prepare("select count(*) as count from lesson_roster where lesson_id = ?").get(lesson1) as { count: number }).count).toBe(2);

      const leave = await admin.patch(`/classes/${classId}/students/${second}`, { status: "leave" });
      expect(leave.status).toBe(200);
      const lesson2 = insertPastLesson(db, classId, 2);
      freezeLessonRoster(db, lesson2);
      expect((db.prepare("select count(*) as count from lesson_roster where lesson_id = ?").get(lesson2) as { count: number }).count).toBe(1);
      expect(db.prepare("select 1 from lesson_roster where lesson_id = ? and enrollment_id = ?").get(lesson2, first)).toBeDefined();
      expect(db.prepare("select 1 from lesson_roster where lesson_id = ? and enrollment_id = ?").get(lesson2, second)).toBeUndefined();

      expect((await admin.patch(`/classes/${classId}/students/${second}`, { status: "normal" })).status).toBe(200);
      const lesson3 = insertPastLesson(db, classId, 3);
      freezeLessonRoster(db, lesson3);
      expect((db.prepare("select count(*) as count from lesson_roster where lesson_id = ?").get(lesson3) as { count: number }).count).toBe(2);

      const history = db.prepare(
        "select status, effective_from_sequence as fromSequence, effective_to_sequence as toSequence from enrollment_status_history where enrollment_id = ? order by effective_from_sequence"
      ).all(second);
      expect(history).toEqual([
        { status: "normal", fromSequence: 1, toSequence: 2 },
        { status: "leave", fromSequence: 2, toSequence: 3 },
        { status: "normal", fromSequence: 3, toSequence: null },
      ]);
    });
  });

  it("身份允许多选、班长自动同步，并限制每组只能有一名组长", async () => {
    await withAdmin(async (db, admin) => {
      const classId = await createClass(admin, db, "身份管理班");
      const groupId = (await admin.get<{ groups: Array<{ id: number }> }>(`/classes/${classId}/groups`)).body.groups[0].id;
      const first = await addStudent(admin, classId, groupId, "第一学员", "13700001103");
      const second = await addStudent(admin, classId, groupId, "第二学员", "13700001104");

      expect((await admin.patch(`/classes/${classId}/students/${first}`, {
        identities: ["group_leader", "charity", "communications"],
      })).status).toBe(200);
      const duplicateLeader = await admin.patch<{ error: string }>(`/classes/${classId}/students/${second}`, {
        identities: ["group_leader"],
      });
      expect(duplicateLeader.status).toBe(400);
      expect(duplicateLeader.body.error).toContain("已有组长");

      expect((await admin.put(`/classes/${classId}/monitor`, { studentId: first })).status).toBe(200);
      const roster = await admin.get<{ students: Array<{ studentId: number; identities: string[] }> }>(`/classes/${classId}/students`);
      expect(roster.body.students.find((student) => student.studentId === first)?.identities).toEqual([
        "monitor", "charity", "communications", "group_leader", "student",
      ]);
    });
  });

  it("管理员和辅导员可停用恢复班级，只有从未使用的空班级能永久删除", async () => {
    await withAdmin(async (db, admin) => {
      const emptyClass = await createClass(admin, db, "可删除空班");
      let listed = await admin.get<{ classes: Array<{ id: number; archived: number; deletable: number }> }>("/classes");
      expect(listed.body.classes.find((item) => item.id === emptyClass)).toMatchObject({ archived: 0, deletable: 1 });
      expect((await admin.patch(`/classes/${emptyClass}`, { archived: true })).status).toBe(200);
      expect((await admin.patch(`/classes/${emptyClass}`, { archived: false })).status).toBe(200);
      expect((await admin.json("DELETE", `/classes/${emptyClass}`)).status).toBe(200);

      const usedClass = await createClass(admin, db, "不可删除班");
      const groupId = (await admin.get<{ groups: Array<{ id: number }> }>(`/classes/${usedClass}/groups`)).body.groups[0].id;
      await addStudent(admin, usedClass, groupId, "已有学员", "13700001105");
      expect((await admin.json("DELETE", `/classes/${usedClass}`)).status).toBe(409);
      expect((await admin.patch(`/classes/${usedClass}`, { archived: true })).status).toBe(200);
      listed = await admin.get("/classes");
      expect(listed.body.classes.find((item) => item.id === usedClass)).toMatchObject({ archived: 1, deletable: 0 });
    });
  });
});

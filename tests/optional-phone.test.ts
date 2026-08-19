import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";
import { classifyRosterRows } from "../src/server/services/importRoster.js";
import { startTestApi, type TestApiClient } from "./support/apiHarness.js";

async function withAdmin(run: (db: DatabaseSync, admin: TestApiClient, client: () => TestApiClient) => Promise<void>) {
  const db = openDatabase(":memory:");
  const server = await startTestApi(db);
  const admin = server.client();
  try {
    expect((await admin.post("/auth/login", { identifier: "admin", password: "admin12345" })).status).toBe(200);
    await run(db, admin, server.client);
  } finally {
    await server.close();
    db.close();
  }
}

async function setupClass(admin: TestApiClient) {
  const counselor = await admin.post<{ id: number }>("/admin/counselors", {
    displayName: "手机号规则辅导员",
    phone: "13800003001",
  });
  expect(counselor.status).toBe(200);
  const createdClass = await admin.post<{ classId: number }>("/classes", {
    name: "手机号可选班",
    counselorId: counselor.body.id,
    groupCount: 1,
  });
  expect(createdClass.status).toBe(200);
  const groups = await admin.get<{ groups: Array<{ id: number; name: string }> }>(`/classes/${createdClass.body.classId}/groups`);
  return { classId: createdClass.body.classId, group: groups.body.groups[0] };
}

describe("普通学员手机号可选", () => {
  it("迁移后允许多个普通学员没有手机号，但手机号仍保持唯一", async () => {
    await withAdmin(async (db, admin) => {
      const columns = db.prepare("pragma table_info(persons)").all() as Array<{ name: string; notnull: number }>;
      expect(columns.find((column) => column.name === "phone")?.notnull).toBe(0);
      expect((db.prepare("select group_concat(version) as versions from schema_migrations").get() as { versions: string }).versions)
        .toBe("1,2,3,4,5,6,7,8,9,10,11,12,13,14");

      const { classId, group } = await setupClass(admin);
      const first = await admin.post<{ studentId: number }>(`/classes/${classId}/students`, {
        name: "无电话甲",
        groupId: group.id,
      });
      const second = await admin.post<{ studentId: number }>(`/classes/${classId}/students`, {
        name: "无电话乙",
        phone: "",
        groupId: group.id,
      });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const students = await admin.get<{ students: Array<{ studentId: number; phone: string | null }> }>(`/classes/${classId}/students`);
      expect(students.body.students.filter((student) => student.phone === null)).toHaveLength(2);

      expect((await admin.patch(`/classes/${classId}/students/${first.body.studentId}`, { phone: "13900003001" })).status).toBe(200);
      const duplicate = await admin.patch<{ error: string }>(`/classes/${classId}/students/${second.body.studentId}`, { phone: "13900003001" });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error).toContain("手机号");
    });
  });

  it("无手机号可用法名拼音账号担任班长，手机号之后仍可补充或清空", async () => {
    await withAdmin(async (_db, admin) => {
      const { classId, group } = await setupClass(admin);
      const student = await admin.post<{ studentId: number }>(`/classes/${classId}/students`, {
        name: "候选班长",
        dharmaName: "善学",
        groupId: group.id,
      });
      const assignedWithoutPhone = await admin.put<{ temporaryPassword: string; phone: null; username: string }>(`/classes/${classId}/monitor`, { studentId: student.body.studentId });
      expect(assignedWithoutPhone.status).toBe(200);
      expect(assignedWithoutPhone.body.phone).toBeNull();
      expect(assignedWithoutPhone.body.username).toBe("houxuanbanzhang");

      expect((await admin.patch(`/classes/${classId}/students/${student.body.studentId}`, {
        phone: "13900003002", currentPassword: "admin12345"
      })).status).toBe(200);
      const assigned = await admin.put<{ temporaryPassword: string; phone: string; username: string }>(`/classes/${classId}/monitor`, {
        studentId: student.body.studentId,
      });
      expect(assigned.status).toBe(200);
      expect(assigned.body.phone).toBe("+8613900003002");
      expect(assigned.body.username).toBe("houxuanbanzhang");

      const clear = await admin.patch<{ error: string }>(`/classes/${classId}/students/${student.body.studentId}`, {
        phone: "",
        currentPassword: "admin12345",
      });
      expect(clear.status).toBe(200);
    });
  });

  it("Excel 无电话行按姓名和法名匹配，同名同法名多人时提示冲突", async () => {
    await withAdmin(async (db, admin) => {
      const { classId, group } = await setupClass(admin);
      const existing = await admin.post<{ studentId: number }>(`/classes/${classId}/students`, {
        name: "无电话导入",
        dharmaName: "同法",
        phone: "13900003003",
        groupId: group.id,
        note: "旧备注",
      });
      expect(existing.status).toBe(200);

      const preview = classifyRosterRows(db, classId, [{
        rowNumber: 2,
        name: "无电话导入",
        dharmaName: "同法",
        phone: "",
        groupName: group.name,
        note: "新备注",
      }]);
      expect(preview[0]).toMatchObject({ action: "update", phone: "" });
      expect(preview[0].personId).toBeTypeOf("number");

      const submittedRows = preview.map(({ personId: _personId, ...row }) => row);
      expect((await admin.post(`/classes/${classId}/import/commit`, { rows: submittedRows })).status).toBe(200);
      const students = await admin.get<{ students: Array<{ studentId: number; phone: string | null; note: string | null }> }>(`/classes/${classId}/students`);
      expect(students.body.students.find((item) => item.studentId === existing.body.studentId)).toMatchObject({
        phone: "+8613900003003",
        note: "新备注",
      });

      db.prepare("insert into persons (name, dharma_name, phone) values ('无电话导入', '同法', null)").run();
      const duplicatePerson = db.prepare("select id from persons order by id desc limit 1").get() as { id: number };
      const duplicateEnrollment = db.prepare(
        "insert into enrollments (class_id, person_id, active_from_sequence) values (?, ?, 1)",
      ).run(classId, duplicatePerson.id);
      db.prepare("insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)")
        .run(Number(duplicateEnrollment.lastInsertRowid), group.id);

      const conflict = classifyRosterRows(db, classId, [{
        rowNumber: 2,
        name: "无电话导入",
        dharmaName: "同法",
        phone: "",
        groupName: group.name,
      }]);
      expect(conflict[0].action).toBe("conflict");
      expect(conflict[0].message).toContain("多名同名同法名");
    });
  });
});

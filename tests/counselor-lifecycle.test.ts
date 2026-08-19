import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";
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

async function createCounselor(admin: TestApiClient, name: string, phone: string) {
  const response = await admin.post<{ id: number; temporaryPassword: string; phone: string }>(
    "/admin/counselors",
    { displayName: name, phone },
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function createClass(admin: TestApiClient, name: string, counselorId: number) {
  const response = await admin.post<{ classId: number }>("/classes", { name, counselorId, groupCount: 1 });
  expect(response.status).toBe(200);
  return response.body.classId;
}

describe("辅导员、班长和学员生命周期", () => {
  it("从正常或休学学员启用辅导员资格并复用原账号和跨班身份", async () => {
    await withAdmin(async (db, admin, client) => {
      const owner = await createCounselor(admin, "原辅导员", "13800001020");
      const sourceClassId = await createClass(admin, "学员来源班", owner.id);
      const groups = await admin.get<{ groups: Array<{ id: number }> }>(`/classes/${sourceClassId}/groups`);
      const student = await admin.post<{ studentId: number }>(`/classes/${sourceClassId}/students`, {
        name: "复合学员",
        dharmaName: "善复",
        phone: "13800001021",
        groupId: groups.body.groups[0].id,
      });
      const assistant = await admin.post<{ userId: number; temporaryPassword: string; loginIdentifier: string }>(
        `/classes/${sourceClassId}/attendance-assistants`,
        { studentId: student.body.studentId },
      );
      expect(assistant.status).toBe(200);

      const candidates = await admin.get<{
        candidates: Array<{ personId: number; enrollmentId: number; className: string; status: string; identities: string[] }>;
      }>("/admin/counselor-candidates?query=%E5%96%84%E5%A4%8D");
      expect(candidates.status).toBe(200);
      const candidate = candidates.body.candidates.find((item) => item.enrollmentId === student.body.studentId);
      expect(candidate).toMatchObject({ className: "学员来源班", status: "normal" });
      expect(candidate?.identities).toEqual(expect.arrayContaining(["student", "attendance_assistant"]));
      if (!candidate) throw new Error("测试候选学员不存在");

      const promoted = await admin.post<{ id: number; temporaryPassword?: string; loginIdentifier: string }>(
        "/admin/counselors",
        { personId: candidate.personId, username: "不应改号", phone: "13900009999" },
      );
      expect(promoted.status).toBe(200);
      expect(promoted.body.id).toBe(assistant.body.userId);
      expect(promoted.body.temporaryPassword).toBeUndefined();
      expect(promoted.body.loginIdentifier).toBe(assistant.body.loginIdentifier);
      expect(db.prepare("select count(*) as count from persons where phone = ?").get("+8613800001021")).toEqual({ count: 1 });
      const counselorList = await admin.get<{
        counselors: Array<{ id: number; studentClassName: string | null; studentStatus: string | null }>;
      }>("/admin/counselors");
      expect(counselorList.body.counselors.find((item) => item.id === promoted.body.id)).toMatchObject({
        studentClassName: "学员来源班",
        studentStatus: "normal",
      });

      const targetClassId = await createClass(admin, "辅导目标班", promoted.body.id);
      const compositeClient = client();
      expect((await compositeClient.post("/auth/login", {
        identifier: assistant.body.loginIdentifier,
        password: assistant.body.temporaryPassword,
      })).status).toBe(200);
      const me = await compositeClient.get<{
        classAccesses: Array<{ classId: number; permission: string }>;
      }>("/auth/me");
      expect(me.body.classAccesses).toEqual(expect.arrayContaining([
        expect.objectContaining({ classId: sourceClassId, permission: "attendance_assistant" }),
        expect.objectContaining({ classId: targetClassId, permission: "counselor" }),
      ]));

      expect((await admin.patch(`/classes/${sourceClassId}`, { counselorId: promoted.body.id })).status).toBe(200);
      expect(db.prepare(
        "select 1 from class_attendance_assistants where class_id = ? and user_id = ?",
      ).get(sourceClassId, promoted.body.id)).toBeUndefined();
      expect(db.prepare(
        "select 1 from enrollments where id = ? and person_id = ?",
      ).get(student.body.studentId, candidate.personId)).toBeDefined();
      const afterTransfer = await compositeClient.get<{
        classAccesses: Array<{ classId: number; permission: string }>;
      }>("/auth/me");
      expect(afterTransfer.body.classAccesses.find((item) => item.classId === sourceClassId)?.permission).toBe("counselor");
      const redundantMonitor = await admin.put<{ error: string }>(`/classes/${sourceClassId}/monitor`, {
        studentId: student.body.studentId,
      });
      expect(redundantMonitor.status).toBe(409);
      expect(redundantMonitor.body.error).toContain("辅导员");
    });
  });

  it("辅导员候选只包含未归档班级的正常和休学学员，无账号学员才生成临时密码", async () => {
    await withAdmin(async (_db, admin, client) => {
      const owner = await createCounselor(admin, "候选班辅导员", "13800001030");
      const classId = await createClass(admin, "候选范围班", owner.id);
      const groups = await admin.get<{ groups: Array<{ id: number }> }>(`/classes/${classId}/groups`);
      const add = async (name: string) => (await admin.post<{ studentId: number }>(`/classes/${classId}/students`, {
        name, groupId: groups.body.groups[0].id,
      })).body.studentId;
      const leaveId = await add("休学候选");
      const withdrawnId = await add("退学候选");
      expect((await admin.patch(`/classes/${classId}/students/${leaveId}`, { status: "leave" })).status).toBe(200);
      expect((await admin.patch(`/classes/${classId}/students/${withdrawnId}`, { status: "withdrawn" })).status).toBe(200);

      const visible = await admin.get<{ candidates: Array<{ enrollmentId: number; personId: number; status: string }> }>(
        "/admin/counselor-candidates?query=%E5%80%99%E9%80%89",
      );
      expect(visible.body.candidates.map((item) => item.enrollmentId)).toContain(leaveId);
      expect(visible.body.candidates.map((item) => item.enrollmentId)).not.toContain(withdrawnId);
      const leave = visible.body.candidates.find((item) => item.enrollmentId === leaveId)!;
      expect(leave.status).toBe("leave");

      const promoted = await admin.post<{ temporaryPassword: string; loginIdentifier: string }>(
        "/admin/counselors",
        { personId: leave.personId },
      );
      expect(promoted.status).toBe(200);
      expect(promoted.body.temporaryPassword).toBeTruthy();
      expect(promoted.body.loginIdentifier).toMatch(/^[a-z0-9._-]+$/);
      expect((await client().post("/auth/login", {
        identifier: promoted.body.loginIdentifier,
        password: promoted.body.temporaryPassword,
      })).status).toBe(200);

      expect((await admin.patch(`/classes/${classId}`, { archived: true })).status).toBe(200);
      expect((await admin.get<{ candidates: unknown[] }>("/admin/counselor-candidates")).body.candidates).toHaveLength(0);
      expect((await admin.post<{ error: string }>("/admin/counselors", { personId: leave.personId })).status).toBe(400);
      expect((await client().get("/admin/counselor-candidates")).status).toBe(401);
    });
  });

  it("保留辅导员角色记录，并允许停用、恢复和删除从未使用的账号", async () => {
    await withAdmin(async (db, admin, client) => {
      const columns = db.prepare("pragma table_info(users)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "counselor_role")).toBe(true);

      const counselor = await createCounselor(admin, "待删辅导员", "13800001001");
      const before = await admin.get<{ counselors: Array<Record<string, unknown>> }>("/admin/counselors");
      expect(before.body.counselors.find((item) => item.id === counselor.id)).toMatchObject({
        active: true,
        activeClassCount: 0,
        deletable: true,
      });

      expect((await admin.patch(`/admin/counselors/${counselor.id}`, { active: false })).status).toBe(200);
      const stopped = await admin.get<{ counselors: Array<Record<string, unknown>> }>("/admin/counselors");
      expect(stopped.body.counselors.find((item) => item.id === counselor.id)).toMatchObject({
        active: false,
        accountActive: false,
      });
      expect((await client().post("/auth/login", {
        identifier: counselor.phone,
        password: counselor.temporaryPassword,
      })).status).toBe(401);

      expect((await admin.patch(`/admin/counselors/${counselor.id}`, { active: true })).status).toBe(200);
      expect((await client().post("/auth/login", {
        identifier: counselor.phone,
        password: counselor.temporaryPassword,
      })).status).toBe(200);

      expect((await admin.json("DELETE", `/admin/counselors/${counselor.id}`)).status).toBe(200);
      expect(db.prepare("select 1 from users where id = ?").get(counselor.id)).toBeUndefined();
      expect((await admin.get<{ counselors: Array<{ id: number }> }>("/admin/counselors")).body.counselors)
        .not.toContainEqual(expect.objectContaining({ id: counselor.id }));
    });
  });

  it("负责未归档班级时禁止停用，转交后立即撤销辅导员会话", async () => {
    await withAdmin(async (_db, admin, client) => {
      const first = await createCounselor(admin, "原辅导员", "13800001002");
      const second = await createCounselor(admin, "新辅导员", "13800001003");
      const classId = await createClass(admin, "转交测试班", first.id);
      const firstClient = client();
      expect((await firstClient.post("/auth/login", {
        identifier: first.phone,
        password: first.temporaryPassword,
      })).status).toBe(200);

      const blocked = await admin.patch<{ error: string }>(`/admin/counselors/${first.id}`, { active: false });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toContain("先转交班级");

      expect((await admin.patch(`/classes/${classId}`, { archived: true })).status).toBe(200);
      expect((await admin.patch(`/admin/counselors/${first.id}`, { active: false })).status).toBe(200);
      const me = await firstClient.get<{ user: unknown }>("/auth/me");
      expect(me.body.user).toBeNull();
      const invalidRestore = await admin.patch<{ error: string }>(`/classes/${classId}`, { archived: false });
      expect(invalidRestore.status).toBe(400);
      expect(invalidRestore.body.error).toContain("恢复原辅导员账号");
      expect((await admin.patch(`/classes/${classId}`, { archived: false, counselorId: second.id })).status).toBe(200);
      expect((await admin.json("DELETE", `/admin/counselors/${first.id}`)).status).toBe(409);
    });
  });

  it("停用辅导员不会误伤其班长身份，取消班长后立即失权并可移出学员", async () => {
    await withAdmin(async (_db, admin, client) => {
      const composite = await createCounselor(admin, "复合身份", "13800001004");
      const owner = await createCounselor(admin, "班级辅导员", "13800001005");
      const classId = await createClass(admin, "复合身份班", owner.id);
      const groups = await admin.get<{ groups: Array<{ id: number }> }>(`/classes/${classId}/groups`);
      const added = await admin.post<{ studentId: number }>(`/classes/${classId}/students`, {
        name: "复合身份",
        phone: composite.phone,
        groupId: groups.body.groups[0].id,
      });
      expect(added.status).toBe(200);
      expect((await admin.put(`/classes/${classId}/monitor`, { studentId: added.body.studentId })).status).toBe(200);

      const compositeClient = client();
      expect((await compositeClient.post("/auth/login", {
        identifier: composite.phone,
        password: composite.temporaryPassword,
      })).status).toBe(200);
      const stopped = await admin.patch<{ accountActive: boolean }>(`/admin/counselors/${composite.id}`, { active: false });
      expect(stopped.status).toBe(200);
      expect(stopped.body.accountActive).toBe(true);
      const me = await compositeClient.get<{
        user: { canCounsel: boolean };
        classAccesses: Array<{ classId: number; permission: string }>;
      }>("/auth/me");
      expect(me.body.user.canCounsel).toBe(false);
      expect(me.body.classAccesses).toEqual([{ classId, className: "复合身份班", permission: "monitor", archived: false }]);

      const whileMonitor = await admin.patch<{ error: string }>(`/classes/${classId}/students/${added.body.studentId}`, { active: false });
      expect(whileMonitor.status).toBe(400);
      expect(whileMonitor.body.error).toContain("先更换或取消班长");

      expect((await admin.json("DELETE", `/classes/${classId}/monitor`)).status).toBe(200);
      expect((await compositeClient.get<{ user: unknown }>("/auth/me")).body.user).toBeNull();
      expect((await admin.patch(`/classes/${classId}/students/${added.body.studentId}`, { active: false })).status).toBe(200);
      const students = await admin.get<{ students: Array<{ studentId: number; status: string }> }>(`/classes/${classId}/students`);
      expect(students.body.students.find((student) => student.studentId === added.body.studentId)?.status).toBe("withdrawn");
    });
  });
});

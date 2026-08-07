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
      const students = await admin.get<{ students: Array<{ studentId: number; active: boolean }> }>(`/classes/${classId}/students`);
      expect(students.body.students.find((student) => student.studentId === added.body.studentId)).toBeUndefined();
    });
  });
});

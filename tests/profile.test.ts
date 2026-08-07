import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";
import { startTestApi, type TestApiClient } from "./support/apiHarness.js";

async function withApi(run: (db: DatabaseSync, admin: TestApiClient, client: () => TestApiClient) => Promise<void>) {
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
  const response = await admin.post<{ id: number; phone: string; temporaryPassword: string }>(
    "/admin/counselors",
    { displayName: name, phone },
  );
  expect(response.status).toBe(200);
  return response.body;
}

describe("个人资料和账号手机号", () => {
  it("管理员保留 admin 登录名，可修改显示姓名和唯一联系电话", async () => {
    await withApi(async (db, admin) => {
      const columns = db.prepare("pragma table_info(users)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "contact_phone")).toBe(true);

      expect((await admin.patch("/auth/profile", { displayName: "值班管理员", phone: "" })).status).toBe(200);
      const missingPassword = await admin.patch<{ error: string }>("/auth/profile", {
        displayName: "值班管理员",
        phone: "13800002001",
      });
      expect(missingPassword.status).toBe(400);
      expect(missingPassword.body.error).toContain("当前密码");

      expect((await admin.patch("/auth/profile", {
        displayName: "值班管理员",
        phone: "13800002001",
        currentPassword: "admin12345",
      })).status).toBe(200);
      const me = await admin.get<{ user: { displayName: string; phone: string; username: string } }>("/auth/me");
      expect(me.body.user).toMatchObject({ displayName: "值班管理员", phone: "+8613800002001", username: "admin" });
      expect((await admin.post("/auth/login", { identifier: "admin", password: "admin12345" })).status).toBe(200);

      const duplicate = await admin.post<{ error: string }>("/admin/counselors", {
        displayName: "重复手机号",
        phone: "13800002001",
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error).toContain("手机号");
    });
  });

  it("辅导员可修改自己的姓名、法名和登录手机号，管理员也可代为修改", async () => {
    await withApi(async (_db, admin, client) => {
      const counselor = await createCounselor(admin, "原辅导员", "13800002002");
      const counselorClient = client();
      expect((await counselorClient.post("/auth/login", {
        identifier: counselor.phone,
        password: counselor.temporaryPassword,
      })).status).toBe(200);
      expect((await counselorClient.post("/auth/change-password", {
        currentPassword: counselor.temporaryPassword,
        newPassword: "Counselor!2026",
      })).status).toBe(200);

      expect((await counselorClient.patch("/auth/profile", {
        displayName: "新辅导员",
        dharmaName: "明心",
        phone: "13800002003",
        currentPassword: "Counselor!2026",
      })).status).toBe(200);
      expect((await client().post("/auth/login", {
        identifier: "13800002002",
        password: "Counselor!2026",
      })).status).toBe(401);
      expect((await client().post("/auth/login", {
        identifier: "13800002003",
        password: "Counselor!2026",
      })).status).toBe(200);

      const noPassword = await admin.patch<{ error: string }>(`/admin/counselors/${counselor.id}`, {
        displayName: "管理员代改",
        phone: "13800002004",
      });
      expect(noPassword.status).toBe(400);
      expect(noPassword.body.error).toContain("当前密码");
      expect((await admin.patch(`/admin/counselors/${counselor.id}`, {
        displayName: "管理员代改",
        dharmaName: "明心",
        phone: "13800002004",
        currentPassword: "admin12345",
      })).status).toBe(200);
      const list = await admin.get<{ counselors: Array<Record<string, unknown>> }>("/admin/counselors");
      expect(list.body.counselors.find((item) => item.id === counselor.id)).toMatchObject({
        displayName: "管理员代改",
        dharmaName: "明心",
        phone: "+8613800002004",
      });
    });
  });

  it("班长可修改自己的资料；辅导员不能改其登录手机号，管理员验证密码后可以", async () => {
    await withApi(async (_db, admin, client) => {
      const counselor = await createCounselor(admin, "负责辅导员", "13800002005");
      const createdClass = await admin.post<{ classId: number }>("/classes", {
        name: "资料权限班",
        counselorId: counselor.id,
        groupCount: 1,
      });
      const classId = createdClass.body.classId;
      const groups = await admin.get<{ groups: Array<{ id: number }> }>(`/classes/${classId}/groups`);
      const student = await admin.post<{ studentId: number }>(`/classes/${classId}/students`, {
        name: "原班长",
        phone: "13900002001",
        groupId: groups.body.groups[0].id,
      });
      const monitorAccount = await admin.put<{ temporaryPassword: string; phone: string }>(`/classes/${classId}/monitor`, {
        studentId: student.body.studentId,
      });

      const monitor = client();
      expect((await monitor.post("/auth/login", {
        identifier: monitorAccount.body.phone,
        password: monitorAccount.body.temporaryPassword,
      })).status).toBe(200);
      expect((await monitor.post("/auth/change-password", {
        currentPassword: monitorAccount.body.temporaryPassword,
        newPassword: "Monitor!2026",
      })).status).toBe(200);
      expect((await monitor.patch("/auth/profile", {
        displayName: "新班长",
        dharmaName: "善行",
        phone: "13900002002",
        currentPassword: "Monitor!2026",
      })).status).toBe(200);

      const counselorClient = client();
      expect((await counselorClient.post("/auth/login", {
        identifier: counselor.phone,
        password: counselor.temporaryPassword,
      })).status).toBe(200);
      expect((await counselorClient.post("/auth/change-password", {
        currentPassword: counselor.temporaryPassword,
        newPassword: "Owner!2026",
      })).status).toBe(200);
      const blocked = await counselorClient.patch<{ error: string }>(`/classes/${classId}/students/${student.body.studentId}`, {
        phone: "13900002003",
      });
      expect(blocked.status).toBe(400);
      expect(blocked.body.error).toContain("联系管理员");

      const adminWithoutPassword = await admin.patch<{ error: string }>(`/classes/${classId}/students/${student.body.studentId}`, {
        phone: "13900002003",
      });
      expect(adminWithoutPassword.status).toBe(400);
      expect(adminWithoutPassword.body.error).toContain("当前密码");
      expect((await admin.patch(`/classes/${classId}/students/${student.body.studentId}`, {
        phone: "13900002003",
        currentPassword: "admin12345",
      })).status).toBe(200);
      expect((await client().post("/auth/login", {
        identifier: "13900002003",
        password: "Monitor!2026",
      })).status).toBe(200);
    });
  });
});

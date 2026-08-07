import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../src/server/db.js";
import { createApiRouter } from "../src/server/routes.js";
import { shanghaiToday } from "../src/server/services/roster.js";

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

class ApiClient {
  private cookie = "";

  constructor(private readonly baseUrl: string) {}

  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const headers = new Headers({ Accept: "application/json" });
    if (this.cookie) headers.set("Cookie", this.cookie);
    if (body !== undefined) headers.set("Content-Type", "application/json");

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookieHeaders = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? [response.headers.get("set-cookie")].filter((value): value is string => value !== null);
    for (const value of cookieHeaders) {
      const match = /(?:^|;\s*)(class_study_session=[^;]*)/.exec(value);
      if (match) this.cookie = match[1];
    }

    const text = await response.text();
    const parsed = text ? JSON.parse(text) as T : {} as T;
    return { status: response.status, body: parsed, headers: response.headers };
  }

  get<T = Record<string, unknown>>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>("GET", path);
  }

  post<T = Record<string, unknown>>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>("POST", path, body);
  }

  put<T = Record<string, unknown>>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>("PUT", path, body);
  }

  patch<T = Record<string, unknown>>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>("PATCH", path, body);
  }
}

describe.sequential("API lifecycle and class isolation", () => {
  let db: DatabaseSync;
  let server: Server;
  let baseUrl: string;
  let admin: ApiClient;
  let counselorA: ApiClient;
  let counselorB: ApiClient;
  let monitor: ApiClient;
  let previousAdminPassword: string | undefined;
  let warningSpy: ReturnType<typeof vi.spyOn>;

  let counselorAId = 0;
  let counselorBId = 0;
  let counselorATemporaryPassword = "";
  let counselorBTemporaryPassword = "";
  let monitorTemporaryPassword = "";
  let classId = 0;
  let otherClassId = 0;
  let firstGroupId = 0;
  let monitorStudentId = 0;
  let secondStudentId = 0;
  let thirdStudentId = 0;
  let firstLessonId = 0;

  beforeAll(async () => {
    previousAdminPassword = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    warningSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    db = openDatabase(":memory:");
    const app = express();
    app.disable("x-powered-by");
    app.use("/api", createApiRouter(db));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api`;
    admin = new ApiClient(baseUrl);
    counselorA = new ApiClient(baseUrl);
    counselorB = new ApiClient(baseUrl);
    monitor = new ApiClient(baseUrl);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    db.close();
    warningSpy.mockRestore();
    if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousAdminPassword;
  });

  it("logs in as admin and creates phone counselors, a default-three-group class, roster, schedule, and monitor", async () => {
    const login = await admin.post("/auth/login", { identifier: "admin", password: "admin12345" });
    expect(login.status).toBe(200);

    const me = await admin.get<{ user: { isAdmin: boolean }; classAccesses: unknown[] }>("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.isAdmin).toBe(true);

    const createdCounselorA = await admin.post<{
      id: number; phone: string; temporaryPassword: string;
    }>("/admin/counselors", { displayName: "辅导员甲", phone: "13800138001" });
    expect(createdCounselorA.status).toBe(200);
    expect(createdCounselorA.body.phone).toBe("+8613800138001");
    expect(createdCounselorA.body.temporaryPassword.length).toBeGreaterThanOrEqual(8);
    counselorAId = createdCounselorA.body.id;
    counselorATemporaryPassword = createdCounselorA.body.temporaryPassword;

    const createdCounselorB = await admin.post<{
      id: number; phone: string; temporaryPassword: string;
    }>("/admin/counselors", { displayName: "辅导员乙", phone: "13800138002" });
    expect(createdCounselorB.status).toBe(200);
    counselorBId = createdCounselorB.body.id;
    counselorBTemporaryPassword = createdCounselorB.body.temporaryPassword;

    const createdClass = await admin.post<{ classId: number }>("/classes", {
      name: "菩提一班",
      counselorId: counselorAId,
    });
    expect(createdClass.status).toBe(200);
    classId = createdClass.body.classId;

    const groups = await admin.get<{
      groups: Array<{ id: number; name: string; active: boolean }>;
    }>(`/classes/${classId}/groups`);
    expect(groups.status).toBe(200);
    expect(groups.body.groups).toHaveLength(3);
    expect(groups.body.groups.map((group) => group.name)).toEqual(["第一组", "第二组", "第三组"]);
    expect(groups.body.groups.every((group) => group.active)).toBe(true);
    firstGroupId = groups.body.groups[0].id;

    const addStudent = async (name: string, phone: string, extra: Record<string, unknown> = {}) => {
      const response = await admin.post<{ studentId: number; effectiveSequence: number }>(
        `/classes/${classId}/students`,
        { name, phone, groupId: firstGroupId, ...extra },
      );
      expect(response.status).toBe(200);
      expect(response.body.effectiveSequence).toBe(1);
      return response.body.studentId;
    };
    monitorStudentId = await addStudent("班长学员", "13900139001", {
      dharmaName: "明学", note: "只对管理员和辅导员可见",
    });
    secondStudentId = await addStudent("第二学员", "13900139002");
    thirdStudentId = await addStudent("待登记学员", "13900139003");

    const generated = await admin.post<{ generatedCount: number }>(`/classes/${classId}/schedule/generate`, {
      firstDueDate: shanghaiToday(),
      count: 2,
    });
    expect(generated.status).toBe(200);
    expect(generated.body.generatedCount).toBe(2);

    const lessons = await admin.get<{ lessons: Array<{ id: number; sequence: number }> }>(
      `/classes/${classId}/lessons`,
    );
    expect(lessons.status).toBe(200);
    expect(lessons.body.lessons).toHaveLength(2);
    firstLessonId = lessons.body.lessons[0].id;

    const assignedMonitor = await admin.put<{
      temporaryPassword: string; phone: string;
    }>(`/classes/${classId}/monitor`, { studentId: monitorStudentId });
    expect(assignedMonitor.status).toBe(200);
    expect(assignedMonitor.body.phone).toBe("+8613900139001");
    expect(assignedMonitor.body.temporaryPassword.length).toBeGreaterThanOrEqual(8);
    monitorTemporaryPassword = assignedMonitor.body.temporaryPassword;

    const otherClass = await admin.post<{ classId: number }>("/classes", {
      name: "菩提二班",
      counselorId: counselorBId,
    });
    expect(otherClass.status).toBe(200);
    otherClassId = otherClass.body.classId;
  });

  it("requires a counselor to replace the temporary password before class access", async () => {
    const login = await counselorA.post("/auth/login", {
      identifier: "13800138001",
      password: counselorATemporaryPassword,
    });
    expect(login.status).toBe(200);

    const meBefore = await counselorA.get<{
      user: { mustChangePassword: boolean; phone: string };
    }>("/auth/me");
    expect(meBefore.status).toBe(200);
    expect(meBefore.body.user).toMatchObject({ mustChangePassword: true, phone: "+8613800138001" });

    const blocked = await counselorA.get<{ code: string }>(`/classes/${classId}/students`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PASSWORD_CHANGE_REQUIRED");

    const changed = await counselorA.post("/auth/change-password", {
      currentPassword: counselorATemporaryPassword,
      newPassword: "CounselorA!2026",
    });
    expect(changed.status).toBe(200);

    const students = await counselorA.get<{
      students: Array<{ studentId: number; phone: string; note: string | null }>;
    }>(`/classes/${classId}/students`);
    expect(students.status).toBe(200);
    expect(students.body.students.find((student) => student.studentId === monitorStudentId)).toMatchObject({
      phone: "+8613900139001",
      note: "只对管理员和辅导员可见",
    });
  });

  it("lets the monitor change the first-use password and submit all three metrics for their class", async () => {
    const login = await monitor.post("/auth/login", {
      identifier: "13900139001",
      password: monitorTemporaryPassword,
    });
    expect(login.status).toBe(200);

    const beforeChange = await monitor.get<{ user: { mustChangePassword: boolean } }>("/auth/me");
    expect(beforeChange.body.user.mustChangePassword).toBe(true);
    const blocked = await monitor.get<{ code: string }>(`/classes/${classId}/lessons`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PASSWORD_CHANGE_REQUIRED");

    const changed = await monitor.post("/auth/change-password", {
      currentPassword: monitorTemporaryPassword,
      newPassword: "Monitor!2026",
    });
    expect(changed.status).toBe(200);

    const attendance = await monitor.get<{
      rows: Array<Record<string, unknown>>;
      canEdit: boolean;
      openMetrics: Record<string, boolean>;
    }>(`/classes/${classId}/attendance/${firstLessonId}`);
    expect(attendance.status).toBe(200);
    expect(attendance.body.rows).toHaveLength(3);
    expect(attendance.body.canEdit).toBe(true);
    expect(attendance.body.openMetrics).toEqual({
      outline: true,
      group_study: true,
      class_study: true,
    });
    for (const row of attendance.body.rows) {
      expect(row).not.toHaveProperty("phone");
      expect(row).not.toHaveProperty("note");
    }

    const saved = await monitor.put(`/classes/${classId}/attendance/${firstLessonId}`, {
      records: [
        {
          studentId: monitorStudentId,
          outline: "yes",
          groupStudy: "present",
          classStudy: "onsite",
        },
        {
          studentId: secondStudentId,
          outline: "no",
          groupStudy: "absent",
          classStudy: "share",
        },
      ],
    });
    expect(saved.status).toBe(200);

    const report = await monitor.get<{
      classSummary: Record<string, {
        completed: number; applicable: number; pending: number; rate: number | null;
      }>;
      personalStats: Array<{ studentId: number }>;
    }>(`/classes/${classId}/reports?range=recent`);
    expect(report.status).toBe(200);
    expect(report.body.classSummary).toMatchObject({
      outline: { completed: 1, applicable: 2, pending: 1, rate: 50 },
      group_study: { completed: 1, applicable: 2, pending: 1, rate: 50 },
      class_study: { completed: 1, applicable: 2, pending: 1, rate: 50 },
    });
    expect(report.body.personalStats.map((student) => student.studentId).sort((a, b) => a - b)).toEqual(
      [monitorStudentId, secondStudentId, thirdStudentId].sort((a, b) => a - b),
    );
  });

  it("rejects cross-class access for monitor and unrelated counselor", async () => {
    const monitorIdentity = await monitor.get<{
      user: { isAdmin: boolean; canCounsel: boolean; phone: string };
    }>("/auth/me");
    expect(monitorIdentity.body.user).toMatchObject({
      isAdmin: false,
      canCounsel: false,
      phone: "+8613900139001",
    });

    const monitorCrossClass = await monitor.get(`/classes/${otherClassId}/lessons`);
    expect(monitorCrossClass.status).toBe(403);

    const counselorCrossClass = await counselorA.get(`/classes/${otherClassId}/lessons`);
    expect(counselorCrossClass.status).toBe(403);
  });

  it("redacts sensitive roster fields and rejects exports for a monitor", async () => {
    const monitorRoster = await monitor.get<{
      students: Array<Record<string, unknown>>;
    }>(`/classes/${classId}/students`);
    expect(monitorRoster.status).toBe(200);
    expect(monitorRoster.body.students).toHaveLength(3);
    for (const student of monitorRoster.body.students) {
      expect(student).not.toHaveProperty("phone");
      expect(student).not.toHaveProperty("note");
      expect(student).not.toHaveProperty("personId");
    }

    const monitorExport = await monitor.get(`/classes/${classId}/export.csv?range=recent`);
    expect(monitorExport.status).toBe(403);
  });

  it("revokes the old counselor immediately when admin assigns the class to another counselor", async () => {
    const before = await counselorA.get(`/classes/${classId}/lessons`);
    expect(before.status).toBe(200);

    const replaced = await admin.patch(`/classes/${classId}`, { counselorId: counselorBId });
    expect(replaced.status).toBe(200);

    const oldCounselorDenied = await counselorA.get(`/classes/${classId}/lessons`);
    expect(oldCounselorDenied.status).toBe(403);

    const oldCounselorMe = await counselorA.get<{
      classAccesses: Array<{ classId: number }>;
    }>("/auth/me");
    expect(oldCounselorMe.body.classAccesses.some((access) => access.classId === classId)).toBe(false);

    const newCounselorLogin = await counselorB.post("/auth/login", {
      identifier: "13800138002",
      password: counselorBTemporaryPassword,
    });
    expect(newCounselorLogin.status).toBe(200);
    const newCounselorChanged = await counselorB.post("/auth/change-password", {
      currentPassword: counselorBTemporaryPassword,
      newPassword: "CounselorB!2026",
    });
    expect(newCounselorChanged.status).toBe(200);
    const newCounselorAccess = await counselorB.get(`/classes/${classId}/lessons`);
    expect(newCounselorAccess.status).toBe(200);
  });
});

import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";
import { shanghaiToday } from "../src/server/services/roster.js";
import { startTestApi, type TestApiClient } from "./support/apiHarness.js";

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

interface AttendanceAssistantFixture {
  db: DatabaseSync;
  admin: TestApiClient;
  counselor: TestApiClient;
  classId: number;
  otherClassId: number;
  groupId: number;
  assistantAId: number;
  assistantBId: number;
  ordinaryStudentId: number;
  lessonId: number;
  client(): TestApiClient;
}

async function addStudent(
  client: TestApiClient,
  classId: number,
  groupId: number,
  name: string,
  phone: string,
): Promise<number> {
  const response = await client.post<{ studentId: number }>(`/classes/${classId}/students`, {
    name,
    phone,
    groupId,
  });
  expect(response.status).toBe(200);
  return response.body.studentId;
}

async function createFixture(): Promise<AttendanceAssistantFixture & { close(): Promise<void> }> {
  const db = openDatabase(":memory:");
  const server = await startTestApi(db);
  const admin = server.client();
  const counselor = server.client();

  expect((await admin.post("/auth/login", { identifier: "admin", password: "admin12345" })).status).toBe(200);
  const counselorAccount = await admin.post<{
    id: number;
    username: string;
    temporaryPassword: string;
  }>("/admin/counselors", {
    name: "考勤测试辅导员",
    username: "attendance-counselor",
  });
  expect(counselorAccount.status).toBe(200);
  expect((await counselor.post("/auth/login", {
    identifier: counselorAccount.body.username,
    password: counselorAccount.body.temporaryPassword,
  })).status).toBe(200);
  expect((await counselor.post("/auth/change-password", {
    currentPassword: counselorAccount.body.temporaryPassword,
    newPassword: "AttendanceCounselor!2026",
  })).status).toBe(200);

  const createdClass = await admin.post<{ classId: number }>("/classes", {
    name: "考勤员权限班",
    counselorId: counselorAccount.body.id,
    groupCount: 1,
  });
  expect(createdClass.status).toBe(200);
  const classId = createdClass.body.classId;
  const createdOtherClass = await admin.post<{ classId: number }>("/classes", {
    name: "考勤员无权班",
    counselorId: counselorAccount.body.id,
    groupCount: 1,
  });
  expect(createdOtherClass.status).toBe(200);
  const otherClassId = createdOtherClass.body.classId;

  const groupResponse = await counselor.get<{ groups: Array<{ id: number }> }>(`/classes/${classId}/groups`);
  expect(groupResponse.status).toBe(200);
  const groupId = groupResponse.body.groups[0].id;
  const assistantAId = await addStudent(counselor, classId, groupId, "考勤员甲", "13700003101");
  const assistantBId = await addStudent(counselor, classId, groupId, "考勤员乙", "13700003102");
  const ordinaryStudentId = await addStudent(counselor, classId, groupId, "普通学员", "13700003103");

  const schedule = await counselor.post(`/classes/${classId}/schedule/generate`, {
    firstDueDate: shanghaiToday(),
    count: 1,
    cadenceMode: "same_week",
    seriesKey: "wisdom_life",
    startPosition: 1,
    round: 1,
  });
  expect(schedule.status).toBe(200);
  const lessons = await counselor.get<{ lessons: Array<{ id: number }> }>(`/classes/${classId}/lessons`);
  expect(lessons.status).toBe(200);

  return {
    db,
    admin,
    counselor,
    classId,
    otherClassId,
    groupId,
    assistantAId,
    assistantBId,
    ordinaryStudentId,
    lessonId: lessons.body.lessons[0].id,
    client: () => server.client(),
    async close() {
      await server.close();
      db.close();
    },
  };
}

async function loginAndChangeTemporaryPassword(
  client: TestApiClient,
  identifier: string,
  temporaryPassword: string,
  newPassword: string,
): Promise<void> {
  expect((await client.post("/auth/login", { identifier, password: temporaryPassword })).status).toBe(200);
  expect((await client.post("/auth/change-password", {
    currentPassword: temporaryPassword,
    newPassword,
  })).status).toBe(200);
}

describe("考勤员班级权限", () => {
  it("管理员和辅导员可任命多名考勤员，账号仅能登记本班考勤并查看统计", async () => {
    const fixture = await createFixture();
    try {
      const assignedA = await fixture.admin.post<{
        userId: number;
        loginIdentifier: string;
        temporaryPassword: string;
      }>(`/classes/${fixture.classId}/attendance-assistants`, { studentId: fixture.assistantAId });
      expect(assignedA.status).toBe(200);
      expect(assignedA.body.loginIdentifier).toBe("+8613700003101");
      expect(assignedA.body.temporaryPassword.length).toBeGreaterThanOrEqual(8);

      const assignedB = await fixture.counselor.post<{
        userId: number;
        loginIdentifier: string;
        temporaryPassword: string;
      }>(`/classes/${fixture.classId}/attendance-assistants`, { studentId: fixture.assistantBId });
      expect(assignedB.status).toBe(200);
      expect(assignedB.body.loginIdentifier).toBe("+8613700003102");
      expect(assignedB.body.temporaryPassword.length).toBeGreaterThanOrEqual(8);

      const assistants = await fixture.counselor.get<{
        assistants: Array<{ enrollmentId: number; username: string }>;
      }>(`/classes/${fixture.classId}/attendance-assistants`);
      expect(assistants.status).toBe(200);
      expect(assistants.body.assistants).toEqual(expect.arrayContaining([
        expect.objectContaining({ enrollmentId: fixture.assistantAId, username: "+8613700003101" }),
        expect.objectContaining({ enrollmentId: fixture.assistantBId, username: "+8613700003102" }),
      ]));

      const assistant = fixture.client();
      // A temporary account cannot access class data until the first password change.
      expect((await assistant.post("/auth/login", {
        identifier: "13700003101",
        password: assignedA.body.temporaryPassword,
      })).status).toBe(200);
      expect((await assistant.get(`/classes/${fixture.classId}/lessons`)).status).toBe(403);
      expect((await assistant.post("/auth/change-password", {
        currentPassword: assignedA.body.temporaryPassword,
        newPassword: "AttendanceAssistantA!2026",
      })).status).toBe(200);

      const me = await assistant.get<{
        classAccesses: Array<{ classId: number; permission: string }>;
      }>("/auth/me");
      expect(me.status).toBe(200);
      expect(me.body.classAccesses).toContainEqual(expect.objectContaining({
        classId: fixture.classId,
        permission: "attendance_assistant",
      }));
      const classList = await assistant.get<{
        classes: Array<{ id: number; permission: string }>;
      }>("/classes");
      expect(classList.status).toBe(200);
      expect(classList.body.classes).toEqual([
        expect.objectContaining({ id: fixture.classId, permission: "attendance_assistant" }),
      ]);

      expect((await assistant.get(`/classes/${fixture.classId}/lessons`)).status).toBe(200);
      expect((await assistant.get(`/classes/${fixture.classId}/attendance/${fixture.lessonId}`)).status).toBe(200);
      const saved = await assistant.put(`/classes/${fixture.classId}/attendance/${fixture.lessonId}`, {
        records: [{
          studentId: fixture.ordinaryStudentId,
          outline: "yes",
          groupStudy: "onsite",
          classStudy: "online",
        }],
      });
      expect(saved.status).toBe(200);
      const report = await assistant.get<{
        details: Array<{ studentId: number; status: string }>;
      }>(`/classes/${fixture.classId}/reports?range=recent`);
      expect(report.status).toBe(200);
      expect(report.body.details).toEqual(expect.arrayContaining([
        expect.objectContaining({ studentId: fixture.ordinaryStudentId, status: "yes" }),
        expect.objectContaining({ studentId: fixture.ordinaryStudentId, status: "onsite" }),
        expect.objectContaining({ studentId: fixture.ordinaryStudentId, status: "online" }),
      ]));

      // Reading roster/profile data and every management capability remain outside the role.
      expect((await assistant.get(`/classes/${fixture.classId}`)).status).toBe(403);
      expect((await assistant.get(`/classes/${fixture.classId}/groups`)).status).toBe(403);
      expect((await assistant.get(`/classes/${fixture.classId}/students`)).status).toBe(403);
      expect((await assistant.post(`/classes/${fixture.classId}/lessons/append`, { count: 1 })).status).toBe(403);
      expect((await assistant.post(`/classes/${fixture.classId}/breaks`, {
        startDate: addDays(shanghaiToday(), 14),
        weeks: 1,
      })).status).toBe(403);
      expect((await assistant.raw(`/classes/${fixture.classId}/export.csv?range=recent`)).status).toBe(403);
      expect((await assistant.raw(`/classes/${fixture.classId}/export.xlsx?range=recent`)).status).toBe(403);

      expect((await assistant.get(`/classes/${fixture.otherClassId}/lessons`)).status).toBe(403);
      expect((await assistant.get(`/classes/${fixture.otherClassId}/reports?range=recent`)).status).toBe(403);
    } finally {
      await fixture.close();
    }
  });

  it("考勤员遵守指标开放日期和整课截止日后十四天锁定", async () => {
    const fixture = await createFixture();
    try {
      const assignment = await fixture.admin.post<{
        loginIdentifier: string;
        temporaryPassword: string;
      }>(`/classes/${fixture.classId}/attendance-assistants`, { studentId: fixture.assistantAId });
      expect(assignment.status).toBe(200);
      const assistant = fixture.client();
      await loginAndChangeTemporaryPassword(
        assistant,
        assignment.body.loginIdentifier,
        assignment.body.temporaryPassword,
        "AttendanceAssistantLock!2026",
      );

      // A parallel lesson has begun, but its class-study phase opens one week later.
      fixture.db.prepare(
        `update lessons
            set cadence_mode = 'parallel_two_week', outline_due_date = ?, group_study_due_date = ?, class_study_due_date = ?
          where id = ?`,
      ).run(shanghaiToday(), shanghaiToday(), addDays(shanghaiToday(), 7), fixture.lessonId);
      const partiallyOpen = await assistant.get<{
        canEdit: boolean;
        openMetrics: { outline: boolean; group_study: boolean; class_study: boolean };
      }>(`/classes/${fixture.classId}/attendance/${fixture.lessonId}`);
      expect(partiallyOpen.status).toBe(200);
      expect(partiallyOpen.body).toMatchObject({
        canEdit: true,
        openMetrics: { outline: true, group_study: true, class_study: false },
      });
      expect((await assistant.put(`/classes/${fixture.classId}/attendance/${fixture.lessonId}`, {
        records: [{ studentId: fixture.ordinaryStudentId, outline: "yes" }],
      })).status).toBe(200);
      const unopened = await assistant.put<{ error: string }>(
        `/classes/${fixture.classId}/attendance/${fixture.lessonId}`,
        { records: [{ studentId: fixture.ordinaryStudentId, classStudy: "online" }] },
      );
      expect(unopened.status).toBe(400);
      expect(unopened.body.error).toContain("尚未开放填写");

      const lockedDueDate = addDays(shanghaiToday(), -14);
      fixture.db.prepare(
        "update lessons set outline_due_date = ?, group_study_due_date = ?, class_study_due_date = ? where id = ?",
      ).run(lockedDueDate, lockedDueDate, lockedDueDate, fixture.lessonId);
      const lockedView = await assistant.get<{ canEdit: boolean; lockedForMonitor: boolean }>(
        `/classes/${fixture.classId}/attendance/${fixture.lessonId}`,
      );
      expect(lockedView.status).toBe(200);
      expect(lockedView.body).toMatchObject({ canEdit: false, lockedForMonitor: true });
      const lockedSave = await assistant.put<{ error: string }>(
        `/classes/${fixture.classId}/attendance/${fixture.lessonId}`,
        { records: [{ studentId: fixture.ordinaryStudentId, groupStudy: "onsite" }] },
      );
      expect(lockedSave.status).toBe(403);
      expect(lockedSave.body.error).toContain("超过14天");
    } finally {
      await fixture.close();
    }
  });

  it("必须先撤销考勤员才能休学，撤销后无其他身份的账号立即停用", async () => {
    const fixture = await createFixture();
    try {
      const assignment = await fixture.admin.post<{
        userId: number;
        loginIdentifier: string;
        temporaryPassword: string;
      }>(`/classes/${fixture.classId}/attendance-assistants`, { studentId: fixture.assistantAId });
      expect(assignment.status).toBe(200);
      const assistant = fixture.client();
      await loginAndChangeTemporaryPassword(
        assistant,
        assignment.body.loginIdentifier,
        assignment.body.temporaryPassword,
        "AttendanceAssistantRevoke!2026",
      );

      const blockedLeave = await fixture.counselor.patch<{ error: string }>(
        `/classes/${fixture.classId}/students/${fixture.assistantAId}`,
        { status: "leave" },
      );
      expect(blockedLeave.status).toBe(400);
      expect(blockedLeave.body.error).toContain("先取消考勤员权限");

      const revoked = await fixture.counselor.json(
        "DELETE",
        `/classes/${fixture.classId}/attendance-assistants/${fixture.assistantAId}`,
      );
      expect(revoked.status).toBe(200);
      expect((fixture.db.prepare("select active from users where id = ?").get(assignment.body.userId) as { active: number }).active)
        .toBe(0);
      expect((await assistant.get(`/classes/${fixture.classId}/lessons`)).status).toBe(401);

      const leave = await fixture.counselor.patch(
        `/classes/${fixture.classId}/students/${fixture.assistantAId}`,
        { status: "leave" },
      );
      expect(leave.status).toBe(200);
      const cannotReassignWhileOnLeave = await fixture.counselor.post<{ error: string }>(
        `/classes/${fixture.classId}/attendance-assistants`,
        { studentId: fixture.assistantAId },
      );
      expect(cannotReassignWhileOnLeave.status).toBe(400);
      expect(cannotReassignWhileOnLeave.body.error).toContain("正常在册学员");
    } finally {
      await fixture.close();
    }
  });

  it("归档班级撤销考勤员访问，而兼任辅导员的账号在撤权后仍保持启用", async () => {
    const fixture = await createFixture();
    try {
      const archivedAssignment = await fixture.admin.post<{
        userId: number;
        loginIdentifier: string;
        temporaryPassword: string;
      }>(`/classes/${fixture.classId}/attendance-assistants`, { studentId: fixture.assistantAId });
      expect(archivedAssignment.status).toBe(200);
      const archivedAssistant = fixture.client();
      await loginAndChangeTemporaryPassword(
        archivedAssistant,
        archivedAssignment.body.loginIdentifier,
        archivedAssignment.body.temporaryPassword,
        "AttendanceAssistantArchive!2026",
      );
      expect((await fixture.counselor.patch(`/classes/${fixture.classId}`, { archived: true })).status).toBe(200);
      expect(fixture.db.prepare(
        "select 1 from class_attendance_assistants where class_id = ? and user_id = ?",
      ).get(fixture.classId, archivedAssignment.body.userId)).toBeUndefined();
      expect((await archivedAssistant.get(`/classes/${fixture.classId}/lessons`)).status).toBe(401);
      const assignArchived = await fixture.admin.post<{ error: string }>(
        `/classes/${fixture.classId}/attendance-assistants`,
        { studentId: fixture.assistantAId },
      );
      expect(assignArchived.status).toBe(400);
      expect(assignArchived.body.error).toContain("已归档班级");

      expect((await fixture.admin.patch(`/classes/${fixture.classId}`, { archived: false })).status).toBe(200);
      const compositeAssignment = await fixture.admin.post<{
        userId: number;
        temporaryPassword: string;
      }>(`/classes/${fixture.classId}/attendance-assistants`, { studentId: fixture.assistantBId });
      expect(compositeAssignment.status).toBe(200);
      const elevated = await fixture.admin.post<{ id: number; temporaryPassword?: string }>("/admin/counselors", {
        name: "考勤员乙",
        phone: "13700003102",
      });
      expect(elevated.status).toBe(200);
      expect(elevated.body.id).toBe(compositeAssignment.body.userId);
      expect(elevated.body.temporaryPassword).toBeUndefined();

      expect((await fixture.admin.json(
        "DELETE",
        `/classes/${fixture.classId}/attendance-assistants/${fixture.assistantBId}`,
      )).status).toBe(200);
      expect((fixture.db.prepare(
        "select active, can_counsel as canCounsel from users where id = ?",
      ).get(compositeAssignment.body.userId) as { active: number; canCounsel: number })).toEqual({ active: 1, canCounsel: 1 });
      const compositeClient = fixture.client();
      expect((await compositeClient.post("/auth/login", {
        identifier: "13700003102",
        password: compositeAssignment.body.temporaryPassword,
      })).status).toBe(200);
      const compositeMe = await compositeClient.get<{ user: { canCounsel: boolean } | null }>("/auth/me");
      expect(compositeMe.status).toBe(200);
      expect(compositeMe.body.user).toMatchObject({ canCounsel: true });
    } finally {
      await fixture.close();
    }
  });
});

import ExcelJS from "exceljs";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";
import { shanghaiToday } from "../src/server/services/roster.js";
import { startTestApi, type TestApiClient } from "./support/apiHarness.js";

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

async function withApi(
  run: (context: { db: DatabaseSync; admin: TestApiClient; adminId: number }) => Promise<void>,
): Promise<void> {
  const db = openDatabase(":memory:");
  const server = await startTestApi(db);
  const admin = server.client();
  try {
    const login = await admin.post("/auth/login", { identifier: "admin", password: "admin12345" });
    expect(login.status).toBe(200);
    const row = db.prepare("select id from users where is_admin = 1").get() as { id: number };
    db.prepare("update users set can_counsel = 1 where id = ?").run(row.id);
    await run({ db, admin, adminId: row.id });
  } finally {
    await server.close();
    db.close();
  }
}

async function createClass(
  admin: TestApiClient,
  counselorId: number,
  name: string,
  groupCount = 3,
): Promise<number> {
  const response = await admin.post<{ classId: number }>("/classes", {
    name,
    counselorId,
    groupCount,
  });
  expect(response.status).toBe(200);
  return response.body.classId;
}

async function groups(admin: TestApiClient, classId: number) {
  const response = await admin.get<{
    groups: Array<{ id: number; name: string; active: boolean }>;
  }>(`/classes/${classId}/groups`);
  expect(response.status).toBe(200);
  return response.body.groups;
}

async function addStudent(
  admin: TestApiClient,
  classId: number,
  groupId: number,
  name: string,
  phone: string,
): Promise<number> {
  const response = await admin.post<{ studentId: number }>(`/classes/${classId}/students`, {
    name,
    phone,
    groupId,
  });
  expect(response.status).toBe(200);
  return response.body.studentId;
}

describe("API 边界、事务与文件响应验收", () => {
  it("组修和班修只接受统一五项状态，并把旷课保存为 absent", async () => {
    await withApi(async ({ admin, adminId }) => {
      const classId = await createClass(admin, adminId, "停用补课状态班", 1);
      const groupId = (await groups(admin, classId))[0].id;
      const studentId = await addStudent(admin, classId, groupId, "考勤状态学员", "13700000200");
      expect((await admin.post(`/classes/${classId}/schedule/generate`, {
        firstDueDate: shanghaiToday(),
        count: 1,
      })).status).toBe(200);
      const lesson = (await admin.get<{ lessons: Array<{ id: number }> }>(
        `/classes/${classId}/lessons`,
      )).body.lessons[0];

      const retired = await admin.put<{ error: string }>(`/classes/${classId}/attendance/${lesson.id}`, {
        records: [{ studentId, classStudy: "makeup" }],
      });
      expect(retired.status).toBe(400);
      expect(retired.body.error).toContain("考勤状态无效");

      const legacy = await admin.put<{ error: string }>(`/classes/${classId}/attendance/${lesson.id}`, {
        records: [{ studentId, groupStudy: "present", classStudy: "share" }],
      });
      expect(legacy.status).toBe(400);
      expect(legacy.body.error).toContain("考勤状态无效");

      expect((await admin.put(`/classes/${classId}/attendance/${lesson.id}`, {
        records: [{ studentId, groupStudy: "official_duty", classStudy: "absent" }],
      })).status).toBe(200);
      const attendance = await admin.get<{ attendanceSchemaVersion: number; rows: Array<{ studentId: number; groupStudy: string; classStudy: string }>; statuses: { groupStudy: string[]; classStudy: string[] } }>(
        `/classes/${classId}/attendance/${lesson.id}`,
      );
      expect(attendance.body.attendanceSchemaVersion).toBe(2);
      expect(attendance.body.rows.find((row) => row.studentId === studentId)).toMatchObject({
        groupStudy: "official_duty",
        classStudy: "absent",
      });
      expect(attendance.body.statuses.groupStudy).toEqual(["onsite", "online", "official_duty", "absent", "observer"]);
      expect(attendance.body.statuses.classStudy).toEqual(attendance.body.statuses.groupStudy);

      const staleSave = await admin.json<{ error: string; code: string }>(
        "PUT",
        `/classes/${classId}/attendance/${lesson.id}`,
        { records: [{ studentId, groupStudy: null, classStudy: null }] },
      );
      expect(staleSave.status).toBe(409);
      expect(staleSave.body).toMatchObject({
        code: "ATTENDANCE_SCHEMA_VERSION_MISMATCH",
        error: "考勤页面已经更新，请刷新页面后重新操作",
      });
      const afterStaleSave = await admin.get<{ rows: Array<{ studentId: number; groupStudy: string; classStudy: string }> }>(
        `/classes/${classId}/attendance/${lesson.id}`,
      );
      expect(afterStaleSave.body.rows.find((row) => row.studentId === studentId)).toMatchObject({
        groupStudy: "official_duty",
        classStudy: "absent",
      });
    });
  });

  it("未开始课次返回预计名单但不冻结名单或允许保存", async () => {
    await withApi(async ({ db, admin, adminId }) => {
      const classId = await createClass(admin, adminId, "未来考勤预览班", 1);
      const groupId = (await groups(admin, classId))[0].id;
      const studentId = await addStudent(admin, classId, groupId, "预计名单学员", "13700000209");
      const firstDueDate = addDays(shanghaiToday(), 14);
      expect((await admin.post(`/classes/${classId}/schedule/generate`, {
        firstDueDate,
        count: 1,
      })).status).toBe(200);
      const lesson = (await admin.get<{ lessons: Array<{ id: number }> }>(
        `/classes/${classId}/lessons`,
      )).body.lessons[0];

      const attendance = await admin.get<{
        previewOnly: boolean;
        attendanceOpensOn: string;
        canEdit: boolean;
        history: unknown[];
        rows: Array<{ studentId: number; name: string; outline: null; groupStudy: null; classStudy: null }>;
      }>(`/classes/${classId}/attendance/${lesson.id}`);
      expect(attendance.status).toBe(200);
      expect(attendance.body).toMatchObject({
        previewOnly: true,
        attendanceOpensOn: addDays(firstDueDate, -6),
        canEdit: false,
        history: [],
      });
      expect(attendance.body.rows).toEqual([
        expect.objectContaining({
          studentId,
          name: "预计名单学员",
          outline: null,
          groupStudy: null,
          classStudy: null,
        }),
      ]);
      expect(db.prepare(
        "select roster_frozen_at as frozenAt from lessons where id = ?",
      ).get(lesson.id)).toEqual({ frozenAt: null });
      expect(db.prepare(
        "select count(*) as count from lesson_roster where lesson_id = ?",
      ).get(lesson.id)).toEqual({ count: 0 });

      const rejected = await admin.put<{ error: string }>(`/classes/${classId}/attendance/${lesson.id}`, {
        records: [{ studentId, groupStudy: "onsite" }],
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain("该课尚未开始");
    });
  });

  it("班长在整课截止日后第 14 天被 API 锁定，管理员仍可补改，第 13 天班长仍可填写", async () => {
    await withApi(async ({ db, admin, adminId }) => {
      const classId = await createClass(admin, adminId, "锁定边界班", 1);
      const groupId = (await groups(admin, classId))[0].id;
      const studentId = await addStudent(admin, classId, groupId, "锁定班长", "13700000201");
      const dueDate = addDays(shanghaiToday(), -14);
      const generated = await admin.post(`/classes/${classId}/schedule/generate`, {
        firstDueDate: dueDate,
        count: 1,
      });
      expect(generated.status).toBe(200);
      const lesson = (await admin.get<{
        lessons: Array<{ id: number }>;
      }>(`/classes/${classId}/lessons`)).body.lessons[0];

      const assignment = await admin.put<{
        temporaryPassword: string;
      }>(`/classes/${classId}/monitor`, { studentId });
      expect(assignment.status).toBe(200);
      const server = await startTestApi(db);
      const monitor = server.client();
      try {
        expect((await monitor.post("/auth/login", {
          identifier: "13700000201",
          password: assignment.body.temporaryPassword,
        })).status).toBe(200);
        expect((await monitor.post("/auth/change-password", {
          currentPassword: assignment.body.temporaryPassword,
          newPassword: "MonitorLock!2026",
        })).status).toBe(200);

        const lockedView = await monitor.get<{
          canEdit: boolean;
          lockedForMonitor: boolean;
        }>(`/classes/${classId}/attendance/${lesson.id}`);
        expect(lockedView.status).toBe(200);
        expect(lockedView.body).toMatchObject({ canEdit: false, lockedForMonitor: true });
        const lockedSave = await monitor.put<{ error: string }>(`/classes/${classId}/attendance/${lesson.id}`, {
          records: [{ studentId, outline: "yes" }],
        });
        expect(lockedSave.status).toBe(403);
        expect(lockedSave.body.error).toContain("超过14天");

        const managerSave = await admin.put(`/classes/${classId}/attendance/${lesson.id}`, {
          records: [{ studentId, outline: "yes" }],
        });
        expect(managerSave.status).toBe(200);

        db.prepare("update lessons set class_study_due_date = ? where id = ?")
          .run(addDays(shanghaiToday(), -13), lesson.id);
        const boundarySave = await monitor.put(`/classes/${classId}/attendance/${lesson.id}`, {
          records: [{ studentId, groupStudy: "onsite" }],
        });
        expect(boundarySave.status).toBe(200);
      } finally {
        await server.close();
      }
    });
  });

  it("恢复归档班级时阻止跨班在册冲突，并保持归档状态", async () => {
    await withApi(async ({ db, admin, adminId }) => {
      const archivedClassId = await createClass(admin, adminId, "待恢复班", 1);
      const archivedGroupId = (await groups(admin, archivedClassId))[0].id;
      await addStudent(admin, archivedClassId, archivedGroupId, "跨班学员", "13700000211");
      expect((await admin.patch(`/classes/${archivedClassId}`, { archived: true })).status).toBe(200);

      const activeClassId = await createClass(admin, adminId, "当前在读班", 1);
      const activeGroupId = (await groups(admin, activeClassId))[0].id;
      await addStudent(admin, activeClassId, activeGroupId, "跨班学员", "13700000211");

      const restore = await admin.patch<{ error: string }>(`/classes/${archivedClassId}`, { archived: false });
      expect(restore.status).toBe(400);
      expect(restore.body.error).toContain("已在“当前在读班”就读");
      expect((db.prepare("select archived from classes where id = ?").get(archivedClassId) as { archived: number }).archived)
        .toBe(1);
    });
  });

  it("PATCH 中后续小组校验失败会回滚先前班名修改", async () => {
    await withApi(async ({ db, admin, adminId }) => {
      const classId = await createClass(admin, adminId, "原始班名", 3);
      const classGroups = await groups(admin, classId);
      await addStudent(admin, classId, classGroups[2].id, "第三组学员", "13700000221");

      const patch = await admin.patch<{ error: string }>(`/classes/${classId}`, {
        name: "不应保留的新班名",
        groupCount: 2,
      });
      expect(patch.status).toBe(400);
      expect(patch.body.error).toContain("请先把");
      const classRow = db.prepare("select name from classes where id = ?").get(classId) as { name: string };
      const activeGroups = db.prepare(
        "select count(*) as count from groups where class_id = ? and active = 1",
      ).get(classId) as { count: number };
      expect(classRow.name).toBe("原始班名");
      expect(activeGroups.count).toBe(3);
    });
  });

  it("阻止直接停用当前班长，且不留下待生效停用状态", async () => {
    await withApi(async ({ db, admin, adminId }) => {
      const classId = await createClass(admin, adminId, "班长停用班", 1);
      const groupId = (await groups(admin, classId))[0].id;
      const studentId = await addStudent(admin, classId, groupId, "现任班长", "13700000231");
      expect((await admin.put(`/classes/${classId}/monitor`, { studentId })).status).toBe(200);

      const disabled = await admin.patch<{ error: string }>(`/classes/${classId}/students/${studentId}`, {
        active: false,
      });
      expect(disabled.status).toBe(400);
      expect(disabled.body.error).toContain("请先更换或取消班长");
      const enrollment = db.prepare(
        "select inactive_from_sequence as inactiveFromSequence from enrollments where id = ?",
      ).get(studentId) as { inactiveFromSequence: number | null };
      expect(enrollment.inactiveFromSequence).toBeNull();
      expect(db.prepare("select 1 from class_monitors where class_id = ?").get(classId)).toBeDefined();
    });
  });

  it("Excel 预览后提交时在服务端重新分类，不信任客户端传回的 action", async () => {
    await withApi(async ({ db, admin, adminId }) => {
      const classId = await createClass(admin, adminId, "导入重分类班", 1);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("学员名单");
      sheet.addRow(["姓名", "法名", "电话", "小组", "备注"]);
      sheet.addRow(["重分类新增", "", "13700000241", "第一组", "从预览提交"]);
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(await workbook.xlsx.writeBuffer())], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        "roster.xlsx",
      );
      const preview = await admin.form<{
        rows: Array<Record<string, unknown>>;
        summary: Record<string, number>;
      }>(`/classes/${classId}/import/preview`, form);
      expect(preview.status).toBe(200);
      expect(preview.body.summary).toEqual({ create: 1, update: 0, skip: 0, conflict: 0 });

      const tampered = preview.body.rows.map((row) => ({ ...row, action: "skip" }));
      const committed = await admin.post<{
        importedCount: number;
      }>(`/classes/${classId}/import/commit`, { rows: tampered });
      expect(committed.status).toBe(200);
      expect(committed.body.importedCount).toBe(1);
      expect((db.prepare(
        `select count(*) as count from enrollments e join persons p on p.id = e.person_id
          where e.class_id = ? and p.phone = '+8613700000241'`,
      ).get(classId) as { count: number }).count).toBe(1);

      const otherClassId = await createClass(admin, adminId, "导入冲突来源班", 1);
      const otherGroupId = (await groups(admin, otherClassId))[0].id;
      await addStudent(admin, otherClassId, otherGroupId, "已在别班", "13700000242");
      const forgedCreate = await admin.post<{ error: string }>(`/classes/${classId}/import/commit`, {
        rows: [{
          rowNumber: 2,
          name: "已在别班",
          dharmaName: null,
          phone: "13700000242",
          groupName: "第一组",
          note: null,
          action: "create",
        }],
      });
      expect(forgedCreate.status).toBe(400);
      expect(forgedCreate.body.error).toContain("导入冲突");
    });
  });

  it("CSV、XLSX 报表和导入模板返回可解析的文件与预期工作表结构", async () => {
    await withApi(async ({ admin, adminId }) => {
      const classId = await createClass(admin, adminId, "文件导出班", 1);
      const groupId = (await groups(admin, classId))[0].id;
      const studentId = await addStudent(admin, classId, groupId, "导出学员", "13700000251");
      expect((await admin.post(`/classes/${classId}/schedule/generate`, {
        firstDueDate: shanghaiToday(),
        count: 1,
      })).status).toBe(200);
      const lessonId = (await admin.get<{
        lessons: Array<{ id: number }>;
      }>(`/classes/${classId}/lessons`)).body.lessons[0].id;
      expect((await admin.put(`/classes/${classId}/attendance/${lessonId}`, {
        records: [{ studentId, outline: "yes", groupStudy: "onsite", classStudy: "online" }],
      })).status).toBe(200);

      const csv = await admin.raw(`/classes/${classId}/export.csv?range=recent`);
      expect(csv.status).toBe(200);
      expect(csv.headers.get("content-type")).toContain("text/csv");
      expect(csv.headers.get("content-disposition")).toMatch(/class-study-report-\d{8}-\d{8}\.csv/);
      const csvText = csv.body.toString("utf8");
      expect(csvText.charCodeAt(0)).toBe(0xfeff);
      expect(csvText).toContain("\"记录类型\",\"班级\"");
      expect(csvText).toContain("\"逐课明细\"");
      expect(csvText).toContain("\"导出学员\"");

      const xlsx = await admin.raw(`/classes/${classId}/export.xlsx?range=recent`);
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers.get("content-type")).toContain(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(xlsx.body.subarray(0, 2).toString("ascii")).toBe("PK");
      const reportWorkbook = new ExcelJS.Workbook();
      await reportWorkbook.xlsx.load(xlsx.body as unknown as ExcelJS.Buffer);
      expect(reportWorkbook.worksheets.map((sheet) => sheet.name)).toEqual([
        "班级汇总",
        "小组汇总",
        "个人统计",
        "逐课明细",
        "需关注名单",
      ]);
      expect(reportWorkbook.getWorksheet("逐课明细")?.rowCount).toBeGreaterThan(1);

      const template = await admin.raw(`/classes/${classId}/import/template.xlsx`);
      expect(template.status).toBe(200);
      expect(template.headers.get("content-disposition")).toContain("student-import-template.xlsx");
      const templateWorkbook = new ExcelJS.Workbook();
      await templateWorkbook.xlsx.load(template.body as unknown as ExcelJS.Buffer);
      expect(templateWorkbook.worksheets.map((sheet) => sheet.name)).toEqual(["学员名单", "填写说明"]);
      const roster = templateWorkbook.getWorksheet("学员名单")!;
      expect(roster.getRow(1).values).toEqual([, "姓名", "法名", "电话", "小组", "状态", "身份", "备注"]);
      expect(roster.getCell("D2").dataValidation).toMatchObject({ type: "list", formulae: ['"第一组"'] });
      expect(roster.getCell("E2").dataValidation).toMatchObject({ type: "list", allowBlank: true });
    });
  });

  it("自定义日期报表和两种导出严格使用同一已选范围，并拒绝无效日期", async () => {
    await withApi(async ({ admin, adminId }) => {
      const classId = await createClass(admin, adminId, "自定义范围班", 1);
      const groupId = (await groups(admin, classId))[0].id;
      const studentId = await addStudent(admin, classId, groupId, "范围导出学员", "13700000261");
      const firstDue = addDays(shanghaiToday(), -14);
      const secondDue = addDays(shanghaiToday(), -7);
      expect((await admin.post(`/classes/${classId}/schedule/generate`, {
        firstDueDate: firstDue,
        count: 2,
      })).status).toBe(200);
      const lessons = (await admin.get<{
        lessons: Array<{ id: number; lessonNumber: number }>;
      }>(`/classes/${classId}/lessons`)).body.lessons;
      expect((await admin.put(`/classes/${classId}/attendance/${lessons[0].id}`, {
        records: [{ studentId, outline: "yes", groupStudy: "onsite", classStudy: "online" }],
      })).status).toBe(200);
      expect((await admin.put(`/classes/${classId}/attendance/${lessons[1].id}`, {
        records: [{ studentId, outline: "no", groupStudy: "absent", classStudy: "observer" }],
      })).status).toBe(200);

      const query = `range=custom&from=${firstDue}&to=${firstDue}`;
      const report = await admin.get<{
        rangeLabel: string;
        filters: { from: string; to: string };
        details: Array<{ lessonSequence: number }>;
      }>(`/classes/${classId}/reports?${query}`);
      expect(report.status).toBe(200);
      expect(report.body.filters).toEqual({ from: firstDue, to: firstDue });
      expect(report.body.rangeLabel).toBe(`${firstDue} 至 ${firstDue}`);
      expect(report.body.details).toHaveLength(3);
      expect(report.body.details.every((row) => row.lessonSequence === 1)).toBe(true);

      const csv = await admin.raw(`/classes/${classId}/export.csv?${query}`);
      expect(csv.status).toBe(200);
      expect(csv.headers.get("content-disposition")).toContain(
        `class-study-report-${firstDue.replaceAll("-", "")}-${firstDue.replaceAll("-", "")}.csv`,
      );
      const csvText = csv.body.toString("utf8");
      expect(csvText).toContain(`${firstDue} 至 ${firstDue}`);
      expect(csvText).toContain("\"1\"");
      expect(csvText).not.toContain(`\"${secondDue}\"`);

      const xlsx = await admin.raw(`/classes/${classId}/export.xlsx?${query}`);
      expect(xlsx.status).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(xlsx.body as unknown as ExcelJS.Buffer);
      const detailSheet = workbook.getWorksheet("逐课明细")!;
      const detailRows = Array.from(
        { length: Math.max(0, detailSheet.actualRowCount - 1) },
        (_, index) => detailSheet.getRow(index + 2),
      );
      expect(detailRows).toHaveLength(3);
      expect(detailRows.every((row) => row.getCell(6).value === 1)).toBe(true);
      expect(workbook.getWorksheet("班级汇总")!.getCell("B2").value).toBe(`${firstDue} 至 ${firstDue}`);

      expect((await admin.get(`/classes/${classId}/reports?range=custom`)).status).toBe(400);
      expect((await admin.get(`/classes/${classId}/reports?range=custom&from=${secondDue}&to=${firstDue}`)).status).toBe(400);
      expect((await admin.get(`/classes/${classId}/reports?range=custom&from=${firstDue}&to=${addDays(shanghaiToday(), 1)}`)).status).toBe(400);
    });
  });
});

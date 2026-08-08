import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { openDatabase } from "../src/server/db.js";
import {
  importTeaRoster,
  parseTeaRosterWorkbook,
  type TeaRosterCredential
} from "../src/server/services/teaRosterImport.js";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

async function fixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.getCell("B2").value = "班级名称";
  sheet.getCell("C2").value = "进度";
  sheet.getCell("D2").value = "FDY";
  sheet.getCell("F2").value = "时间";
  sheet.getCell("G2").value = "班长";
  const rows: Array<Array<string | number | null>> = [
    ["A2", "TD1", "同德2", "无", null, null, "善含", null, "净瑞"],
    ["B2", "TX3", "百法二遍", "善仰法师", null, null, null, null, "照忏"],
    ["C1", "TX8", "百法第一遍", "果明法师", null, "周日19:00-21:00", "道如", 18940845580, "照忏", "正谛（试听中）"],
    ["E", "TI1", "智慧人生", "法信", 19921878005, "周一晚上", "照珆", null, "道媛", "利娟（计划出海，建议转线上）", "照鑫"]
  ];
  rows.forEach((values, index) => {
    values.forEach((value, column) => { sheet.getRow(index + 4).getCell(column + 1).value = value; });
  });
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}

describe("喝茶名单正式导入", () => {
  it("遵守最终姓名、跳过、辅导员与课程映射规则", async () => {
    const preview = await parseTeaRosterWorkbook(await fixture());
    expect(preview.classes).toHaveLength(4);
    expect(preview.classes.find((item) => item.className === "TD1")).toMatchObject({ counselor: "善含", monitor: null });
    expect(preview.classes.find((item) => item.className === "TX8")).toMatchObject({
      courseSeriesKey: "hundred_dharmas", courseRound: 1, meetingTime: "周日19:00-21:00"
    });
    expect(preview.people.some((person) => person.dharmaName === "利娟")).toBe(false);
    expect(preview.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawName: "利娟（计划出海，建议转线上）" }),
      expect.objectContaining({ className: "TX8", rawName: "照忏" }),
      expect.objectContaining({ rawName: "正谛（试听中）" })
    ]));
  });

  it("一次事务创建班级、未分组名册、账号和班长，并可安全重复执行", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const preview = await parseTeaRosterWorkbook(await fixture());
    const admin = db.prepare("select id from users where is_admin = 1").get() as { id: number };
    let savedCredentials: TeaRosterCredential[] = [];
    const result = await importTeaRoster(db, preview, admin.id, {
      persistCredentials: async (credentials) => { savedCredentials = credentials; }
    });

    expect(result).toMatchObject({ alreadyImported: false, classes: 4, enrollments: 6, accounts: 6, monitors: 2 });
    expect(savedCredentials).toHaveLength(6);
    expect(db.prepare("select count(*) as count from classes").get()).toEqual({ count: 4 });
    expect(db.prepare("select count(*) as count from groups where name = '未分组'").get()).toEqual({ count: 4 });
    expect(db.prepare("select count(*) as count from class_monitors").get()).toEqual({ count: 2 });
    expect(db.prepare("select count(*) as count from users where is_admin = 0 and must_change_password = 1").get()).toEqual({ count: 6 });
    expect(db.prepare("select meeting_time as meetingTime, source_progress as sourceProgress, course_series_key as seriesKey from classes where name = 'TI1'").get())
      .toEqual({ meetingTime: "周一晚上", sourceProgress: "智慧人生·第1遍（具体起始课待辅导员确认）", seriesKey: "wisdom_life" });

    const repeated = await importTeaRoster(db, preview, admin.id);
    expect(repeated.alreadyImported).toBe(true);
    expect(repeated.credentials).toEqual([]);
    expect(db.prepare("select count(*) as count from classes").get()).toEqual({ count: 4 });
  });
});

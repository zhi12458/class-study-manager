import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { openDatabase } from "../src/server/db.js";
import { createPasswordHash } from "../src/server/auth.js";
import { shanghaiToday } from "../src/server/services/roster.js";
import {
  applyTeaRosterUpdate,
  parseTeaRosterUpdateWorkbook,
  preflightTeaRosterUpdate
} from "../src/server/services/teaRosterUpdate.js";
import type { TeaRosterCredential } from "../src/server/services/teaRosterImport.js";

const CLASS_MAPPING = [
  "TD2", "TD3", "TD4", "TX1", "TX2", "TX4", "TX5", "TX6", "TX10",
  "TX8", "TX9", "TX7", "TX12", "TX14", "TX3", "TX13", "TX11"
] as const;

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

type FixtureRow = {
  monitor?: ExcelJS.CellValue;
  monitorPhone?: string | number;
  students?: ExcelJS.CellValue[];
  remarks?: string;
};

async function updateFixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("更新名单");
  sheet.getCell("A3").value = "班级名称";
  sheet.getCell("V3").value = "备注";
  const rows = new Map<number, FixtureRow>([
    [1, {
      monitor: "善宇", students: ["观旷", "善若(外)", "善训"],
      remarks: "1. 加一个账号，善训13357735412\n2. 删除观旷和善若"
    }],
    [2, { monitor: "观莨", students: ["慧恒（外）", "净诏"] }],
    [3, { monitor: "观元" }],
    [4, {
      monitor: { richText: [
        { text: "道卓 ", font: { strike: true } },
        { text: "悟枚", font: { color: { argb: "FFFF0000" } } }
      ] },
      monitorPhone: 15395988131,
      students: ["道卓", "悟慎"]
    }],
    [5, { monitor: "善芥", students: ["惟昭"] }],
    [6, { monitor: "果娓", students: ["心禅"], remarks: "增加一个心婵的账号，13844019874" }],
    [7, { monitor: "净可" }],
    [8, { monitor: "善慧", monitorPhone: 18518982664, students: ["海涵", "清淳"] }],
    [9, { monitor: "观尚", students: ["清哲"] }],
    [10, { monitor: "道如", students: ["观珍"], remarks: "删除观珍" }],
    [11, {
      monitor: "清滟",
      students: [
        { richText: [{ text: "清娅" }, { text: "（考勤）", font: { color: { argb: "FFFF0000" } } }] },
        { richText: [{ text: "心溶\n" }, { text: "（考勤）", font: { strike: true } }] }
      ],
      remarks: "增加清娅账号18580872718"
    }],
    [12, { monitor: "华媛" }],
    [13, { monitor: "清振" }],
    [14, {
      monitor: "清旨",
      students: [
        { richText: [{ text: "印现 ", font: { strike: true } }, { text: "观平" }] },
        { richText: [{ text: "金玲", font: { strike: true } }, { text: "照琝" }] }
      ]
    }],
    [15, { monitor: "惟政", monitorPhone: 13548723493 }],
    [16, { monitor: "照晟" }],
    [17, {}]
  ]);

  for (let number = 1; number <= 17; number += 1) {
    const row = sheet.getRow(number + 3);
    const fixture = rows.get(number)!;
    row.getCell(1).value = number;
    row.getCell(2).value = number <= 3 ? "同德1" : "D第一遍";
    row.getCell(3).value = `辅导员${number}`;
    row.getCell(5).value = "周一19:00";
    row.getCell(6).value = fixture.monitor ?? null;
    row.getCell(7).value = fixture.monitorPhone ?? null;
    fixture.students?.forEach((value, index) => { row.getCell(8 + index).value = value; });
    row.getCell(22).value = fixture.remarks ?? null;
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function parseFixture() {
  return parseTeaRosterUpdateWorkbook(
    await updateFixture(),
    "测试用更新名单.xlsx",
    { allowUnconfirmedSource: true }
  );
}

function seedDatabase() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const admin = db.prepare("select id from users where is_admin = 1").get() as { id: number };
  const classIds = new Map<string, number>();
  const groupIds = new Map<string, number>();
  for (const name of ["TD1", ...CLASS_MAPPING, "TI1"]) {
    const classId = Number(db.prepare(
      "insert into classes (name, counselor_user_id, cadence_mode, created_by) values (?, ?, 'same_week', ?)"
    ).run(name, admin.id, admin.id).lastInsertRowid);
    classIds.set(name, classId);
    groupIds.set(name, Number(db.prepare(
      "insert into groups (class_id, name, sort_order) values (?, '未分组', 1)"
    ).run(classId).lastInsertRowid));
    if (name !== "TD1" && name !== "TI1") {
      const today = shanghaiToday();
      db.prepare(
        `insert into lessons
           (class_id, sequence, title, lesson_type, cadence_mode, outline_due_date, group_study_due_date, class_study_due_date)
         values (?, 1, '第一课', 'regular', 'same_week', ?, ?, ?)`
      ).run(classId, today, today, today);
    }
  }

  const enrollments = new Map<string, { enrollmentId: number; personId: number }>();
  const addEnrollment = (className: string, dharmaName: string, note: string | null = null) => {
    const personId = Number(db.prepare("insert into persons (name, dharma_name, phone) values ('', ?, null)")
      .run(dharmaName).lastInsertRowid);
    const enrollmentId = Number(db.prepare(
      "insert into enrollments (class_id, person_id, note, active_from_sequence) values (?, ?, ?, 1)"
    ).run(classIds.get(className)!, personId, note).lastInsertRowid);
    db.prepare("insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)")
      .run(enrollmentId, groupIds.get(className)!);
    enrollments.set(`${className}|${dharmaName}`, { enrollmentId, personId });
    return { enrollmentId, personId };
  };

  for (const [className, dharmaName, note] of [
    ["TD2", "观旷", null], ["TD2", "善若", "外地/线上学员"], ["TD2", "善训", null],
    ["TD3", "慧恒", null], ["TD3", "净诏", "外地/线上学员"],
    ["TX1", "道卓", null], ["TX1", "悟枚", null],
    ["TX4", "心禅", null],
    ["TX6", "海涵", null], ["TX6", "善慧", null],
    ["TX10", "净芬", null], ["TX8", "观珍", null],
    ["TX9", "心溶", "原表括注：考勤"], ["TX9", "清娅", null],
    ["TX14", "印现", null], ["TX14", "金玲", null],
    ["TX3", "惟政", null]
  ] as Array<[string, string, string | null]>) addEnrollment(className, dharmaName, note);

  const setOldMonitor = (className: string, dharmaName: string, username: string) => {
    const person = enrollments.get(`${className}|${dharmaName}`)!;
    const userId = Number(db.prepare(
      "insert into users (person_id, username, password_hash, display_name, active, must_change_password) values (?, ?, ?, ?, 1, 0)"
    ).run(person.personId, username, createPasswordHash("old-password"), dharmaName).lastInsertRowid);
    db.prepare("insert into class_monitors (class_id, enrollment_id, user_id, assigned_by) values (?, ?, ?, ?)")
      .run(classIds.get(className)!, person.enrollmentId, userId, admin.id);
    return userId;
  };
  const oldMonitorUsers = {
    daozhuo: setOldMonitor("TX1", "道卓", "daozhuo-old"),
    haihan: setOldMonitor("TX6", "海涵", "haihan-old")
  };

  return { db, adminId: admin.id, classIds, enrollments, oldMonitorUsers };
}

describe("喝茶名单安全增量更新", () => {
  it("默认只接受已确认 SHA-256 的正式更新表", async () => {
    await expect(parseTeaRosterUpdateWorkbook(await updateFixture())).rejects.toThrow("SHA-256");
  });

  it("解析数字班名、删除线和已确认的更新操作", async () => {
    const preview = await parseFixture();
    expect(preview.summary).toEqual({
      classesRenamed: 17,
      withdrawn: 4,
      added: 3,
      notesUpdated: 3,
      peopleRenamed: 2,
      monitorsChanged: 3,
      attendanceAssistantsAssigned: 3,
      accountsExpected: 6
    });
    expect(preview.classes.map((item) => [item.previousName, item.className])).toEqual(
      CLASS_MAPPING.map((name, index) => [name, String(index + 1)])
    );
    expect(preview.classes.find((item) => item.previousName === "TX1")).toMatchObject({
      monitor: "悟枚", monitorStruckText: "道卓", monitorPhone: "+8615395988131"
    });
    const tx9 = preview.classes.find((item) => item.previousName === "TX9")!;
    expect(tx9.students.find((item) => item.dharmaName === "清娅")?.markers).toContain("考勤");
    expect(tx9.students.find((item) => item.dharmaName === "心溶")).toMatchObject({ markers: [], struckText: "（考勤）" });
    const tx14 = preview.classes.find((item) => item.previousName === "TX14")!;
    expect(tx14.students.find((item) => item.dharmaName === "观平")?.struckText).toBe("印现");
    expect(tx14.students.find((item) => item.dharmaName === "照琝")?.struckText).toBe("金玲");
  });

  it("一个事务应用资料、状态、班长、考勤员和班名，并按来源哈希幂等", async () => {
    const preview = await parseFixture();
    const seeded = seedDatabase();
    expect(preflightTeaRosterUpdate(seeded.db, preview, seeded.adminId, { allowUnconfirmedSource: true })).toMatchObject({
      ready: true, alreadyApplied: false, classesChecked: 17, operationsChecked: 35
    });
    let persisted: TeaRosterCredential[] = [];
    const result = await applyTeaRosterUpdate(seeded.db, preview, seeded.adminId, {
      persistCredentials: async (credentials) => { persisted = credentials; },
      allowUnconfirmedSource: true
    });

    expect(result).toMatchObject({
      alreadyApplied: false,
      classesRenamed: 17,
      withdrawn: 4,
      added: 3,
      monitorsChanged: 3,
      attendanceAssistantsAssigned: 3,
      accountsCreated: 6
    });
    expect(persisted).toHaveLength(6);
    expect(new Set(persisted.map((item) => item.dharmaName))).toEqual(
      new Set(["悟枚", "善慧", "惟政", "善训", "心禅", "清娅"])
    );
    expect(seeded.db.prepare("select name from classes order by id").all()).toEqual([
      { name: "TD1" }, ...Array.from({ length: 17 }, (_, index) => ({ name: String(index + 1) })), { name: "TI1" }
    ]);

    for (const [className, dharmaName] of [["TD2", "观旷"], ["TD2", "善若"], ["TX10", "净芬"], ["TX8", "观珍"]]) {
      const classId = seeded.classIds.get(className)!;
      expect(seeded.db.prepare(
        `select es.status, es.effective_from_sequence as effectiveFromSequence
           from enrollments e join persons p on p.id = e.person_id
           join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
          where e.class_id = ? and p.dharma_name = ?`
      ).get(classId, dharmaName)).toEqual({ status: "withdrawn", effectiveFromSequence: 2 });
    }
    for (const [className, dharmaName] of [["TX1", "悟慎"], ["TX2", "惟昭"], ["TX6", "清淳"]]) {
      expect(seeded.db.prepare(
        `select e.active_from_sequence as activeFromSequence, g.name as groupName
           from enrollments e join persons p on p.id = e.person_id
           join group_assignments ga on ga.enrollment_id = e.id and ga.effective_to_sequence is null
           join groups g on g.id = ga.group_id
          where e.class_id = ? and p.dharma_name = ?`
      ).get(seeded.classIds.get(className)!, dharmaName)).toEqual({ activeFromSequence: 2, groupName: "未分组" });
    }

    expect(seeded.db.prepare(
      "select p.dharma_name as dharmaName, e.note from enrollments e join persons p on p.id = e.person_id where e.class_id = ? order by p.dharma_name"
    ).all(seeded.classIds.get("TD3")!)).toEqual([
      { dharmaName: "净诏", note: null }, { dharmaName: "慧恒", note: "外地/线上学员" }
    ]);
    expect(seeded.db.prepare("select dharma_name as dharmaName from persons where id = ?")
      .get(seeded.enrollments.get("TX14|印现")!.personId)).toEqual({ dharmaName: "观平" });
    expect(seeded.db.prepare("select dharma_name as dharmaName from persons where id = ?")
      .get(seeded.enrollments.get("TX14|金玲")!.personId)).toEqual({ dharmaName: "照琝" });
    expect(seeded.db.prepare("select count(*) as count from class_attendance_assistants").get()).toEqual({ count: 3 });
    expect(seeded.db.prepare("select active from users where id = ?").get(seeded.oldMonitorUsers.daozhuo)).toEqual({ active: 0 });
    expect(seeded.db.prepare("select active from users where id = ?").get(seeded.oldMonitorUsers.haihan)).toEqual({ active: 0 });

    const repeated = await applyTeaRosterUpdate(seeded.db, preview, seeded.adminId, { allowUnconfirmedSource: true });
    expect(repeated.alreadyApplied).toBe(true);
    expect(repeated.credentials).toEqual([]);
  });

  it("当前数据与更新前预期不符时停止且不产生部分修改", async () => {
    const preview = await parseFixture();
    const seeded = seedDatabase();
    seeded.db.prepare("update enrollments set note = '人工新备注' where id = ?")
      .run(seeded.enrollments.get("TD3|慧恒")!.enrollmentId);
    let persisted = false;

    await expect(applyTeaRosterUpdate(seeded.db, preview, seeded.adminId, {
      persistCredentials: async () => { persisted = true; },
      allowUnconfirmedSource: true
    })).rejects.toThrow("备注已经变化");
    expect(persisted).toBe(false);
    expect(seeded.db.prepare("select name from classes where id = ?").get(seeded.classIds.get("TD2")!)).toEqual({ name: "TD2" });
    expect(seeded.db.prepare("select count(*) as count from data_import_runs").get()).toEqual({ count: 0 });
  });

  it("数据库预演遇到归档同名班级时拒绝猜测更新对象", async () => {
    const preview = await parseFixture();
    const seeded = seedDatabase();
    seeded.db.prepare(
      "insert into classes (name, counselor_user_id, cadence_mode, archived, created_by) values ('TX1', ?, 'same_week', 1, ?)"
    ).run(seeded.adminId, seeded.adminId);
    expect(() => preflightTeaRosterUpdate(
      seeded.db,
      preview,
      seeded.adminId,
      { allowUnconfirmedSource: true }
    )).toThrow("同名班级“TX1”");
  });

  it("拒绝非管理员执行正式更新", async () => {
    const preview = await parseFixture();
    const seeded = seedDatabase();
    await expect(applyTeaRosterUpdate(
      seeded.db,
      preview,
      seeded.oldMonitorUsers.daozhuo,
      { persistCredentials: async () => undefined, allowUnconfirmedSource: true }
    )).rejects.toThrow("必须由有效管理员执行");
    expect(seeded.db.prepare("select name from classes where id = ?").get(seeded.classIds.get("TD2")!)).toEqual({ name: "TD2" });
  });

  it("一次性密码无法安全保存时回滚数据库", async () => {
    const preview = await parseFixture();
    const seeded = seedDatabase();
    await expect(applyTeaRosterUpdate(seeded.db, preview, seeded.adminId, {
      persistCredentials: async () => { throw new Error("磁盘不可写"); },
      allowUnconfirmedSource: true
    })).rejects.toThrow("磁盘不可写");
    expect(seeded.db.prepare("select name from classes where id = ?").get(seeded.classIds.get("TD2")!)).toEqual({ name: "TD2" });
    expect(seeded.db.prepare("select count(*) as count from users where username = '+8615395988131'").get()).toEqual({ count: 0 });
    expect(seeded.db.prepare("select count(*) as count from data_import_runs").get()).toEqual({ count: 0 });
  });
});

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import { normalizePhone } from "../../shared/phone.js";
import { createPasswordHash, generateTemporaryPassword } from "../auth.js";
import { getNextEffectiveSequence, setEnrollmentStatusFromSequence } from "./roster.js";
import type { TeaRosterCredential } from "./teaRosterImport.js";

const CLASS_MAPPING = [
  "TD2", "TD3", "TD4", "TX1", "TX2", "TX4", "TX5", "TX6", "TX10",
  "TX8", "TX9", "TX7", "TX12", "TX14", "TX3", "TX13", "TX11"
] as const;

export const CONFIRMED_TEA_ROSTER_UPDATE_SHA256 =
  "48bb418dfa9eb9c35713986b28282eefa84fa28bc70061c86f1b6fdf9251f4dd";

const CHOSEN_SLASH_NAMES: Record<string, string> = {
  "道汝/耀思": "道汝",
  "隆慧/清振": "清振",
  "善现/清峰": "善现"
};

const SKIPPED_DUPLICATE_PLACEMENTS = new Set(["TX8|照忏", "TX11|道乐"]);

type ParsedCellText = {
  activeText: string;
  struckText: string;
};

export type TeaRosterUpdateStudent = {
  dharmaName: string;
  notes: string[];
  markers: string[];
  struckText: string;
};

export type TeaRosterUpdateClass = {
  number: number;
  previousName: string;
  className: string;
  progress: string;
  counselor: string;
  counselorPhone: string | null;
  meetingTime: string | null;
  monitor: string | null;
  monitorPhone: string | null;
  monitorStruckText: string;
  students: TeaRosterUpdateStudent[];
  remarks: string;
};

export type TeaRosterUpdateOperation = {
  kind: "rename_class" | "withdraw" | "add" | "update_note" | "rename_person" | "change_monitor" | "assign_attendance_assistant";
  className: string;
  description: string;
};

export type TeaRosterUpdatePreview = {
  sourceLabel: string;
  sourceSha256: string;
  sourceSheet: string;
  sourceRange: string;
  classes: TeaRosterUpdateClass[];
  operations: TeaRosterUpdateOperation[];
  summary: {
    classesRenamed: number;
    withdrawn: number;
    added: number;
    notesUpdated: number;
    peopleRenamed: number;
    monitorsChanged: number;
    attendanceAssistantsAssigned: number;
    accountsExpected: number;
  };
};

export type TeaRosterUpdateResult = {
  alreadyApplied: boolean;
  sourceSha256: string;
  classesRenamed: number;
  withdrawn: number;
  added: number;
  notesUpdated: number;
  peopleRenamed: number;
  monitorsChanged: number;
  attendanceAssistantsAssigned: number;
  accountsCreated: number;
  credentials: TeaRosterCredential[];
};

export type TeaRosterUpdatePreflight = {
  ready: boolean;
  alreadyApplied: boolean;
  sourceSha256: string;
  classesChecked: number;
  operationsChecked: number;
};

type TeaRosterUpdateSafetyOptions = {
  /** Test fixtures may opt out; production callers must use the confirmed workbook bytes. */
  allowUnconfirmedSource?: boolean;
};

type ClassChange = {
  previousName: string;
  finalName: string;
};

type WithdrawalChange = {
  className: string;
  dharmaName: string;
};

type AdditionChange = {
  className: string;
  dharmaName: string;
};

type NoteChange = {
  className: string;
  dharmaName: string;
  previousNote: string | null;
  nextNote: string | null;
};

type PersonRenameChange = {
  className: string;
  previousDharmaName: string;
  nextDharmaName: string;
};

type AccountRoleChange = {
  className: string;
  dharmaName: string;
  phone: string;
};

const CLASS_CHANGES: ClassChange[] = CLASS_MAPPING.map((previousName, index) => ({
  previousName,
  finalName: String(index + 1)
}));

const WITHDRAWALS: WithdrawalChange[] = [
  { className: "TD2", dharmaName: "观旷" },
  { className: "TD2", dharmaName: "善若" },
  { className: "TX10", dharmaName: "净芬" },
  { className: "TX8", dharmaName: "观珍" }
];

const ADDITIONS: AdditionChange[] = [
  { className: "TX1", dharmaName: "悟慎" },
  { className: "TX2", dharmaName: "惟昭" },
  { className: "TX6", dharmaName: "清淳" }
];

const NOTE_CHANGES: NoteChange[] = [
  { className: "TD3", dharmaName: "慧恒", previousNote: null, nextNote: "外地/线上学员" },
  { className: "TD3", dharmaName: "净诏", previousNote: "外地/线上学员", nextNote: null },
  { className: "TX9", dharmaName: "心溶", previousNote: "原表括注：考勤", nextNote: null }
];

const PERSON_RENAMES: PersonRenameChange[] = [
  { className: "TX14", previousDharmaName: "印现", nextDharmaName: "观平" },
  { className: "TX14", previousDharmaName: "金玲", nextDharmaName: "照琝" }
];

const MONITOR_CHANGES: AccountRoleChange[] = [
  { className: "TX1", dharmaName: "悟枚", phone: "+8615395988131" },
  { className: "TX6", dharmaName: "善慧", phone: "+8618518982664" },
  { className: "TX3", dharmaName: "惟政", phone: "+8613548723493" }
];

const EXPECTED_PREVIOUS_MONITORS = new Map<string, string | null>([
  ["TX1", "道卓"],
  ["TX6", "海涵"],
  ["TX3", null]
]);

const ATTENDANCE_ASSISTANTS: AccountRoleChange[] = [
  { className: "TD2", dharmaName: "善训", phone: "+8613357735412" },
  { className: "TX4", dharmaName: "心禅", phone: "+8613844019874" },
  { className: "TX9", dharmaName: "清娅", phone: "+8618580872718" }
];

function rawCellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && "text" in value) return String((value as { text: unknown }).text);
  return String(value);
}

function richCellText(value: unknown): ParsedCellText {
  if (value && typeof value === "object" && "richText" in value) {
    const runs = (value as { richText: Array<{ text?: unknown; font?: { strike?: boolean } }> }).richText;
    return {
      activeText: runs.filter((run) => !run.font?.strike).map((run) => String(run.text ?? "")).join(""),
      struckText: runs.filter((run) => run.font?.strike).map((run) => String(run.text ?? "")).join("")
    };
  }
  return { activeText: rawCellText(value), struckText: "" };
}

function compact(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function parseDharmaName(value: unknown): TeaRosterUpdateStudent | null {
  const rich = richCellText(value);
  const rawName = compact(rich.activeText);
  if (!rawName) return null;
  const selected = CHOSEN_SLASH_NAMES[rawName] ?? rawName;
  const notes: string[] = [];
  const markers: string[] = [];
  let dharmaName = selected.replace(/[（(]([^）)]+)[）)]/g, (_match, content: string) => {
    if (content === "外") notes.push("外地/线上学员");
    else if (content === "考勤") markers.push("考勤");
    else notes.push(`原表括注：${content}`);
    return "";
  });
  const honorific = dharmaName.match(/(法师|师父|师)$/)?.[1];
  if (honorific) {
    dharmaName = dharmaName.slice(0, -honorific.length);
    notes.push(`称谓：${honorific}`);
  }
  dharmaName = dharmaName.trim();
  if (!dharmaName) throw new Error(`无法识别法名：${rawName}`);
  return {
    dharmaName,
    notes: [...new Set(notes)],
    markers: [...new Set(markers)],
    struckText: compact(rich.struckText)
  };
}

function parsePhone(value: unknown): string | null {
  const text = rawCellText(value).trim();
  return text ? normalizePhone(text) : null;
}

function requireSource(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`更新表校验失败：${message}`);
}

function classFromPreview(preview: TeaRosterUpdatePreview, previousName: string): TeaRosterUpdateClass {
  const item = preview.classes.find((candidate) => candidate.previousName === previousName);
  if (!item) throw new Error(`更新表缺少 ${previousName}`);
  return item;
}

function hasStudent(item: TeaRosterUpdateClass, dharmaName: string): boolean {
  return item.students.some((student) => student.dharmaName === dharmaName);
}

function validateConfirmedSource(classes: TeaRosterUpdateClass[]): void {
  requireSource(classes.length === CLASS_MAPPING.length, `应有 17 个班级，实际为 ${classes.length} 个`);
  for (let index = 0; index < CLASS_MAPPING.length; index += 1) {
    const item = classes[index];
    const number = index + 1;
    requireSource(item?.number === number, `缺少编号 ${number} 或编号顺序错误`);
    requireSource(item.previousName === CLASS_MAPPING[index], `编号 ${number} 的旧班级映射不正确`);
  }

  const byPreviousName = new Map(classes.map((item) => [item.previousName, item]));
  const requireClass = (name: string) => {
    const item = byPreviousName.get(name);
    requireSource(item, `缺少 ${name}`);
    return item;
  };

  const tx1 = requireClass("TX1");
  requireSource(tx1.monitor === "悟枚" && tx1.monitorPhone === "+8615395988131", "TX1 新班长或手机号不是悟枚 15395988131");
  requireSource(tx1.monitorStruckText.includes("道卓"), "TX1 班长单元格没有保留道卓的删除线变更");
  requireSource(hasStudent(tx1, "道卓") && hasStudent(tx1, "悟慎"), "TX1 应保留道卓并新增悟慎");

  const tx2 = requireClass("TX2");
  requireSource(hasStudent(tx2, "惟昭"), "TX2 缺少新增学员惟昭");

  const tx6 = requireClass("TX6");
  requireSource(tx6.monitor === "善慧" && tx6.monitorPhone === "+8618518982664", "TX6 新班长或手机号不是善慧 18518982664");
  requireSource(hasStudent(tx6, "海涵") && hasStudent(tx6, "清淳"), "TX6 应保留海涵并新增清淳");

  const tx10 = requireClass("TX10");
  requireSource(!hasStudent(tx10, "净芬"), "TX10 的净芬仍在新名单中");

  const tx8 = requireClass("TX8");
  requireSource(tx8.remarks.includes("删除观珍"), "TX8 备注没有确认删除观珍");

  const tx3 = requireClass("TX3");
  requireSource(tx3.monitor === "惟政" && tx3.monitorPhone === "+8613548723493", "TX3 新班长或手机号不是惟政 13548723493");

  const td2 = requireClass("TD2");
  requireSource(td2.remarks.includes("善训") && td2.remarks.includes("13357735412"), "TD2 备注缺少善训考勤账号信息");
  requireSource(td2.remarks.includes("删除观旷和善若"), "TD2 备注没有确认删除观旷和善若");

  const tx4 = requireClass("TX4");
  requireSource(hasStudent(tx4, "心禅") && tx4.remarks.includes("13844019874"), "TX4 缺少心禅或其账号手机号");

  const tx9 = requireClass("TX9");
  const qingya = tx9.students.find((student) => student.dharmaName === "清娅");
  const xinrong = tx9.students.find((student) => student.dharmaName === "心溶");
  requireSource(qingya?.markers.includes("考勤"), "TX9 清娅没有有效的考勤标记");
  requireSource(tx9.remarks.includes("18580872718"), "TX9 备注缺少清娅账号手机号");
  requireSource(xinrong && !xinrong.markers.includes("考勤") && xinrong.struckText.includes("考勤"), "TX9 心溶的考勤标记没有使用删除线取消");

  const tx14 = requireClass("TX14");
  const guanping = tx14.students.find((student) => student.dharmaName === "观平");
  const zhaomin = tx14.students.find((student) => student.dharmaName === "照琝");
  requireSource(guanping?.struckText.includes("印现"), "TX14 印现改观平的删除线信息不完整");
  requireSource(zhaomin?.struckText.includes("金玲"), "TX14 金玲改照琝的删除线信息不完整");

  const td3 = requireClass("TD3");
  requireSource(td3.students.find((student) => student.dharmaName === "慧恒")?.notes.includes("外地/线上学员"), "TD3 慧恒缺少外地/线上标记");
  requireSource(!td3.students.find((student) => student.dharmaName === "净诏")?.notes.includes("外地/线上学员"), "TD3 净诏仍带外地/线上标记");
}

function buildOperations(): TeaRosterUpdateOperation[] {
  return [
    ...CLASS_CHANGES.map((item) => ({
      kind: "rename_class" as const,
      className: item.previousName,
      description: `${item.previousName} 改名为 ${item.finalName}`
    })),
    ...WITHDRAWALS.map((item) => ({
      kind: "withdraw" as const,
      className: item.className,
      description: `${item.dharmaName} 从下一课起设为退学并保留历史`
    })),
    ...ADDITIONS.map((item) => ({
      kind: "add" as const,
      className: item.className,
      description: `${item.dharmaName} 从下一课起加入未分组名单`
    })),
    ...NOTE_CHANGES.map((item) => ({
      kind: "update_note" as const,
      className: item.className,
      description: `${item.dharmaName} 的备注改为${item.nextNote ? `“${item.nextNote}”` : "空"}`
    })),
    ...PERSON_RENAMES.map((item) => ({
      kind: "rename_person" as const,
      className: item.className,
      description: `${item.previousDharmaName} 的法名改为 ${item.nextDharmaName}`
    })),
    ...MONITOR_CHANGES.map((item) => ({
      kind: "change_monitor" as const,
      className: item.className,
      description: `班长改为 ${item.dharmaName}，账号 ${item.phone}`
    })),
    ...ATTENDANCE_ASSISTANTS.map((item) => ({
      kind: "assign_attendance_assistant" as const,
      className: item.className,
      description: `${item.dharmaName} 增加考勤员账号 ${item.phone}`
    }))
  ];
}

export async function parseTeaRosterUpdateWorkbook(
  input: Buffer,
  sourceLabel = "喝茶考勤表单-更新.xlsx",
  options: TeaRosterUpdateSafetyOptions = {}
): Promise<TeaRosterUpdatePreview> {
  const sourceSha256 = createHash("sha256").update(input).digest("hex");
  if (!options.allowUnconfirmedSource && sourceSha256 !== CONFIRMED_TEA_ROSTER_UPDATE_SHA256) {
    throw new Error(
      `更新表与已确认文件不一致（SHA-256：${sourceSha256}），已停止更新，请重新核对来源文件`
    );
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("工作簿没有工作表");

  const classes: TeaRosterUpdateClass[] = [];
  const seenNumbers = new Set<number>();
  for (let rowNumber = 4; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const numberText = rawCellText(row.getCell(1).value).trim();
    if (!numberText) continue;
    const number = Number(numberText);
    requireSource(Number.isInteger(number) && number >= 1 && number <= CLASS_MAPPING.length, `第 ${rowNumber} 行班级编号无效`);
    requireSource(!seenNumbers.has(number), `班级编号 ${number} 重复`);
    seenNumbers.add(number);

    const counselor = parseDharmaName(row.getCell(3).value);
    const monitorCell = richCellText(row.getCell(6).value);
    const monitor = parseDharmaName(row.getCell(6).value);
    requireSource(counselor, `编号 ${number} 缺少辅导员`);
    const roster = new Map<string, TeaRosterUpdateStudent>();
    if (monitor) roster.set(monitor.dharmaName, monitor);
    for (let column = 8; column <= 21; column += 1) {
      const student = parseDharmaName(row.getCell(column).value);
      if (!student) continue;
      if (SKIPPED_DUPLICATE_PLACEMENTS.has(`${CLASS_MAPPING[number - 1]}|${student.dharmaName}`)) continue;
      const existing = roster.get(student.dharmaName);
      roster.set(student.dharmaName, existing ? {
        dharmaName: student.dharmaName,
        notes: [...new Set([...existing.notes, ...student.notes])],
        markers: [...new Set([...existing.markers, ...student.markers])],
        struckText: [existing.struckText, student.struckText].filter(Boolean).join("、")
      } : student);
    }
    classes.push({
      number,
      previousName: CLASS_MAPPING[number - 1],
      className: String(number),
      progress: compact(rawCellText(row.getCell(2).value)),
      counselor: counselor.dharmaName,
      counselorPhone: parsePhone(row.getCell(4).value),
      meetingTime: rawCellText(row.getCell(5).value).replace(/\s+/g, " ").trim() || null,
      monitor: monitor?.dharmaName ?? null,
      monitorPhone: parsePhone(row.getCell(7).value),
      monitorStruckText: compact(monitorCell.struckText),
      students: [...roster.values()],
      remarks: rawCellText(row.getCell(22).value).trim()
    });
  }
  classes.sort((left, right) => left.number - right.number);
  validateConfirmedSource(classes);

  const learnerClasses = new Map<string, string[]>();
  for (const item of classes) {
    for (const student of item.students) {
      const placements = learnerClasses.get(student.dharmaName) ?? [];
      placements.push(item.previousName);
      learnerClasses.set(student.dharmaName, placements);
    }
  }
  const duplicates = [...learnerClasses].filter(([, placements]) => new Set(placements).size > 1);
  requireSource(duplicates.length === 0, `存在跨班重复学员：${duplicates.map(([name, placements]) => `${name}（${placements.join("、")}）`).join("；")}`);

  const operations = buildOperations();
  return {
    sourceLabel,
    sourceSha256,
    sourceSheet: sheet.name,
    sourceRange: `A1:V${sheet.rowCount}`,
    classes,
    operations,
    summary: {
      classesRenamed: CLASS_CHANGES.length,
      withdrawn: WITHDRAWALS.length,
      added: ADDITIONS.length,
      notesUpdated: NOTE_CHANGES.length,
      peopleRenamed: PERSON_RENAMES.length,
      monitorsChanged: MONITOR_CHANGES.length,
      attendanceAssistantsAssigned: ATTENDANCE_ASSISTANTS.length,
      accountsExpected: MONITOR_CHANGES.length + ATTENDANCE_ASSISTANTS.length
    }
  };
}

type ClassRow = { id: number; name: string; archived: number };
type EnrollmentRow = {
  id: number;
  personId: number;
  dharmaName: string | null;
  name: string;
  phone: string | null;
  note: string | null;
  status: string;
};

function resolveClasses(db: DatabaseSync): Map<string, ClassRow> {
  const classes = new Map<string, ClassRow>();
  for (const change of CLASS_CHANGES) {
    const rows = db.prepare(
      "select id, name, archived from classes where lower(trim(name)) = lower(trim(?))"
    ).all(change.previousName) as ClassRow[];
    if (rows.length === 0) throw new Error(`找不到待更新班级“${change.previousName}”`);
    if (rows.length !== 1) throw new Error(`存在 ${rows.length} 个同名班级“${change.previousName}”，无法安全确定更新对象`);
    const row = rows[0];
    if (row.archived) throw new Error(`班级“${change.previousName}”已归档，已停止更新`);
    const target = db.prepare(
      "select id, name from classes where lower(trim(name)) = lower(trim(?)) and id != ?"
    ).get(change.finalName, row.id) as { id: number; name: string } | undefined;
    if (target) throw new Error(`班名“${change.finalName}”已被其他班级使用，已停止更新`);
    classes.set(change.previousName, row);
  }
  for (const preserved of ["TD1", "TI1"] as const) {
    if (!db.prepare("select id from classes where lower(trim(name)) = lower(trim(?))").get(preserved)) {
      throw new Error(`需要保留的班级“${preserved}”不存在，已停止更新`);
    }
  }
  return classes;
}

function assertConfirmedPreview(
  preview: TeaRosterUpdatePreview,
  options: TeaRosterUpdateSafetyOptions = {}
): void {
  if (!options.allowUnconfirmedSource && preview.sourceSha256 !== CONFIRMED_TEA_ROSTER_UPDATE_SHA256) {
    throw new Error("名单增量更新只能使用已经确认 SHA-256 的来源文件");
  }
}

function assertActiveAdmin(db: DatabaseSync, actorUserId: number): void {
  const actor = db.prepare("select id from users where id = ? and is_admin = 1 and active = 1").get(actorUserId);
  if (!actor) throw new Error("名单增量更新必须由有效管理员执行");
}

export function preflightTeaRosterUpdate(
  db: DatabaseSync,
  preview: TeaRosterUpdatePreview,
  actorUserId: number,
  options: TeaRosterUpdateSafetyOptions = {}
): TeaRosterUpdatePreflight {
  assertConfirmedPreview(preview, options);
  assertActiveAdmin(db, actorUserId);
  const previous = db.prepare("select 1 from data_import_runs where source_sha256 = ?").get(preview.sourceSha256);
  if (previous) {
    return {
      ready: true,
      alreadyApplied: true,
      sourceSha256: preview.sourceSha256,
      classesChecked: 0,
      operationsChecked: 0
    };
  }
  const classes = resolveClasses(db);
  validateDatabaseState(db, classes);
  return {
    ready: true,
    alreadyApplied: false,
    sourceSha256: preview.sourceSha256,
    classesChecked: classes.size,
    operationsChecked: preview.operations.length
  };
}

function requireEnrollment(db: DatabaseSync, classId: number, dharmaName: string): EnrollmentRow {
  const rows = db.prepare(
    `select e.id, e.person_id as personId, p.dharma_name as dharmaName, p.name, p.phone, e.note,
            es.status
       from enrollments e
       join persons p on p.id = e.person_id
       join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
      where e.class_id = ? and p.dharma_name = ?`
  ).all(classId, dharmaName) as EnrollmentRow[];
  if (rows.length !== 1) throw new Error(`班级中无法唯一找到学员“${dharmaName}”`);
  return rows[0];
}

function assertNormalEnrollment(row: EnrollmentRow, className: string): void {
  if (row.status !== "normal") throw new Error(`${className} 的“${row.dharmaName}”当前不是正常状态，已停止更新`);
}

function currentMonitorName(db: DatabaseSync, classId: number): string | null {
  const row = db.prepare(
    `select p.dharma_name as dharmaName
       from class_monitors m
       join enrollments e on e.id = m.enrollment_id
       join persons p on p.id = e.person_id
      where m.class_id = ?`
  ).get(classId) as { dharmaName: string | null } | undefined;
  return row?.dharmaName ?? null;
}

function assertPhoneAvailable(db: DatabaseSync, phone: string, personId: number): void {
  const person = db.prepare("select id from persons where phone = ? and id != ?").get(phone, personId);
  if (person) throw new Error(`手机号 ${phone} 已被其他人员使用`);
  const contact = db.prepare("select id from users where contact_phone = ?").get(phone);
  if (contact) throw new Error(`手机号 ${phone} 已被其他账号用作联系电话`);
  const username = db.prepare(
    "select id from users where username = ? and (person_id is null or person_id != ?)"
  ).get(phone, personId);
  if (username) throw new Error(`手机号 ${phone} 已被其他账号用作登录账号`);
}

function assertNoUnexpectedPerson(db: DatabaseSync, dharmaName: string): void {
  const rows = db.prepare("select id from persons where dharma_name = ?").all(dharmaName);
  if (rows.length) throw new Error(`系统中已经存在法名“${dharmaName}”，无法安全新增，请先人工核对`);
}

function createRoleAccount(
  db: DatabaseSync,
  row: EnrollmentRow,
  phone: string,
  roleLabel: string,
  credentials: TeaRosterCredential[]
): number {
  const normalized = normalizePhone(phone);
  if (row.phone && row.phone !== normalized) {
    throw new Error(`“${row.dharmaName}”已有不同手机号 ${row.phone}，不能自动覆盖为 ${normalized}`);
  }
  assertPhoneAvailable(db, normalized, row.personId);
  const existing = db.prepare("select id, username from users where person_id = ?").get(row.personId) as
    | { id: number; username: string }
    | undefined;
  if (existing) {
    throw new Error(`“${row.dharmaName}”已经有登录账号 ${existing.username}，为避免重置现有密码已停止更新`);
  }
  db.prepare("update persons set phone = ?, updated_at = current_timestamp where id = ?").run(normalized, row.personId);
  const temporaryPassword = generateTemporaryPassword();
  const displayName = row.name.trim() || row.dharmaName || "未命名";
  const result = db.prepare(
    `insert into users
       (person_id, username, password_hash, display_name, active, must_change_password)
     values (?, ?, ?, ?, 1, 1)`
  ).run(row.personId, normalized, createPasswordHash(temporaryPassword), displayName);
  credentials.push({
    dharmaName: row.dharmaName || displayName,
    username: normalized,
    temporaryPassword,
    roles: [roleLabel]
  });
  return Number(result.lastInsertRowid);
}

function deactivateRolelessUser(db: DatabaseSync, userId: number): void {
  const user = db.prepare("select is_admin as isAdmin, can_counsel as canCounsel from users where id = ?").get(userId) as
    | { isAdmin: number; canCounsel: number }
    | undefined;
  if (!user || user.isAdmin || user.canCounsel) return;
  if (db.prepare(
    "select 1 from class_monitors m join classes c on c.id = m.class_id where m.user_id = ? and c.archived = 0 limit 1"
  ).get(userId)) return;
  if (db.prepare(
    "select 1 from class_attendance_assistants a join classes c on c.id = a.class_id where a.user_id = ? and c.archived = 0 limit 1"
  ).get(userId)) return;
  db.prepare("update users set active = 0, updated_at = current_timestamp where id = ?").run(userId);
  db.prepare("delete from sessions_auth where user_id = ?").run(userId);
}

function finalClassName(previousName: string): string {
  return CLASS_CHANGES.find((item) => item.previousName === previousName)?.finalName ?? previousName;
}

function validateDatabaseState(db: DatabaseSync, classes: Map<string, ClassRow>): void {
  for (const change of WITHDRAWALS) {
    const row = requireEnrollment(db, classes.get(change.className)!.id, change.dharmaName);
    assertNormalEnrollment(row, change.className);
  }
  for (const change of ADDITIONS) {
    assertNoUnexpectedPerson(db, change.dharmaName);
    const classId = classes.get(change.className)!.id;
    if (!db.prepare("select id from groups where class_id = ? and name = '未分组' and active = 1").get(classId)) {
      throw new Error(`${change.className} 没有可用的“未分组”，无法安全新增 ${change.dharmaName}`);
    }
  }
  for (const change of NOTE_CHANGES) {
    const row = requireEnrollment(db, classes.get(change.className)!.id, change.dharmaName);
    assertNormalEnrollment(row, change.className);
    if (row.note !== change.previousNote) {
      throw new Error(`${change.className} 的“${change.dharmaName}”备注已经变化，当前为“${row.note ?? "空"}”，已停止更新`);
    }
  }
  for (const change of PERSON_RENAMES) {
    const row = requireEnrollment(db, classes.get(change.className)!.id, change.previousDharmaName);
    assertNormalEnrollment(row, change.className);
    if (db.prepare("select id from persons where dharma_name = ? and id != ?").get(change.nextDharmaName, row.personId)) {
      throw new Error(`法名“${change.nextDharmaName}”已属于其他人员，已停止更新`);
    }
  }
  for (const change of MONITOR_CHANGES) {
    const classId = classes.get(change.className)!.id;
    const current = currentMonitorName(db, classId);
    if (current !== EXPECTED_PREVIOUS_MONITORS.get(change.className)) {
      throw new Error(`${change.className} 当前班长为“${current ?? "未设置"}”，与更新前预期不符`);
    }
    const row = requireEnrollment(db, classId, change.dharmaName);
    assertNormalEnrollment(row, change.className);
    if (db.prepare("select id from users where person_id = ?").get(row.personId)) {
      throw new Error(`“${change.dharmaName}”已经有登录账号，已停止自动创建班长账号`);
    }
    assertPhoneAvailable(db, change.phone, row.personId);
  }
  for (const change of ATTENDANCE_ASSISTANTS) {
    const classId = classes.get(change.className)!.id;
    const row = requireEnrollment(db, classId, change.dharmaName);
    assertNormalEnrollment(row, change.className);
    if (db.prepare("select id from users where person_id = ?").get(row.personId)) {
      throw new Error(`“${change.dharmaName}”已经有登录账号，已停止自动创建考勤员账号`);
    }
    assertPhoneAvailable(db, change.phone, row.personId);
  }
}

export async function applyTeaRosterUpdate(
  db: DatabaseSync,
  preview: TeaRosterUpdatePreview,
  actorUserId: number,
  options: {
    persistCredentials?: (credentials: TeaRosterCredential[]) => Promise<void>;
    allowUnconfirmedSource?: boolean;
  } = {}
): Promise<TeaRosterUpdateResult> {
  assertConfirmedPreview(preview, options);
  assertActiveAdmin(db, actorUserId);

  db.exec("begin immediate");
  try {
    const previous = db.prepare("select summary_json as summaryJson from data_import_runs where source_sha256 = ?")
      .get(preview.sourceSha256) as { summaryJson: string } | undefined;
    if (previous) {
      const saved = JSON.parse(previous.summaryJson) as Omit<TeaRosterUpdateResult, "alreadyApplied" | "credentials">;
      db.exec("commit");
      return { ...saved, alreadyApplied: true, credentials: [] };
    }

    const classes = resolveClasses(db);
    validateDatabaseState(db, classes);
    const credentials: TeaRosterCredential[] = [];

    for (const change of ADDITIONS) {
      const classId = classes.get(change.className)!.id;
      const group = db.prepare("select id from groups where class_id = ? and name = '未分组' and active = 1").get(classId) as { id: number };
      const effectiveSequence = getNextEffectiveSequence(db, classId);
      const personId = Number(db.prepare("insert into persons (name, dharma_name, phone) values ('', ?, null)").run(change.dharmaName).lastInsertRowid);
      const enrollmentId = Number(db.prepare(
        "insert into enrollments (class_id, person_id, note, active_from_sequence) values (?, ?, null, ?)"
      ).run(classId, personId, effectiveSequence).lastInsertRowid);
      db.prepare("insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, ?)")
        .run(enrollmentId, group.id, effectiveSequence);
    }

    for (const change of WITHDRAWALS) {
      const classId = classes.get(change.className)!.id;
      const row = requireEnrollment(db, classId, change.dharmaName);
      setEnrollmentStatusFromSequence(db, row.id, "withdrawn", getNextEffectiveSequence(db, classId));
    }

    for (const change of NOTE_CHANGES) {
      const row = requireEnrollment(db, classes.get(change.className)!.id, change.dharmaName);
      db.prepare("update enrollments set note = ?, updated_at = current_timestamp where id = ?")
        .run(change.nextNote, row.id);
    }

    for (const change of PERSON_RENAMES) {
      const row = requireEnrollment(db, classes.get(change.className)!.id, change.previousDharmaName);
      db.prepare("update persons set dharma_name = ?, updated_at = current_timestamp where id = ?")
        .run(change.nextDharmaName, row.personId);
      db.prepare("update users set display_name = ?, updated_at = current_timestamp where person_id = ?")
        .run(row.name.trim() || change.nextDharmaName, row.personId);
    }

    const roleUsers = new Map<string, number>();
    for (const change of [...MONITOR_CHANGES, ...ATTENDANCE_ASSISTANTS]) {
      const row = requireEnrollment(db, classes.get(change.className)!.id, change.dharmaName);
      const roleLabel = `${MONITOR_CHANGES.includes(change) ? "班长" : "考勤员"}：${finalClassName(change.className)}`;
      roleUsers.set(`${change.className}|${change.dharmaName}`, createRoleAccount(db, row, change.phone, roleLabel, credentials));
    }

    const oldMonitorUsers: number[] = [];
    for (const change of MONITOR_CHANGES) {
      const classId = classes.get(change.className)!.id;
      const row = requireEnrollment(db, classId, change.dharmaName);
      const old = db.prepare("select user_id as userId from class_monitors where class_id = ?").get(classId) as { userId: number } | undefined;
      if (old) oldMonitorUsers.push(old.userId);
      const userId = roleUsers.get(`${change.className}|${change.dharmaName}`)!;
      db.prepare("delete from class_monitors where class_id = ?").run(classId);
      db.prepare("insert into class_monitors (class_id, enrollment_id, user_id, assigned_by) values (?, ?, ?, ?)")
        .run(classId, row.id, userId, actorUserId);
    }

    for (const change of ATTENDANCE_ASSISTANTS) {
      const classId = classes.get(change.className)!.id;
      const row = requireEnrollment(db, classId, change.dharmaName);
      const userId = roleUsers.get(`${change.className}|${change.dharmaName}`)!;
      db.prepare(
        `insert into class_attendance_assistants (class_id, enrollment_id, user_id, assigned_by)
         values (?, ?, ?, ?)`
      ).run(classId, row.id, userId, actorUserId);
    }

    for (const userId of oldMonitorUsers) deactivateRolelessUser(db, userId);

    for (const change of CLASS_CHANGES) {
      db.prepare("update classes set name = ?, updated_at = current_timestamp where id = ?")
        .run(change.finalName, classes.get(change.previousName)!.id);
    }

    if (credentials.length !== MONITOR_CHANGES.length + ATTENDANCE_ASSISTANTS.length) {
      throw new Error(`本次应生成 6 个新账号，实际生成 ${credentials.length} 个，已停止更新`);
    }
    if (!options.persistCredentials) throw new Error("更新会创建新账号，但没有提供安全的临时密码保存位置");
    await options.persistCredentials(credentials);

    const saved: Omit<TeaRosterUpdateResult, "alreadyApplied" | "credentials"> = {
      sourceSha256: preview.sourceSha256,
      classesRenamed: CLASS_CHANGES.length,
      withdrawn: WITHDRAWALS.length,
      added: ADDITIONS.length,
      notesUpdated: NOTE_CHANGES.length,
      peopleRenamed: PERSON_RENAMES.length,
      monitorsChanged: MONITOR_CHANGES.length,
      attendanceAssistantsAssigned: ATTENDANCE_ASSISTANTS.length,
      accountsCreated: credentials.length
    };
    db.prepare(
      "insert into data_import_runs (source_label, source_sha256, summary_json, imported_by) values (?, ?, ?, ?)"
    ).run(preview.sourceLabel, preview.sourceSha256, JSON.stringify(saved), actorUserId);
    db.exec("commit");
    return { ...saved, alreadyApplied: false, credentials };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

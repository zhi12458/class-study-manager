import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import { normalizePhone } from "../../shared/phone.js";
import { createPasswordHash, generateTemporaryPassword } from "../auth.js";
import { suggestUniqueUsername } from "./accounts.js";

export type TeaRosterPersonSource = "counselor" | "monitor" | "student";

export interface TeaRosterPerson {
  dharmaName: string;
  phone: string | null;
  counselorClasses: string[];
  monitorClasses: string[];
}

export interface TeaRosterStudent {
  dharmaName: string;
  notes: string[];
}

export interface TeaRosterClass {
  className: string;
  classType: "同修" | "同德" | "同喜";
  meetingTime: string | null;
  counselor: string;
  monitor: string | null;
  students: TeaRosterStudent[];
  sourceProgress: string;
  courseSeriesKey: string | null;
  courseRound: number;
  courseStartPosition: number;
}

export interface TeaRosterSkip {
  className: string;
  rawName: string;
  reason: string;
}

export interface TeaRosterPreview {
  sourceLabel: string;
  sourceSha256: string;
  sourceSheet: string;
  sourceRange: string;
  classes: TeaRosterClass[];
  people: TeaRosterPerson[];
  skipped: TeaRosterSkip[];
  warnings: string[];
  summary: {
    classes: number;
    uniquePeople: number;
    learnerPlacements: number;
    accounts: number;
    counselorsWithoutPhone: number;
    monitorsWithoutPhone: number;
    skipped: number;
    warnings: number;
  };
}

export interface TeaRosterCredential {
  dharmaName: string;
  username: string;
  temporaryPassword: string;
  roles: string[];
}

export interface TeaRosterImportResult {
  alreadyImported: boolean;
  sourceSha256: string;
  classes: number;
  people: number;
  enrollments: number;
  accounts: number;
  counselors: number;
  monitors: number;
  credentials: TeaRosterCredential[];
}

type PersonOccurrence = {
  className: string;
  source: TeaRosterPersonSource;
  notes: string[];
};

type ParsedPerson = {
  dharmaName: string;
  phone: string | null;
  occurrences: PersonOccurrence[];
};

const CHOSEN_SLASH_NAMES: Record<string, string> = {
  "道汝/耀思": "道汝",
  "隆慧/清振": "清振",
  "善现/清峰": "善现"
};

const SKIPPED = new Map([
  ["正谛（试听中）", "试听中，暂不导入"],
  ["利娟（计划出海，建议转线上）", "计划出海，暂不导入"],
  ["TX8|照忏", "与 TX3 重复，保留 TX3"],
  ["TX11|道乐", "与 TX10 重复，保留 TX10"]
]);

const COURSE_PROGRESS: Record<string, { seriesKey: string; displayName: string; round: number }> = {
  "D第一遍": { seriesKey: "dharma_essentials", displayName: "佛法要领", round: 1 },
  "D1+2混": { seriesKey: "dharma_essentials", displayName: "佛法要领", round: 1 },
  "入论一遍": { seriesKey: "bodhisattva_way", displayName: "入菩萨行论", round: 1 },
  "入论二遍": { seriesKey: "bodhisattva_way", displayName: "入菩萨行论", round: 2 },
  "百法第一遍": { seriesKey: "hundred_dharmas", displayName: "百法明门论", round: 1 },
  "百法二遍": { seriesKey: "hundred_dharmas", displayName: "百法明门论", round: 2 },
  "戒品第一遍": { seriesKey: "bodhisattva_precepts", displayName: "瑜伽菩萨戒品", round: 1 },
  "辩修第二遍": { seriesKey: "meditation_treatise", displayName: "辩中边论·辩修对治品", round: 2 },
  "智慧人生": { seriesKey: "wisdom_life", displayName: "智慧人生", round: 1 }
};

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && "text" in value) return String((value as { text: unknown }).text).trim();
  return String(value).trim();
}

function compactText(value: unknown): string {
  return cellText(value).replace(/\s+/g, "");
}

function normalizePerson(value: unknown): { dharmaName: string; notes: string[]; rawName: string } {
  const rawName = compactText(value);
  const selected = CHOSEN_SLASH_NAMES[rawName] ?? rawName;
  const notes: string[] = [];
  let dharmaName = selected.replace(/[（(]([^）)]+)[）)]/g, (_match, content: string) => {
    notes.push(content === "外" ? "外地/线上学员" : `原表括注：${content}`);
    return "";
  });
  const honorific = dharmaName.match(/(法师|师父|师)$/)?.[1];
  if (honorific) {
    dharmaName = dharmaName.slice(0, -honorific.length);
    notes.push(`称谓：${honorific}`);
  }
  return { dharmaName: dharmaName.trim(), notes: [...new Set(notes)], rawName };
}

function normalizedPhone(value: unknown): string | null {
  const raw = cellText(value);
  return raw ? normalizePhone(raw) : null;
}

function normalizedProgress(value: unknown, className: string): {
  sourceProgress: string;
  courseSeriesKey: string | null;
  courseRound: number;
  courseStartPosition: number;
} {
  let raw = compactText(value);
  if (!raw && (className === "TX10" || className === "TX11")) raw = "智慧人生";
  if (raw.startsWith("入论一遍")) raw = "入论一遍";
  const mapped = COURSE_PROGRESS[raw];
  if (!mapped) {
    return {
      sourceProgress: raw ? `${raw}（具体课程和起始课待辅导员确认）` : "待辅导员选择课程和起始课",
      courseSeriesKey: null,
      courseRound: 1,
      courseStartPosition: 1
    };
  }
  return {
    sourceProgress: `${mapped.displayName}·第${mapped.round}遍（具体起始课待辅导员确认）`,
    courseSeriesKey: mapped.seriesKey,
    courseRound: mapped.round,
    courseStartPosition: 1
  };
}

function classType(className: string): TeaRosterClass["classType"] {
  if (className.startsWith("TX")) return "同修";
  if (className.startsWith("TD")) return "同德";
  return "同喜";
}

export async function parseTeaRosterWorkbook(input: Buffer, sourceLabel = "喝茶考勤表单.xlsx"): Promise<TeaRosterPreview> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("工作簿没有工作表");

  const people = new Map<string, ParsedPerson>();
  const classes: TeaRosterClass[] = [];
  const skipped: TeaRosterSkip[] = [];
  const warnings: string[] = [];

  function addPerson(className: string, rawName: unknown, rawPhone: unknown, source: TeaRosterPersonSource): ParsedPerson | null {
    const parsed = normalizePerson(rawName);
    if (!parsed.rawName) return null;
    const skipReason = SKIPPED.get(parsed.rawName) ?? SKIPPED.get(`${className}|${parsed.dharmaName}`);
    if (skipReason) {
      skipped.push({ className, rawName: parsed.rawName, reason: skipReason });
      return null;
    }
    if (!parsed.dharmaName) throw new Error(`${className} 中存在无法识别的法名：${parsed.rawName}`);
    const phone = normalizedPhone(rawPhone);
    const person = people.get(parsed.dharmaName) ?? { dharmaName: parsed.dharmaName, phone: null, occurrences: [] };
    if (phone && person.phone && person.phone !== phone) {
      warnings.push(`${parsed.dharmaName} 出现两个手机号：${person.phone} / ${phone}`);
    }
    person.phone ||= phone;
    person.occurrences.push({ className, source, notes: parsed.notes });
    people.set(parsed.dharmaName, person);
    return person;
  }

  for (let rowNumber = 4; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const className = compactText(row.getCell(2).value);
    if (!className) continue;
    const counselor = addPerson(
      className,
      className === "TD1" ? "善含" : row.getCell(4).value,
      className === "TD1" ? null : row.getCell(5).value,
      "counselor"
    );
    if (!counselor) throw new Error(`${className} 缺少有效辅导员`);

    const monitor = className === "TD1" ? null : addPerson(className, row.getCell(7).value, row.getCell(8).value, "monitor");
    const roster = new Map<string, TeaRosterStudent>();
    if (monitor) {
      const occurrence = monitor.occurrences.at(-1)!;
      roster.set(monitor.dharmaName, { dharmaName: monitor.dharmaName, notes: occurrence.notes });
    }
    for (let column = 9; column <= 22; column += 1) {
      const student = addPerson(className, row.getCell(column).value, null, "student");
      if (!student) continue;
      const occurrence = student.occurrences.at(-1)!;
      const existing = roster.get(student.dharmaName);
      roster.set(student.dharmaName, {
        dharmaName: student.dharmaName,
        notes: [...new Set([...(existing?.notes ?? []), ...occurrence.notes])]
      });
    }
    const progress = normalizedProgress(row.getCell(3).value, className);
    classes.push({
      className,
      classType: classType(className),
      meetingTime: cellText(row.getCell(6).value).replace(/\s+/g, " ") || null,
      counselor: counselor.dharmaName,
      monitor: monitor?.dharmaName ?? null,
      students: [...roster.values()],
      ...progress
    });
  }

  const learnerClasses = new Map<string, Set<string>>();
  for (const item of classes) {
    for (const student of item.students) {
      const classNames = learnerClasses.get(student.dharmaName) ?? new Set<string>();
      classNames.add(item.className);
      learnerClasses.set(student.dharmaName, classNames);
    }
  }
  const conflicts = [...learnerClasses].filter(([, classNames]) => classNames.size > 1);
  if (conflicts.length) {
    throw new Error(`存在跨班重复学员：${conflicts.map(([name, names]) => `${name}（${[...names].join("、")}）`).join("；")}`);
  }
  if (warnings.length) throw new Error(warnings.join("；"));

  const peopleList: TeaRosterPerson[] = [...people.values()].map((person) => ({
    dharmaName: person.dharmaName,
    phone: person.phone,
    counselorClasses: [...new Set(person.occurrences.filter((item) => item.source === "counselor").map((item) => item.className))],
    monitorClasses: [...new Set(person.occurrences.filter((item) => item.source === "monitor").map((item) => item.className))]
  }));
  const accounts = peopleList.filter((person) => person.counselorClasses.length || person.monitorClasses.length);
  return {
    sourceLabel,
    sourceSha256: createHash("sha256").update(input).digest("hex"),
    sourceSheet: sheet.name,
    sourceRange: `A1:V${sheet.rowCount}`,
    classes,
    people: peopleList,
    skipped,
    warnings,
    summary: {
      classes: classes.length,
      uniquePeople: peopleList.length,
      learnerPlacements: classes.reduce((sum, item) => sum + item.students.length, 0),
      accounts: accounts.length,
      counselorsWithoutPhone: accounts.filter((person) => person.counselorClasses.length > 0 && !person.phone).length,
      monitorsWithoutPhone: accounts.filter((person) => person.monitorClasses.length > 0 && !person.phone).length,
      skipped: skipped.length,
      warnings: warnings.length
    }
  };
}

function findOrCreatePerson(db: DatabaseSync, person: TeaRosterPerson): number {
  let existing = person.phone
    ? db.prepare("select id, dharma_name as dharmaName, phone from persons where phone = ?").get(person.phone)
    : undefined;
  existing ??= db.prepare(
    "select id, dharma_name as dharmaName, phone from persons where trim(name) = '' and dharma_name = ? order by id limit 1"
  ).get(person.dharmaName);
  if (existing) {
    const row = existing as { id: number; dharmaName: string | null; phone: string | null };
    if (row.dharmaName && row.dharmaName !== person.dharmaName) {
      throw new Error(`手机号 ${person.phone} 已属于法名“${row.dharmaName}”，不能导入“${person.dharmaName}”`);
    }
    if (person.phone && row.phone && row.phone !== person.phone) {
      throw new Error(`法名“${person.dharmaName}”已有不同手机号 ${row.phone}，不能覆盖为 ${person.phone}`);
    }
    if (person.phone && !row.phone) {
      const conflict = db.prepare("select id from persons where phone = ? and id != ?").get(person.phone, row.id);
      if (conflict) throw new Error(`手机号 ${person.phone} 已被其他人员使用`);
    }
    db.prepare("update persons set dharma_name = ?, phone = coalesce(phone, ?), updated_at = current_timestamp where id = ?")
      .run(person.dharmaName, person.phone, row.id);
    return row.id;
  }
  return Number(db.prepare("insert into persons (name, dharma_name, phone) values ('', ?, ?)").run(
    person.dharmaName, person.phone
  ).lastInsertRowid);
}

function ensureAccount(
  db: DatabaseSync,
  person: TeaRosterPerson,
  personId: number,
  credentials: TeaRosterCredential[]
): number | null {
  const needsAccount = person.counselorClasses.length > 0 || person.monitorClasses.length > 0;
  if (!needsAccount) return null;
  const existing = db.prepare("select id, username from users where person_id = ?").get(personId) as
    | { id: number; username: string }
    | undefined;
  if (existing) {
    db.prepare(
      `update users set display_name = ?, counselor_role = case when ? then 1 else counselor_role end,
              can_counsel = case when ? then 1 else can_counsel end, active = 1, updated_at = current_timestamp
        where id = ?`
    ).run(person.dharmaName, person.counselorClasses.length > 0 ? 1 : 0, person.counselorClasses.length > 0 ? 1 : 0, existing.id);
    return existing.id;
  }
  const username = person.phone ?? suggestUniqueUsername(db, person.dharmaName);
  const temporaryPassword = generateTemporaryPassword();
  const result = db.prepare(
    `insert into users
       (person_id, username, password_hash, display_name, counselor_role, can_counsel, active, must_change_password)
     values (?, ?, ?, ?, ?, ?, 1, 1)`
  ).run(
    personId,
    username,
    createPasswordHash(temporaryPassword),
    person.dharmaName,
    person.counselorClasses.length > 0 ? 1 : 0,
    person.counselorClasses.length > 0 ? 1 : 0
  );
  credentials.push({
    dharmaName: person.dharmaName,
    username,
    temporaryPassword,
    roles: [
      ...(person.counselorClasses.length ? [`辅导员：${person.counselorClasses.join("、")}`] : []),
      ...(person.monitorClasses.length ? [`班长：${person.monitorClasses.join("、")}`] : [])
    ]
  });
  return Number(result.lastInsertRowid);
}

export async function importTeaRoster(
  db: DatabaseSync,
  preview: TeaRosterPreview,
  actorUserId: number,
  options: { persistCredentials?: (credentials: TeaRosterCredential[]) => Promise<void> } = {}
): Promise<TeaRosterImportResult> {
  const previous = db.prepare("select summary_json as summaryJson from data_import_runs where source_sha256 = ?")
    .get(preview.sourceSha256) as { summaryJson: string } | undefined;
  if (previous) {
    const saved = JSON.parse(previous.summaryJson) as Omit<TeaRosterImportResult, "alreadyImported" | "credentials">;
    return { ...saved, alreadyImported: true, credentials: [] };
  }
  const actor = db.prepare("select id from users where id = ? and is_admin = 1").get(actorUserId);
  if (!actor) throw new Error("正式名单导入必须由管理员执行");
  for (const item of preview.classes) {
    if (db.prepare("select id from classes where lower(trim(name)) = lower(trim(?))").get(item.className)) {
      throw new Error(`班级“${item.className}”已经存在，已停止导入以避免重复`);
    }
  }

  const personIds = new Map<string, number>();
  const userIds = new Map<string, number>();
  const credentials: TeaRosterCredential[] = [];
  let enrollmentCount = 0;
  let monitorCount = 0;

  db.exec("begin immediate");
  try {
    for (const person of preview.people) {
      const personId = findOrCreatePerson(db, person);
      personIds.set(person.dharmaName, personId);
      const userId = ensureAccount(db, person, personId, credentials);
      if (userId) userIds.set(person.dharmaName, userId);
    }

    for (const item of preview.classes) {
      const counselorUserId = userIds.get(item.counselor);
      if (!counselorUserId) throw new Error(`${item.className} 的辅导员“${item.counselor}”缺少账号`);
      const classId = Number(db.prepare(
        `insert into classes
           (name, counselor_user_id, cadence_mode, created_by, course_series_key, course_round,
            course_start_position, meeting_time, source_progress)
         values (?, ?, 'same_week', ?, ?, ?, ?, ?, ?)`
      ).run(
        item.className, counselorUserId, actorUserId, item.courseSeriesKey, item.courseRound,
        item.courseStartPosition, item.meetingTime, item.sourceProgress
      ).lastInsertRowid);
      db.prepare(
        "insert into class_counselor_history (class_id, counselor_user_id, assigned_by) values (?, ?, ?)"
      ).run(classId, counselorUserId, actorUserId);
      const groupId = Number(db.prepare(
        "insert into groups (class_id, name, sort_order) values (?, '未分组', 1)"
      ).run(classId).lastInsertRowid);
      const enrollmentIds = new Map<string, number>();
      for (const student of item.students) {
        const personId = personIds.get(student.dharmaName);
        if (!personId) throw new Error(`${item.className} 的学员“${student.dharmaName}”缺少人员资料`);
        const enrollmentId = Number(db.prepare(
          "insert into enrollments (class_id, person_id, note, active_from_sequence) values (?, ?, ?, 1)"
        ).run(classId, personId, student.notes.join("；") || null).lastInsertRowid);
        db.prepare(
          "insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, 1)"
        ).run(enrollmentId, groupId);
        enrollmentIds.set(student.dharmaName, enrollmentId);
        enrollmentCount += 1;
      }
      if (item.monitor) {
        const monitorEnrollmentId = enrollmentIds.get(item.monitor);
        const monitorUserId = userIds.get(item.monitor);
        if (!monitorEnrollmentId || !monitorUserId) throw new Error(`${item.className} 的班长“${item.monitor}”资料不完整`);
        db.prepare(
          "insert into class_monitors (class_id, enrollment_id, user_id, assigned_by) values (?, ?, ?, ?)"
        ).run(classId, monitorEnrollmentId, monitorUserId, actorUserId);
        monitorCount += 1;
      }
    }

    const result: Omit<TeaRosterImportResult, "alreadyImported" | "credentials"> = {
      sourceSha256: preview.sourceSha256,
      classes: preview.classes.length,
      people: personIds.size,
      enrollments: enrollmentCount,
      accounts: userIds.size,
      counselors: preview.people.filter((person) => person.counselorClasses.length > 0).length,
      monitors: monitorCount
    };
    if (credentials.length) {
      if (!options.persistCredentials) throw new Error("导入会创建新账号，但没有提供安全的临时密码保存位置");
      await options.persistCredentials(credentials);
    }
    db.prepare(
      "insert into data_import_runs (source_label, source_sha256, summary_json, imported_by) values (?, ?, ?, ?)"
    ).run(preview.sourceLabel, preview.sourceSha256, JSON.stringify(result), actorUserId);
    db.exec("commit");
    return { ...result, alreadyImported: false, credentials };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

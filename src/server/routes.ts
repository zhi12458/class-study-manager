import cookieParser from "cookie-parser";
import ExcelJS from "exceljs";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  ATTENDANCE_SCHEMA_VERSION, CADENCE_MODES, CLASS_STUDY_STATUSES, GROUP_STUDY_STATUSES, LESSON_TYPES,
  OUTLINE_STATUSES, REPORT_RANGES, ENROLLMENT_STATUSES, type AttendanceStatus, type CadenceMode,
  type EnrollmentRole, type EnrollmentStatus, type Metric, type ReportRange
} from "../shared/types.js";
import { normalizePhone } from "../shared/phone.js";
import {
  type AuthedRequest, requireAdmin, requireAuth, requireClassAccess,
  requireClassAttendanceAccess, requireClassReportAccess, requireClassScheduleAccess
} from "./access.js";
import {
  createPasswordHash, createSession, deleteSession, generateTemporaryPassword,
  listClassAccesses, loadSessionUser, verifyPassword
} from "./auth.js";
import {
  addScheduleBreak, appendLessons, createClass, deleteLesson, deleteScheduleBreak, insertLesson, lessonHasRecordedAttendance,
  lessonScheduleLocked, patchLesson,
  rebuildFutureSchedule, setInitialSchedule, updateFutureCadence, updateScheduleBreak
} from "./services/classes.js";
import { classifyRosterRows, parseRosterWorkbook, type ImportRow } from "./services/importRoster.js";
import { buildClassReport, type CustomReportRange } from "./services/reportBuilder.js";
import {
  assertPersonAvailableForEnrollment, freezeLessonRoster, getNextEffectiveSequence,
  freezeStartedLessons, lessonStartDate, listLessonRosterPreview, setEnrollmentGroupFromSequence, setEnrollmentStatusFromSequence, shanghaiToday
} from "./services/roster.js";
import { isMonitorLocked } from "./services/schedule.js";
import { listCourseCatalog, syncOfficialCourseCatalog } from "./services/courseCatalog.js";
import {
  assertPersonName, assertUsernameAvailable, normalizeCustomUsername,
  personDisplayName, suggestUniqueUsername
} from "./services/accounts.js";
import { LoginAttemptLimiter } from "./security.js";
import { badRequest, classifyHttpError } from "./httpErrors.js";
import {
  identifierFingerprint, logError, safelyRecordAuditEvent
} from "./observability.js";

const COOKIE = "class_study_session";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const EDITABLE_ENROLLMENT_ROLES = ["group_leader", "charity", "dharma_light", "communications"] as const;
const DUMMY_PASSWORD_HASH = createPasswordHash("timing-only-password-not-used");

function numberParam(value: unknown, label = "ID"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label}无效`);
  return parsed;
}

function validDate(value: unknown): string {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日期必须使用 YYYY-MM-DD 格式");
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error("日期无效");
  }
  return date;
}

function reportSelection(req: Request): { range: ReportRange; customRange?: CustomReportRange } {
  const range = String(req.query.range ?? "recent") as ReportRange;
  if (!REPORT_RANGES.includes(range)) throw badRequest("时间范围无效");
  if (range !== "custom") return { range };
  if (!req.query.from || !req.query.to) throw badRequest("自定义统计请选择开始和结束日期");
  const from = validDate(req.query.from);
  const to = validDate(req.query.to);
  if (from > to) throw badRequest("开始日期不能晚于结束日期");
  if (to > shanghaiToday()) throw badRequest("结束日期不能晚于今天");
  return { range, customRange: { from, to } };
}

function reportFilename(report: ReturnType<typeof buildClassReport>, extension: "csv" | "xlsx"): string {
  const from = report.filters.from.replaceAll("-", "");
  const to = report.filters.to.replaceAll("-", "");
  return `class-study-report-${from}-${to}.${extension}`;
}

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function sendCsv(res: Response, filename: string, rows: Array<Record<string, unknown>>): void {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const escape = (value: unknown) => {
    const raw = String(value ?? "");
    const safe = /^[\t\r ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const body = [headers.map(escape).join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))]
    .filter(Boolean).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(`\uFEFF${body}`);
}

const METRIC_NAMES: Record<string, string> = { outline: "导图/提纲", group_study: "组修", class_study: "班修" };
const STATUS_NAMES: Record<string, string> = {
  yes: "是", no: "否", not_required: "不需要", onsite: "现场", online: "网络",
  official_duty: "公差", absent: "旷课", observer: "旁听"
};

function buildCsvExportRows(report: ReturnType<typeof buildClassReport>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const base = (recordType: string) => ({
    "记录类型": recordType, "班级": report.class.name, "时间范围": report.rangeLabel,
    "小组": "", "姓名": "", "课次": "", "课名": "", "指标": "", "应完成日期": "",
    "状态": "", "完成数": "", "已登记适用": "", "待登记": "", "完成率": "", "说明": ""
  });
  for (const [metric, summary] of Object.entries(report.classSummary)) {
    rows.push({ ...base("班级汇总"), "指标": METRIC_NAMES[metric], "完成数": summary.completed,
      "已登记适用": summary.applicable, "待登记": summary.pending,
      "完成率": summary.rate == null ? "不适用" : `${summary.rate}%` });
  }
  for (const group of report.groupSummaries) {
    for (const [metric, summary] of Object.entries(group.metrics)) {
      rows.push({ ...base("小组汇总"), "小组": group.groupName, "指标": METRIC_NAMES[metric],
        "完成数": summary.completed, "已登记适用": summary.applicable, "待登记": summary.pending,
        "完成率": summary.rate == null ? "不适用" : `${summary.rate}%` });
    }
  }
  for (const person of report.personalStats) {
    for (const [metric, summary] of Object.entries(person.metrics)) {
      rows.push({ ...base("个人汇总"), "小组": person.groupName, "姓名": person.name,
        "指标": METRIC_NAMES[metric], "完成数": summary.completed, "已登记适用": summary.applicable,
        "待登记": summary.pending, "完成率": summary.rate == null ? "不适用" : `${summary.rate}%` });
    }
  }
  for (const detail of report.details) {
    rows.push({ ...base("逐课明细"), "小组": detail.groupName, "姓名": detail.studentName,
      "课次": detail.lessonSequence, "课名": detail.lessonTitle, "指标": METRIC_NAMES[String(detail.metric)],
      "应完成日期": detail.dueDate, "状态": detail.status == null ? "待登记" : STATUS_NAMES[String(detail.status)] });
  }
  for (const person of report.attention) {
    rows.push({ ...base("需关注"), "小组": person.groupName, "姓名": person.name, "说明": person.reasons.join("；") });
  }
  return rows;
}

function loadUser(db: DatabaseSync) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    req.user = loadSessionUser(db, req.cookies?.[COOKIE]) ?? undefined;
    next();
  };
}

function assertCurrentPassword(db: DatabaseSync, userId: number, password: unknown): void {
  const row = db.prepare("select password_hash as passwordHash from users where id = ?").get(userId) as
    | { passwordHash: string }
    | undefined;
  if (!row || !verifyPassword(String(password ?? ""), row.passwordHash)) {
    throw new Error("当前密码不正确");
  }
}

function assertPhoneAvailable(
  db: DatabaseSync,
  phone: string,
  options: { personId?: number | null; userId?: number | null } = {}
): void {
  const person = db.prepare("select id from persons where phone = ?").get(phone) as { id: number } | undefined;
  if (person && person.id !== options.personId) throw new Error("该手机号已被其他人员使用");
  const contact = db.prepare("select id from users where contact_phone = ?").get(phone) as { id: number } | undefined;
  if (contact && contact.id !== options.userId) throw new Error("该手机号已被其他账号使用");
  const account = db.prepare("select id from users where username = ?").get(phone) as { id: number } | undefined;
  if (account && account.id !== options.userId) throw new Error("该手机号已被其他登录账号使用");
}

function loadAccountProfile(db: DatabaseSync, userId: number) {
  return db.prepare(
    `select u.id, u.username, u.display_name as displayName, u.is_admin as isAdmin,
            u.person_id as personId, p.name, p.dharma_name as dharmaName,
            coalesce(p.phone, u.contact_phone) as phone
       from users u left join persons p on p.id = u.person_id
      where u.id = ?`
  ).get(userId) as Record<string, unknown> | undefined;
}

function accountUsername(
  db: DatabaseSync,
  input: { phone?: string | null; requested?: unknown; displayName: string; userId?: number | null }
): string {
  const requested = String(input.requested ?? "").trim();
  const username = requested ? normalizeCustomUsername(requested) : input.phone || suggestUniqueUsername(db, input.displayName);
  assertUsernameAvailable(db, username, input.userId);
  return username;
}

type ClassOperatorStudent = {
  id: number;
  personId: number;
  name: string;
  dharmaName: string | null;
  phone: string | null;
};

function ensureClassOperatorAccount(
  db: DatabaseSync,
  student: ClassOperatorStudent,
  requestedUsername: unknown
): { userId: number; username: string; temporaryPassword?: string } {
  const existing = db.prepare("select id, username from users where person_id = ?").get(student.personId) as
    | { id: number; username: string }
    | undefined;
  const displayName = personDisplayName(student.name, student.dharmaName);
  if (existing) {
    db.prepare("update users set active = 1, display_name = ?, updated_at = current_timestamp where id = ?")
      .run(displayName, existing.id);
    return { userId: existing.id, username: existing.username };
  }
  const temporaryPassword = generateTemporaryPassword();
  const username = accountUsername(db, {
    phone: student.phone,
    requested: requestedUsername,
    displayName
  });
  const result = db.prepare(
    "insert into users (person_id, username, password_hash, display_name, must_change_password) values (?, ?, ?, ?, 1)"
  ).run(student.personId, username, createPasswordHash(temporaryPassword), displayName);
  return { userId: Number(result.lastInsertRowid), username, temporaryPassword };
}

function listClasses(db: DatabaseSync, userId: number, isAdmin: boolean, canCounsel: boolean) {
  const where = isAdmin ? "1 = 1" : `(? = 1 and c.counselor_user_id = ?)
    or (c.archived = 0 and exists (select 1 from class_monitors mx where mx.class_id = c.id and mx.user_id = ?))
    or (c.archived = 0 and exists (select 1 from class_attendance_assistants ax where ax.class_id = c.id and ax.user_id = ?))`;
  const params: SQLInputValue[] = isAdmin ? [] : [canCounsel ? 1 : 0, userId, userId, userId];
  return db.prepare(
    `select c.id, c.name, c.cadence_mode as cadenceMode, c.archived,
            c.meeting_time as meetingTime, c.source_progress as sourceProgress,
            c.course_series_key as courseSeriesKey, c.course_round as courseRound,
            c.course_start_position as courseStartPosition,
            c.counselor_user_id as counselorId, cu.display_name as counselorName,
            m.enrollment_id as monitorId, coalesce(nullif(trim(mp.name), ''), mp.dharma_name) as monitorName,
            (select count(*) from groups g where g.class_id = c.id and g.active = 1) as groupCount,
            (select count(*) from enrollments e join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null where e.class_id = c.id and es.status != 'withdrawn') as studentCount,
            case when not exists (select 1 from enrollments e where e.class_id = c.id)
                       and not exists (select 1 from lessons l where l.class_id = c.id)
                       and not exists (select 1 from schedule_breaks b where b.class_id = c.id)
                 then 1 else 0 end as deletable,
            case when ? = 1 then 'admin'
                 when ? = 1 and c.counselor_user_id = ? then 'counselor'
                 when exists (select 1 from class_monitors mx where mx.class_id = c.id and mx.user_id = ?) then 'monitor'
                 when exists (select 1 from class_attendance_assistants ax where ax.class_id = c.id and ax.user_id = ?) then 'attendance_assistant'
                 else 'admin' end as permission
       from classes c
       join users cu on cu.id = c.counselor_user_id
       left join class_monitors m on m.class_id = c.id
       left join enrollments me on me.id = m.enrollment_id
       left join persons mp on mp.id = me.person_id
      where ${where}
      order by c.archived,
               case when trim(c.name) glob '[0-9]*' and trim(c.name) not glob '*[^0-9]*' then 0 else 1 end,
               case when trim(c.name) glob '[0-9]*' and trim(c.name) not glob '*[^0-9]*' then cast(trim(c.name) as integer) end,
               c.id desc`
  ).all(isAdmin ? 1 : 0, canCounsel ? 1 : 0, userId, userId, userId, ...params);
}

function deactivateRolelessUser(db: DatabaseSync, userId: number): void {
  const user = db.prepare("select is_admin as isAdmin, can_counsel as canCounsel from users where id = ?").get(userId) as
    | { isAdmin: number; canCounsel: number }
    | undefined;
  if (!user || user.isAdmin || user.canCounsel) return;
  const hasMonitorAccess = db.prepare(
    "select 1 from class_monitors m join classes c on c.id = m.class_id where m.user_id = ? and c.archived = 0 limit 1"
  ).get(userId);
  const hasAttendanceAccess = db.prepare(
    "select 1 from class_attendance_assistants a join classes c on c.id = a.class_id where a.user_id = ? and c.archived = 0 limit 1"
  ).get(userId);
  if (hasMonitorAccess || hasAttendanceAccess) return;
  db.prepare("update users set active = 0, updated_at = current_timestamp where id = ?").run(userId);
  db.prepare("delete from sessions_auth where user_id = ?").run(userId);
}

function getLesson(db: DatabaseSync, classId: number, lessonId: number) {
  return db.prepare(
    `select id, class_id as classId, sequence, sequence as lessonNumber, title,
            lesson_type as lessonType, cadence_mode as cadenceMode,
            outline_due_date as outlineDueDate, group_study_due_date as groupStudyDueDate,
            class_study_due_date as classStudyDueDate, roster_frozen_at as frozenAt
       from lessons where id = ? and class_id = ?`
  ).get(lessonId, classId) as Record<string, unknown> | undefined;
}

function createOrUpdatePerson(db: DatabaseSync, input: {
  name: string;
  dharmaName?: string | null;
  phone?: string | null;
  personId?: number;
  preservePhoneWhenBlank?: boolean;
}) {
  const identity = assertPersonName(input.name, input.dharmaName);
  const rawPhone = String(input.phone ?? "").trim();
  let phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (input.personId) {
    const current = db.prepare(
      "select p.id, p.phone, (select id from users where person_id = p.id) as userId from persons p where p.id = ?"
    ).get(input.personId) as
      | { id: number; phone: string | null; userId: number | null }
      | undefined;
    if (!current) throw new Error("学员资料不存在");
    if (!phone && input.preservePhoneWhenBlank) phone = current.phone;
    if (phone) assertPhoneAvailable(db, phone, { personId: current.id, userId: current.userId });
    db.prepare("update persons set name = ?, dharma_name = ?, phone = ?, updated_at = current_timestamp where id = ?")
      .run(identity.name, identity.dharmaName, phone, current.id);
    db.prepare("update users set display_name = ?, updated_at = current_timestamp where person_id = ?")
      .run(identity.displayName, current.id);
    return { personId: current.id, phone, existing: true };
  }
  const existing = phone
    ? db.prepare("select id from persons where phone = ?").get(phone) as { id: number } | undefined
    : undefined;
  const adminContact = phone ? db.prepare("select id from users where contact_phone = ?").get(phone) : undefined;
  if (adminContact) throw new Error("该手机号已被其他账号使用");
  if (existing) {
    if (input.dharmaName === undefined) {
      db.prepare("update persons set name = ?, updated_at = current_timestamp where id = ?")
        .run(identity.name, existing.id);
    } else {
      db.prepare("update persons set name = ?, dharma_name = ?, updated_at = current_timestamp where id = ?")
        .run(identity.name, identity.dharmaName, existing.id);
    }
    db.prepare("update users set display_name = ?, updated_at = current_timestamp where person_id = ?")
      .run(identity.displayName, existing.id);
    return { personId: existing.id, phone, existing: true };
  }
  const result = db.prepare("insert into persons (name, dharma_name, phone) values (?, ?, ?)")
    .run(identity.name, identity.dharmaName, phone);
  return { personId: Number(result.lastInsertRowid), phone, existing: false };
}

function insertEnrollment(db: DatabaseSync, input: {
  classId: number; personId: number; groupId: number; note?: string | null; effectiveSequence: number;
  status?: EnrollmentStatus; roles?: EnrollmentRole[];
}): number {
  assertPersonAvailableForEnrollment(db, input.personId, input.classId);
  const same = db.prepare("select id from enrollments where class_id = ? and person_id = ?").get(input.classId, input.personId);
  if (same) throw new Error("该学员已在本班名单中");
  const result = db.prepare(
    `insert into enrollments (class_id, person_id, note, active_from_sequence) values (?, ?, ?, ?)`
  ).run(input.classId, input.personId, input.note?.trim() || null, input.effectiveSequence);
  const enrollmentId = Number(result.lastInsertRowid);
  db.prepare("insert into group_assignments (enrollment_id, group_id, effective_from_sequence) values (?, ?, ?)")
    .run(enrollmentId, input.groupId, input.effectiveSequence);
  if (input.status && input.status !== "normal") {
    setEnrollmentStatusFromSequence(db, enrollmentId, input.status, input.effectiveSequence);
  }
  updateEnrollmentRoles(db, enrollmentId, input.classId, input.groupId, input.roles ?? []);
  return enrollmentId;
}

function parseEnrollmentStatus(value: unknown, fallback: EnrollmentStatus = "normal"): EnrollmentStatus {
  const status = value == null || value === "" ? fallback : String(value) as EnrollmentStatus;
  if (!ENROLLMENT_STATUSES.includes(status)) throw new Error("学员状态无效");
  return status;
}

function parseEnrollmentRoles(value: unknown): EnrollmentRole[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("学员身份必须是列表");
  const roles = [...new Set(value.map(String))];
  if (roles.some((role) => !(EDITABLE_ENROLLMENT_ROLES as readonly string[]).includes(role))) {
    throw new Error("学员身份无效");
  }
  return roles as EnrollmentRole[];
}

function updateEnrollmentRoles(
  db: DatabaseSync,
  enrollmentId: number,
  classId: number,
  groupId: number,
  roles: EnrollmentRole[]
): void {
  if (roles.includes("group_leader")) {
    const occupied = db.prepare(
      `select coalesce(nullif(trim(p.name), ''), p.dharma_name) as name
         from enrollment_roles er
         join enrollments e on e.id = er.enrollment_id
         join persons p on p.id = e.person_id
         join group_assignments ga on ga.enrollment_id = e.id and ga.effective_to_sequence is null
         join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
        where e.class_id = ? and ga.group_id = ? and er.role = 'group_leader'
          and es.status != 'withdrawn' and e.id != ? limit 1`
    ).get(classId, groupId, enrollmentId) as { name: string } | undefined;
    if (occupied) throw new Error(`该小组已有组长“${occupied.name}”`);
  }
  db.prepare("delete from enrollment_roles where enrollment_id = ?").run(enrollmentId);
  const insert = db.prepare("insert into enrollment_roles (enrollment_id, role) values (?, ?)");
  roles.forEach((role) => insert.run(enrollmentId, role));
}

export function createApiRouter(db: DatabaseSync) {
  const router = express.Router();
  const loginLimiter = new LoginAttemptLimiter();
  const clientErrorLimiter = new LoginAttemptLimiter(20, 60_000, 5_000);
  router.use(cookieParser());
  router.use(express.json({ limit: "4mb" }));
  router.use(loadUser(db));

  router.get("/health", (_req, res) => res.json({ ok: true, service: "class-study-manager" }));

  router.post("/client-errors", (req: AuthedRequest, res) => {
    const limiterKey = req.clientIp ?? "unknown";
    const retryAfter = clientErrorLimiter.retryAfterSeconds(limiterKey);
    if (retryAfter > 0) {
      res.setHeader("Retry-After", String(retryAfter));
      return void res.status(429).json({ error: "错误上报过于频繁，请稍后再试" });
    }
    clientErrorLimiter.recordFailure(limiterKey);
    const sanitize = (value: unknown, maxLength: number) => String(value ?? "")
      .slice(0, maxLength)
      .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g, "[已隐藏手机号]")
      .replace(/([?&](?:token|password|phone)=)[^&#\s]+/gi, "$1[已隐藏]");
    const message = sanitize(req.body.message, 500);
    const stack = sanitize(req.body.stack, 4_000);
    const componentStack = sanitize(req.body.componentStack, 4_000);
    const source = sanitize(req.body.source, 40) || "unknown";
    const page = sanitize(req.body.page, 300).split("?", 1)[0];
    const assetVersion = sanitize(req.body.assetVersion, 300).split("?", 1)[0];
    if (!message && !stack && !componentStack) return void res.status(400).json({ error: "错误信息为空" });
    const details = { source, page, assetVersion, message, stack, componentStack };
    safelyRecordAuditEvent(db, {
      eventType: "client_error",
      requestId: req.requestId,
      userId: req.user?.id,
      outcome: "failure",
      httpStatus: 202,
      method: req.method,
      path: "/api/client-errors",
      clientIp: req.clientIp,
      details,
    });
    logError("client_error", new Error(message || "Browser client error"), {
      requestId: req.requestId,
      userId: req.user?.id ?? null,
      clientIp: req.clientIp,
      source,
      page,
      assetVersion,
      browserStack: stack || componentStack || undefined,
    });
    res.status(202).json({ ok: true, requestId: req.requestId });
  });

  router.get("/course-catalog", requireAuth, (_req, res) => {
    res.json({ series: listCourseCatalog(db) });
  });

  router.post("/admin/course-catalog/sync", requireAdmin, async (_req, res) => {
    const series = await syncOfficialCourseCatalog(db);
    res.json({ seriesCount: series.length, itemCount: series.reduce((sum, item) => sum + item.items.length, 0) });
  });

  router.post("/auth/login", (req: AuthedRequest, res) => {
    const identifier = String(req.body.identifier ?? req.body.username ?? req.body.phone ?? "").trim();
    const password = String(req.body.password ?? "");
    if (!identifier || !password) {
      safelyRecordAuditEvent(db, {
        eventType: "login_invalid", requestId: req.requestId, outcome: "denied", httpStatus: 400,
        method: req.method, path: "/api/auth/login", clientIp: req.clientIp, details: { reason: "missing_credentials" },
      });
      return void res.status(400).json({ error: "请输入账号和密码" });
    }
    if (identifier.length > 64 || password.length > 256) {
      safelyRecordAuditEvent(db, {
        eventType: "login_invalid", requestId: req.requestId, outcome: "denied", httpStatus: 400,
        method: req.method, path: "/api/auth/login", clientIp: req.clientIp, details: { reason: "invalid_length" },
      });
      return void res.status(400).json({ error: "账号或密码长度无效" });
    }
    let normalized = identifier;
    if (identifier !== "admin" && !identifier.startsWith("admin")) {
      try { normalized = normalizePhone(identifier); } catch { /* custom admin name remains usable */ }
    }
    const accountFingerprint = identifierFingerprint(normalized);
    const attemptKey = `${req.clientIp ?? "unknown"}|${accountFingerprint}`;
    const retryAfter = loginLimiter.retryAfterSeconds(attemptKey);
    if (retryAfter > 0) {
      res.setHeader("Retry-After", String(retryAfter));
      safelyRecordAuditEvent(db, {
        eventType: "login_rate_limited", requestId: req.requestId, outcome: "denied", httpStatus: 429,
        method: req.method, path: "/api/auth/login", clientIp: req.clientIp,
        details: { accountFingerprint, retryAfterSeconds: retryAfter },
      });
      return void res.status(429).json({ error: "登录失败次数过多，请稍后再试" });
    }
    const user = db.prepare("select id, password_hash as passwordHash from users where username = ? and active = 1")
      .get(normalized) as { id: number; passwordHash: string } | undefined;
    const passwordMatches = verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches) {
      loginLimiter.recordFailure(attemptKey);
      safelyRecordAuditEvent(db, {
        eventType: "login_failed", requestId: req.requestId, userId: user?.id, outcome: "denied", httpStatus: 401,
        method: req.method, path: "/api/auth/login", clientIp: req.clientIp, details: { accountFingerprint },
      });
      return void res.status(401).json({ error: "账号或密码不正确" });
    }
    loginLimiter.clear(attemptKey);
    const token = createSession(db, user.id);
    req.auditUserId = user.id;
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: process.env.COOKIE_SECURE === "true", maxAge: 7 * 86_400_000 });
    safelyRecordAuditEvent(db, {
      eventType: "login_succeeded", requestId: req.requestId, userId: user.id, outcome: "success", httpStatus: 200,
      method: req.method, path: "/api/auth/login", clientIp: req.clientIp, details: { accountFingerprint },
    });
    res.json({ ok: true });
  });

  router.get("/admin/audit-events", requireAdmin, (req, res) => {
    const requestedLimit = Number(req.query.limit ?? 100);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
    const eventType = String(req.query.eventType ?? "").trim().slice(0, 80);
    const rows = (eventType
      ? db.prepare(
        `select id, event_type as eventType, request_id as requestId, user_id as userId, class_id as classId,
                outcome, http_status as httpStatus, method, path, client_ip as clientIp,
                details_json as detailsJson, created_at as createdAt
           from system_audit_events where event_type = ? order by id desc limit ?`
      ).all(eventType, limit)
      : db.prepare(
        `select id, event_type as eventType, request_id as requestId, user_id as userId, class_id as classId,
                outcome, http_status as httpStatus, method, path, client_ip as clientIp,
                details_json as detailsJson, created_at as createdAt
           from system_audit_events order by id desc limit ?`
      ).all(limit)) as Array<Record<string, unknown>>;
    res.json({ events: rows.map((row) => {
      const detailsJson = row.detailsJson;
      const { detailsJson: _discarded, ...event } = row;
      try { return { ...event, details: detailsJson ? JSON.parse(String(detailsJson)) : null }; }
      catch { return { ...event, details: null }; }
    }) });
  });

  router.get("/auth/me", (req: AuthedRequest, res) => {
    if (!req.user) return void res.json({ user: null, classAccesses: [] });
    res.json({ user: req.user, classAccesses: listClassAccesses(db, req.user) });
  });

  router.get("/auth/profile", requireAuth, (req: AuthedRequest, res) => {
    const profile = loadAccountProfile(db, req.user!.id);
    if (!profile) return void res.status(404).json({ error: "账号不存在" });
    res.json({ profile });
  });

  router.patch("/auth/profile", requireAuth, (req: AuthedRequest, res) => {
    const profile = loadAccountProfile(db, req.user!.id);
    if (!profile) return void res.status(404).json({ error: "账号不存在" });
    const isAdmin = Boolean(profile.isAdmin);
    const personId = profile.personId == null ? null : Number(profile.personId);
    if (!isAdmin && !personId) return void res.status(400).json({ error: "账号尚未关联人员资料" });
    const identity = isAdmin
      ? { name: String(req.body.displayName ?? req.body.name ?? profile.displayName ?? "").trim(), dharmaName: null, displayName: String(req.body.displayName ?? req.body.name ?? profile.displayName ?? "").trim() }
      : assertPersonName(
          req.body.name ?? profile.name,
          req.body.dharmaName ?? profile.dharmaName
        );
    if (!identity.displayName) return void res.status(400).json({ error: "显示姓名必填" });
    const currentPhone = profile.phone == null ? null : String(profile.phone);
    const rawPhone = String(req.body.phone ?? currentPhone ?? "").trim();
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    const phoneChanged = phone !== currentPhone;
    const currentUsername = String(profile.username ?? "");
    let username = currentUsername;
    if (!isAdmin) {
      if (req.body.username !== undefined) {
        username = accountUsername(db, { phone: null, requested: req.body.username, displayName: identity.displayName, userId: req.user!.id });
      } else if (currentUsername === currentPhone && phoneChanged) {
        username = accountUsername(db, { phone, displayName: identity.displayName, userId: req.user!.id });
      }
    }
    const usernameChanged = username !== currentUsername;
    if (phoneChanged || usernameChanged) {
      assertCurrentPassword(db, req.user!.id, req.body.currentPassword);
      if (phone) assertPhoneAvailable(db, phone, { personId, userId: req.user!.id });
    }

    db.exec("begin immediate");
    try {
      if (isAdmin) {
        db.prepare("update users set display_name = ?, contact_phone = ?, updated_at = current_timestamp where id = ?")
          .run(identity.displayName, phone, req.user!.id);
      } else {
        db.prepare("update persons set name = ?, dharma_name = ?, phone = ?, updated_at = current_timestamp where id = ?")
          .run(identity.name, identity.dharmaName, phone, personId);
        db.prepare("update users set display_name = ?, username = ?, updated_at = current_timestamp where id = ?")
          .run(identity.displayName, username, req.user!.id);
      }
      db.exec("commit");
      res.json({ profile: loadAccountProfile(db, req.user!.id) });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.post("/auth/logout", (req, res) => {
    deleteSession(db, req.cookies?.[COOKIE]); res.clearCookie(COOKIE); res.json({ ok: true });
  });

  router.post("/auth/change-password", requireAuth, (req: AuthedRequest, res) => {
    const currentPassword = String(req.body.currentPassword ?? "");
    const newPassword = String(req.body.newPassword ?? "");
    if (newPassword.length < 8) return void res.status(400).json({ error: "新密码至少8位" });
    const row = db.prepare("select password_hash as passwordHash from users where id = ?").get(req.user!.id) as { passwordHash: string };
    if (!verifyPassword(currentPassword, row.passwordHash)) return void res.status(400).json({ error: "当前密码不正确" });
    db.prepare("update users set password_hash = ?, must_change_password = 0, updated_at = current_timestamp where id = ?")
      .run(createPasswordHash(newPassword), req.user!.id);
    res.json({ ok: true });
  });

  router.get("/admin/counselors", requireAdmin, (_req, res) => {
    const counselors = db.prepare(
      `select u.id, u.person_id as personId, u.display_name as displayName,
              p.name, p.dharma_name as dharmaName, p.phone, u.username,
              u.can_counsel as active, u.active as accountActive,
              (select count(*) from classes c where c.counselor_user_id = u.id and c.archived = 0) as activeClassCount,
              (select count(*) from classes c where c.counselor_user_id = u.id and c.archived = 1) as archivedClassCount,
              (select count(*) from class_monitors m join classes c on c.id = m.class_id where m.user_id = u.id and c.archived = 0) as monitorClassCount,
              (select count(*) from class_attendance_assistants a join classes c on c.id = a.class_id where a.user_id = u.id and c.archived = 0) as attendanceAssistantClassCount,
              (select c.name from enrollments e
                join classes c on c.id = e.class_id and c.archived = 0
                join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
               where e.person_id = u.person_id and es.status in ('normal', 'leave') limit 1) as studentClassName,
              (select es.status from enrollments e
                join classes c on c.id = e.class_id and c.archived = 0
                join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
               where e.person_id = u.person_id and es.status in ('normal', 'leave') limit 1) as studentStatus,
              case when
                not exists (select 1 from classes c where c.counselor_user_id = u.id or c.created_by = u.id)
                and not exists (select 1 from schedule_breaks b where b.created_by = u.id)
                and not exists (select 1 from attendance_entries a where a.modified_by = u.id)
                and not exists (select 1 from attendance_audit a where a.modified_by = u.id)
                and not exists (select 1 from class_monitors m where m.user_id = u.id or m.assigned_by = u.id)
                and not exists (select 1 from class_attendance_assistants a where a.user_id = u.id or a.assigned_by = u.id)
                and not exists (select 1 from class_counselor_history h where h.counselor_user_id = u.id or h.assigned_by = u.id)
                and not exists (select 1 from enrollments e where e.person_id = u.person_id)
              then 1 else 0 end as deletable
         from users u
         join persons p on p.id = u.person_id
        where u.counselor_role = 1
        order by u.can_counsel desc, u.display_name`
    ).all().map((row) => {
      const item = row as Record<string, unknown>;
      return { ...item, active: Boolean(item.active), accountActive: Boolean(item.accountActive), deletable: Boolean(item.deletable) };
    });
    res.json({ counselors });
  });

  router.get("/admin/counselor-candidates", requireAdmin, (req, res) => {
    const query = String(req.query.query ?? "").trim().toLowerCase().slice(0, 80);
    const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const candidates = db.prepare(
      `select p.id as personId, e.id as enrollmentId,
              coalesce(nullif(trim(p.name), ''), p.dharma_name) as displayName,
              p.name, p.dharma_name as dharmaName, p.phone,
              c.id as classId, c.name as className, es.status,
              u.username,
              (select group_concat(er.role) from enrollment_roles er where er.enrollment_id = e.id) as roleCsv,
              case when m.enrollment_id is not null then 1 else 0 end as isMonitor,
              case when aa.enrollment_id is not null then 1 else 0 end as isAttendanceAssistant
         from enrollments e
         join persons p on p.id = e.person_id
         join classes c on c.id = e.class_id and c.archived = 0
         join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
         left join users u on u.person_id = p.id
         left join class_monitors m on m.class_id = e.class_id and m.enrollment_id = e.id
         left join class_attendance_assistants aa on aa.class_id = e.class_id and aa.enrollment_id = e.id
        where es.status in ('normal', 'leave')
          and coalesce(u.counselor_role, 0) = 0
          and (? = '' or lower(coalesce(p.name, '')) like ? escape '\\'
            or lower(coalesce(p.dharma_name, '')) like ? escape '\\'
            or lower(coalesce(p.phone, '')) like ? escape '\\'
            or lower(c.name) like ? escape '\\')
        order by case es.status when 'normal' then 0 else 1 end,
                 case when trim(c.name) glob '[0-9]*' and trim(c.name) not glob '*[^0-9]*' then 0 else 1 end,
                 case when trim(c.name) glob '[0-9]*' and trim(c.name) not glob '*[^0-9]*' then cast(trim(c.name) as integer) end,
                 c.name, displayName
        limit 200`
    ).all(query, pattern, pattern, pattern, pattern).map((row) => {
      const item = row as Record<string, unknown>;
      const roles = item.roleCsv ? String(item.roleCsv).split(",") : [];
      return {
        ...item,
        identities: [
          ...(item.isMonitor ? ["monitor"] : []),
          ...(item.isAttendanceAssistant ? ["attendance_assistant"] : []),
          ...roles,
          "student"
        ]
      };
    });
    res.json({ candidates });
  });

  router.post("/admin/counselors", requireAdmin, (req: AuthedRequest, res) => {
    const selectedPersonId = req.body.personId == null ? null : numberParam(req.body.personId, "学员");
    const selected = selectedPersonId == null ? undefined : db.prepare(
      `select p.id as personId, p.name, p.dharma_name as dharmaName, p.phone
         from persons p
        where p.id = ?
          and exists (
            select 1 from enrollments e
            join classes c on c.id = e.class_id and c.archived = 0
            join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
            where e.person_id = p.id and es.status in ('normal', 'leave')
          )`
    ).get(selectedPersonId) as { personId: number; name: string; dharmaName: string | null; phone: string | null } | undefined;
    if (selectedPersonId != null && !selected) {
      return void res.status(400).json({ error: "只能从未归档班级的正常或休学学员中选择辅导员" });
    }
    const identity = selected
      ? assertPersonName(selected.name, selected.dharmaName)
      : assertPersonName(req.body.name ?? req.body.displayName, req.body.dharmaName);
    const rawPhone = String(selected ? selected.phone ?? "" : req.body.phone ?? "").trim();
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    db.exec("begin immediate");
    try {
      const person = selected
        ? { personId: selected.personId, phone, existing: true }
        : createOrUpdatePerson(db, { name: identity.name, dharmaName: identity.dharmaName, phone });
      const existingUser = db.prepare("select id, username, can_counsel as canCounsel from users where person_id = ?").get(person.personId) as
        | { id: number; username: string; canCounsel: number }
        | undefined;
      let userId: number; let temporaryPassword: string | undefined; let username: string;
      if (existingUser) {
        userId = existingUser.id;
        username = selected || req.body.username === undefined
          ? existingUser.username
          : accountUsername(db, { requested: req.body.username, displayName: identity.displayName, userId });
        db.prepare("update users set counselor_role = 1, can_counsel = 1, active = 1, display_name = ?, username = ?, updated_at = current_timestamp where id = ?")
          .run(identity.displayName, username, userId);
      } else {
        temporaryPassword = generateTemporaryPassword();
        username = accountUsername(db, { phone, requested: req.body.username, displayName: identity.displayName });
        const result = db.prepare(
          `insert into users (person_id, username, password_hash, display_name, counselor_role, can_counsel, must_change_password)
           values (?, ?, ?, ?, 1, 1, 1)`
        ).run(person.personId, username, createPasswordHash(temporaryPassword), identity.displayName);
        userId = Number(result.lastInsertRowid);
      }
      db.exec("commit");
      res.json({ id: userId, temporaryPassword, phone, username, loginIdentifier: username });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.patch("/admin/counselors/:id", requireAdmin, (req, res) => {
    const id = numberParam(req.params.id, "辅导员账号 ID");
    const counselor = db.prepare(
      `select u.id, u.is_admin as isAdmin, u.person_id as personId, u.display_name as displayName,
              u.username, p.name, p.dharma_name as dharmaName, p.phone
         from users u join persons p on p.id = u.person_id
        where u.id = ? and u.counselor_role = 1`
    ).get(id) as { id: number; isAdmin: number; personId: number; displayName: string; username: string; name: string; dharmaName: string | null; phone: string | null } | undefined;
    if (!counselor || counselor.isAdmin) return void res.status(404).json({ error: "辅导员账号不存在" });

    const editsProfile = req.body.displayName !== undefined || req.body.name !== undefined ||
      req.body.dharmaName !== undefined || req.body.phone !== undefined || req.body.username !== undefined;
    if (editsProfile) {
      const identity = assertPersonName(req.body.name ?? req.body.displayName ?? counselor.name,
        req.body.dharmaName === undefined ? counselor.dharmaName : req.body.dharmaName);
      const rawPhone = req.body.phone === undefined ? counselor.phone : String(req.body.phone ?? "").trim();
      const phone = rawPhone ? normalizePhone(String(rawPhone)) : null;
      let username = counselor.username;
      if (req.body.username !== undefined) {
        username = accountUsername(db, { requested: req.body.username, displayName: identity.displayName, userId: id });
      } else if (counselor.username === counselor.phone && phone !== counselor.phone) {
        username = accountUsername(db, { phone, displayName: identity.displayName, userId: id });
      }
      if (phone !== counselor.phone || username !== counselor.username) {
        assertCurrentPassword(db, (req as AuthedRequest).user!.id, req.body.currentPassword);
        if (phone) assertPhoneAvailable(db, phone, { personId: counselor.personId, userId: counselor.id });
      }
      db.exec("begin immediate");
      try {
        db.prepare("update persons set name = ?, dharma_name = ?, phone = ?, updated_at = current_timestamp where id = ?")
          .run(identity.name, identity.dharmaName, phone, counselor.personId);
        db.prepare("update users set display_name = ?, username = ?, updated_at = current_timestamp where id = ?")
          .run(identity.displayName, username, counselor.id);
        db.exec("commit");
        return void res.json({ ok: true, id, displayName: identity.displayName, dharmaName: identity.dharmaName, phone, username });
      } catch (error) { db.exec("rollback"); throw error; }
    }

    if (typeof req.body.active !== "boolean") return void res.status(400).json({ error: "请指定启用或停用状态" });

    if (req.body.active) {
      db.prepare("update users set can_counsel = 1, active = 1, updated_at = current_timestamp where id = ?").run(id);
      return void res.json({ ok: true, active: true, accountActive: true });
    }

    const activeClasses = db.prepare(
      "select id, name from classes where counselor_user_id = ? and archived = 0 order by name"
    ).all(id) as Array<{ id: number; name: string }>;
    if (activeClasses.length) {
      return void res.status(409).json({
        error: `该辅导员仍负责 ${activeClasses.length} 个未归档班级，请先转交班级后再停用`,
        classes: activeClasses
      });
    }
    const isMonitor = Boolean(db.prepare(
      "select 1 from class_monitors m join classes c on c.id = m.class_id where m.user_id = ? and c.archived = 0 limit 1"
    ).get(id));
    const isAttendanceAssistant = Boolean(db.prepare(
      "select 1 from class_attendance_assistants a join classes c on c.id = a.class_id where a.user_id = ? and c.archived = 0 limit 1"
    ).get(id));
    const keepsAccount = isMonitor || isAttendanceAssistant;
    db.exec("begin immediate");
    try {
      db.prepare("update users set can_counsel = 0, active = ?, updated_at = current_timestamp where id = ?").run(keepsAccount ? 1 : 0, id);
      if (!keepsAccount) db.prepare("delete from sessions_auth where user_id = ?").run(id);
      db.exec("commit");
      res.json({ ok: true, active: false, accountActive: keepsAccount });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.delete("/admin/counselors/:id", requireAdmin, (req, res) => {
    const id = numberParam(req.params.id, "辅导员账号 ID");
    const counselor = db.prepare(
      "select id, person_id as personId, is_admin as isAdmin from users where id = ? and counselor_role = 1"
    ).get(id) as { id: number; personId: number; isAdmin: number } | undefined;
    if (!counselor || counselor.isAdmin) return void res.status(404).json({ error: "辅导员账号不存在" });
    const references = db.prepare(
      `select
        (select count(*) from classes c where c.counselor_user_id = ? or c.created_by = ?) +
        (select count(*) from schedule_breaks b where b.created_by = ?) +
        (select count(*) from attendance_entries a where a.modified_by = ?) +
        (select count(*) from attendance_audit a where a.modified_by = ?) +
        (select count(*) from class_monitors m where m.user_id = ? or m.assigned_by = ?) +
        (select count(*) from class_attendance_assistants a where a.user_id = ? or a.assigned_by = ?) +
        (select count(*) from class_counselor_history h where h.counselor_user_id = ? or h.assigned_by = ?) +
        (select count(*) from enrollments e where e.person_id = ?) as count`
    ).get(id, id, id, id, id, id, id, id, id, id, id, counselor.personId) as { count: number };
    if (references.count > 0) {
      return void res.status(409).json({ error: "该账号已有班级、学员或操作历史，只能停用，不能永久删除" });
    }
    db.exec("begin immediate");
    try {
      db.prepare("delete from users where id = ?").run(id);
      db.prepare("delete from persons where id = ?").run(counselor.personId);
      db.exec("commit");
      res.json({ ok: true });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.post("/admin/users/:id/reset-password", requireAdmin, (req, res) => {
    const id = numberParam(req.params.id, "账号 ID");
    const temporaryPassword = generateTemporaryPassword();
    db.prepare("update users set password_hash = ?, must_change_password = 1, active = 1, updated_at = current_timestamp where id = ?")
      .run(createPasswordHash(temporaryPassword), id);
    res.json({ temporaryPassword });
  });

  router.get("/classes", requireAuth, (req: AuthedRequest, res) => {
    res.json({ classes: listClasses(db, req.user!.id, req.user!.isAdmin, req.user!.canCounsel) });
  });

  router.post("/classes", requireAuth, (req: AuthedRequest, res) => {
    if (!req.user!.isAdmin && !req.user!.canCounsel) return void res.status(403).json({ error: "只有管理员和辅导员可以创建班级" });
    const counselorUserId = req.user!.isAdmin ? numberParam(req.body.counselorId ?? req.body.counselorUserId, "辅导员") : req.user!.id;
    const cadenceMode = String(req.body.cadenceMode ?? "same_week") as CadenceMode;
    if (!CADENCE_MODES.includes(cadenceMode)) return void res.status(400).json({ error: "学习模式无效" });
    const id = createClass(db, {
      name: String(req.body.name ?? ""), counselorUserId, createdBy: req.user!.id,
      groupCount: Number(req.body.groupCount ?? 3), cadenceMode,
      meetingTime: String(req.body.meetingTime ?? "").trim() || null,
      firstDueDate: req.body.firstDueDate ? validDate(req.body.firstDueDate) : undefined,
      lessonCount: req.body.lessonCount ? Number(req.body.lessonCount) : 50
    });
    res.json({ id, classId: id });
  });

  router.get("/classes/:classId", requireAuth, requireClassAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId);
    const item = (listClasses(db, req.user!.id, req.user!.isAdmin, req.user!.canCounsel) as Array<Record<string, unknown>>).find((row) => Number(row.id) === classId);
    if (!item) return void res.status(404).json({ error: "班级不存在" });
    res.json({ class: item, ...item });
  });

  router.patch("/classes/:classId", requireAuth, requireClassAccess(db, true), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId);
    const name = req.body.name === undefined ? undefined : String(req.body.name).trim();
    if (name !== undefined && !name) return void res.status(400).json({ error: "班名不能为空" });
    const counselorRequested = req.body.counselorId !== undefined || req.body.counselorUserId !== undefined;
    if (counselorRequested && !req.user!.isAdmin) return void res.status(403).json({ error: "只有管理员可以更换辅导员" });
    const counselorId = counselorRequested ? numberParam(req.body.counselorId ?? req.body.counselorUserId, "辅导员") : undefined;
    if (counselorId !== undefined && !db.prepare("select 1 from users where id = ? and can_counsel = 1 and active = 1").get(counselorId)) {
      return void res.status(400).json({ error: "辅导员账号无效" });
    }
    const mode = req.body.cadenceMode === undefined ? undefined : String(req.body.cadenceMode) as CadenceMode;
    if (mode !== undefined && !CADENCE_MODES.includes(mode)) return void res.status(400).json({ error: "学习模式无效" });
    if (req.body.archived !== undefined && typeof req.body.archived !== "boolean") {
      return void res.status(400).json({ error: "归档状态无效" });
    }
    const meetingTime = req.body.meetingTime === undefined ? undefined : String(req.body.meetingTime).trim() || null;
    const sourceProgress = req.body.sourceProgress === undefined ? undefined : String(req.body.sourceProgress).trim() || null;
    const desired = req.body.groupCount === undefined ? undefined : Number(req.body.groupCount);
    if (desired !== undefined && (!Number.isInteger(desired) || desired < 1 || desired > 5)) {
      return void res.status(400).json({ error: "小组数必须为1至5" });
    }
    const classState = db.prepare("select cadence_mode as cadenceMode, counselor_user_id as counselorId from classes where id = ?").get(classId) as { cadenceMode: CadenceMode; counselorId: number };
    if (req.body.archived === false) {
      const restoredCounselorId = counselorId ?? classState.counselorId;
      if (!db.prepare("select 1 from users where id = ? and can_counsel = 1 and active = 1").get(restoredCounselorId)) {
        return void res.status(400).json({ error: "请先恢复原辅导员账号，或选择另一位正常辅导员后再恢复班级" });
      }
    }
    const modeChanged = mode !== undefined && mode !== classState.cadenceMode;
    if (modeChanged) freezeStartedLessons(db, classId);
    db.exec("begin immediate");
    try {
      if (req.body.archived === false) {
        const conflict = db.prepare(
          `select p.name, other.name as otherClassName
             from enrollments e
             join persons p on p.id = e.person_id
             join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null and es.status != 'withdrawn'
             join enrollments oe on oe.person_id = e.person_id and oe.class_id != e.class_id
             join enrollment_status_history oes on oes.enrollment_id = oe.id and oes.effective_to_sequence is null and oes.status != 'withdrawn'
             join classes other on other.id = oe.class_id and other.archived = 0
            where e.class_id = ? limit 1`
        ).get(classId) as { name: string; otherClassName: string } | undefined;
        if (conflict) throw new Error(`无法恢复班级：学员“${conflict.name}”已在“${conflict.otherClassName}”就读`);
      }
      if (name !== undefined) db.prepare("update classes set name = ?, updated_at = current_timestamp where id = ?").run(name, classId);
      if (meetingTime !== undefined) db.prepare("update classes set meeting_time = ?, updated_at = current_timestamp where id = ?").run(meetingTime, classId);
      if (sourceProgress !== undefined) db.prepare("update classes set source_progress = ?, updated_at = current_timestamp where id = ?").run(sourceProgress, classId);
      if (counselorId !== undefined && counselorId !== classState.counselorId) {
        db.prepare("delete from class_monitors where class_id = ? and user_id = ?").run(classId, counselorId);
        db.prepare("delete from class_attendance_assistants where class_id = ? and user_id = ?").run(classId, counselorId);
        db.prepare("update class_counselor_history set ended_at = current_timestamp where class_id = ? and ended_at is null").run(classId);
        db.prepare("insert into class_counselor_history (class_id, counselor_user_id, assigned_by) values (?, ?, ?)")
          .run(classId, counselorId, req.user!.id);
        db.prepare("update classes set counselor_user_id = ?, updated_at = current_timestamp where id = ?").run(counselorId, classId);
      }
      if (modeChanged) updateFutureCadence(db, classId, mode, { manageTransaction: false, freezeStarted: false });
      if (req.body.archived !== undefined) {
        db.prepare("update classes set archived = ?, updated_at = current_timestamp where id = ?").run(req.body.archived ? 1 : 0, classId);
        if (req.body.archived === true) {
          const monitor = db.prepare("select user_id as userId from class_monitors where class_id = ?").get(classId) as { userId: number } | undefined;
          const assistants = db.prepare(
            "select user_id as userId from class_attendance_assistants where class_id = ?"
          ).all(classId) as Array<{ userId: number }>;
          db.prepare("delete from class_monitors where class_id = ?").run(classId);
          db.prepare("delete from class_attendance_assistants where class_id = ?").run(classId);
          if (monitor) deactivateRolelessUser(db, monitor.userId);
          assistants.forEach((assistant) => deactivateRolelessUser(db, assistant.userId));
        }
      }
      if (desired !== undefined) {
        const active = db.prepare("select id, name, sort_order as sortOrder from groups where class_id = ? and active = 1 order by sort_order")
          .all(classId) as Array<{ id: number; name: string; sortOrder: number }>;
        if (desired > active.length) {
          const defaults = ["第一组", "第二组", "第三组", "第四组", "第五组"];
          const maxSort = active.at(-1)?.sortOrder ?? 0;
          const insert = db.prepare("insert into groups (class_id, name, sort_order) values (?, ?, ?)");
          const usedNames = new Set(active.map((group) => group.name));
          for (let index = active.length; index < desired; index += 1) {
            const name = defaults.find((candidate) => !usedNames.has(candidate)) ?? `第${maxSort + index - active.length + 1}组`;
            insert.run(classId, name, maxSort + index - active.length + 1);
            usedNames.add(name);
          }
        } else if (desired < active.length) {
          const removing = active.slice(desired);
          for (const group of removing) {
            const assigned = db.prepare(
              `select 1 from group_assignments ga
                join enrollments e on e.id = ga.enrollment_id
                join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
                where ga.group_id = ? and ga.effective_to_sequence is null and es.status != 'withdrawn' limit 1`
            ).get(group.id);
            if (assigned) throw new Error(`请先把“${group.name}”的学员转入其他小组`);
          }
          const archive = db.prepare("update groups set active = 0, archived_at = current_timestamp where id = ?");
          removing.forEach((group) => archive.run(group.id));
        }
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    res.json({ ok: true });
  });

  router.delete("/classes/:classId", requireAdmin, (req, res) => {
    const classId = numberParam(req.params.classId);
    if (!db.prepare("select 1 from classes where id = ?").get(classId)) return void res.status(404).json({ error: "班级不存在" });
    const used = db.prepare(
      `select
        (select count(*) from enrollments where class_id = ?) +
        (select count(*) from lessons where class_id = ?) +
        (select count(*) from schedule_breaks where class_id = ?) as count`
    ).get(classId, classId, classId) as { count: number };
    if (used.count > 0) return void res.status(409).json({ error: "该班级已有学员、课表或历史数据，只能停用，不能永久删除" });
    db.prepare("delete from classes where id = ?").run(classId);
    res.json({ ok: true });
  });

  router.get("/classes/:classId/groups", requireAuth, requireClassAccess(db), (req, res) => {
    const classId = numberParam(req.params.classId);
    const groups = db.prepare(
      `select g.id, g.name, g.sort_order as sortOrder, g.active,
        (select count(*) from group_assignments ga
          join enrollments e on e.id = ga.enrollment_id
          join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
          where ga.group_id = g.id and ga.effective_to_sequence is null and es.status != 'withdrawn') as studentCount
       from groups g where g.class_id = ? order by g.active desc, g.sort_order`
    ).all(classId).map((row) => ({ ...(row as Record<string, unknown>), active: Boolean((row as Record<string, unknown>).active) }));
    res.json({ groups });
  });

  router.post("/classes/:classId/groups", requireAuth, requireClassAccess(db, true), (req, res) => {
    const classId = numberParam(req.params.classId);
    const count = (db.prepare("select count(*) as count from groups where class_id = ? and active = 1").get(classId) as { count: number }).count;
    if (count >= 5) return void res.status(400).json({ error: "一个班最多5个小组" });
    const name = String(req.body.name ?? `第${count + 1}组`).trim();
    if (!name) return void res.status(400).json({ error: "组名不能为空" });
    const sort = (db.prepare("select coalesce(max(sort_order), 0) as max from groups where class_id = ?").get(classId) as { max: number }).max + 1;
    const result = db.prepare("insert into groups (class_id, name, sort_order) values (?, ?, ?)").run(classId, name, sort);
    res.json({ id: Number(result.lastInsertRowid) });
  });

  router.patch("/classes/:classId/groups/:groupId", requireAuth, requireClassAccess(db, true), (req, res) => {
    const classId = numberParam(req.params.classId); const groupId = numberParam(req.params.groupId);
    const group = db.prepare("select active from groups where id = ? and class_id = ?").get(groupId, classId) as { active: number } | undefined;
    if (!group) return void res.status(404).json({ error: "小组不存在" });
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim(); if (!name) return void res.status(400).json({ error: "组名不能为空" });
      db.prepare("update groups set name = ? where id = ?").run(name, groupId);
    }
    if (req.body.active === false && group.active) {
      const activeCount = (db.prepare("select count(*) as count from groups where class_id = ? and active = 1").get(classId) as { count: number }).count;
      if (activeCount <= 1) return void res.status(400).json({ error: "班级至少保留一个小组" });
      const assigned = db.prepare(
        `select 1 from group_assignments ga
          join enrollments e on e.id = ga.enrollment_id
          join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
          where ga.group_id = ? and ga.effective_to_sequence is null and es.status != 'withdrawn' limit 1`
      ).get(groupId);
      if (assigned) return void res.status(400).json({ error: "请先把该组学员转入其他小组" });
      db.prepare("update groups set active = 0, archived_at = current_timestamp where id = ?").run(groupId);
    }
    res.json({ ok: true });
  });

  router.get("/classes/:classId/students", requireAuth, requireClassAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId);
    const students = db.prepare(
      `select e.id, e.id as studentId, e.person_id as personId, p.name as legalName,
              coalesce(nullif(trim(p.name), ''), p.dharma_name) as name, p.dharma_name as dharmaName,
              p.phone, e.note, g.id as groupId, g.name as groupName,
              es.status,
              (select group_concat(er.role) from enrollment_roles er where er.enrollment_id = e.id) as roleCsv,
              case when m.enrollment_id is not null then 1 else 0 end as isMonitor,
              case when aa.enrollment_id is not null then 1 else 0 end as isAttendanceAssistant,
              e.active_from_sequence as activeFromSequence, e.inactive_from_sequence as inactiveFromSequence
         from enrollments e join persons p on p.id = e.person_id
         left join group_assignments ga on ga.enrollment_id = e.id and ga.effective_to_sequence is null
         left join groups g on g.id = ga.group_id
         join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
         left join class_monitors m on m.class_id = e.class_id and m.enrollment_id = e.id
         left join class_attendance_assistants aa on aa.class_id = e.class_id and aa.enrollment_id = e.id
        where e.class_id = ?
        order by case es.status when 'normal' then 0 when 'leave' then 1 else 2 end, g.sort_order, p.name`
    ).all(classId).map((row) => {
      const item = row as Record<string, unknown>;
      const roles = item.roleCsv ? String(item.roleCsv).split(",") : [];
      return {
        ...item,
        active: item.status === "normal",
        identities: [
          ...(item.isMonitor ? ["monitor"] : []),
          ...(item.isAttendanceAssistant ? ["attendance_assistant"] : []),
          ...roles,
          "student"
        ]
      };
    });
    const visible = req.classPermission === "monitor"
      ? students.map((student) => {
          const { phone: _phone, note: _note, personId: _personId, ...safe } = student as Record<string, unknown>;
          return safe;
        })
      : students;
    res.json({ students: visible });
  });

  router.post("/classes/:classId/students", requireAuth, requireClassAccess(db, true), (req, res) => {
    const classId = numberParam(req.params.classId);
    const identity = assertPersonName(req.body.name, req.body.dharmaName);
    const groupId = numberParam(req.body.groupId, "小组");
    if (!db.prepare("select 1 from groups where id = ? and class_id = ? and active = 1").get(groupId, classId)) return void res.status(400).json({ error: "小组无效" });
    const effectiveSequence = getNextEffectiveSequence(db, classId);
    db.exec("begin immediate");
    try {
      const person = createOrUpdatePerson(db, { name: identity.name, dharmaName: identity.dharmaName, phone: req.body.phone });
      const id = insertEnrollment(db, {
        classId, personId: person.personId, groupId, note: req.body.note, effectiveSequence,
        status: parseEnrollmentStatus(req.body.status), roles: parseEnrollmentRoles(req.body.identities ?? req.body.roles)
      });
      db.exec("commit"); res.json({ id, studentId: id, effectiveSequence });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.patch("/classes/:classId/students/:studentId", requireAuth, requireClassAccess(db, true), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId); const enrollmentId = numberParam(req.params.studentId, "学员 ID");
    const row = db.prepare(
      `select e.person_id as personId, e.active_from_sequence as activeFromSequence,
              e.inactive_from_sequence as inactiveFromSequence, p.phone,
              es.status as currentStatus,
              (select id from users where person_id = e.person_id) as userId
         from enrollments e
         join persons p on p.id = e.person_id
         join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
        where e.id = ? and e.class_id = ?`
    ).get(enrollmentId, classId) as { personId: number; activeFromSequence: number; inactiveFromSequence: number | null; phone: string | null; userId: number | null; currentStatus: EnrollmentStatus } | undefined;
    if (!row) return void res.status(404).json({ error: "学员不存在" });
    const requestedStatus = req.body.status !== undefined
      ? parseEnrollmentStatus(req.body.status, row.currentStatus)
      : req.body.active === false ? "withdrawn" : row.currentStatus;
    if (requestedStatus !== "normal" && row.currentStatus === "normal" &&
      db.prepare("select 1 from class_monitors where class_id = ? and enrollment_id = ?").get(classId, enrollmentId)) {
      return void res.status(400).json({ error: "该学员当前是班长，请先更换或取消班长后再修改状态" });
    }
    if (requestedStatus !== "normal" && row.currentStatus === "normal" &&
      db.prepare("select 1 from class_attendance_assistants where class_id = ? and enrollment_id = ?").get(classId, enrollmentId)) {
      return void res.status(400).json({ error: "该学员当前是考勤员，请先取消考勤员权限后再修改状态" });
    }
    const effectiveSequence = getNextEffectiveSequence(db, classId);
    db.exec("begin immediate");
    try {
      if (req.body.name !== undefined || req.body.dharmaName !== undefined || req.body.phone !== undefined) {
        const current = db.prepare("select name, dharma_name as dharmaName, phone from persons where id = ?").get(row.personId) as Record<string, unknown>;
        const rawPhone = req.body.phone === undefined ? current.phone : String(req.body.phone ?? "").trim();
        const phone = rawPhone ? normalizePhone(String(rawPhone)) : null;
        if (phone !== row.phone && row.userId && !req.user!.isAdmin) throw new Error("该手机号已绑定登录账号，请联系管理员修改");
        if (phone !== row.phone) {
          if (row.userId) assertCurrentPassword(db, req.user!.id, req.body.currentPassword);
          if (phone) assertPhoneAvailable(db, phone, { personId: row.personId, userId: row.userId });
        }
        const dharmaName = req.body.dharmaName === undefined
          ? (current.dharmaName == null ? null : String(current.dharmaName))
          : String(req.body.dharmaName || "").trim() || null;
        const identity = assertPersonName(req.body.name ?? current.name, dharmaName);
        db.prepare("update persons set name = ?, dharma_name = ?, phone = ?, updated_at = current_timestamp where id = ?")
          .run(identity.name, identity.dharmaName, phone, row.personId);
        if (row.userId) {
          const account = db.prepare("select username from users where id = ?").get(row.userId) as { username: string };
          const username = account.username === row.phone && phone !== row.phone
            ? accountUsername(db, { phone, requested: req.body.username, displayName: identity.displayName, userId: row.userId })
            : account.username;
          db.prepare("update users set username = ?, display_name = ?, updated_at = current_timestamp where id = ?")
            .run(username, identity.displayName, row.userId);
        }
      }
      if (req.body.note !== undefined) db.prepare("update enrollments set note = ?, updated_at = current_timestamp where id = ?")
        .run(String(req.body.note || "").trim() || null, enrollmentId);
      const currentGroup = db.prepare(
        "select group_id as groupId from group_assignments where enrollment_id = ? and effective_to_sequence is null"
      ).get(enrollmentId) as { groupId: number };
      const groupId = req.body.groupId === undefined ? currentGroup.groupId : numberParam(req.body.groupId, "小组");
      if (requestedStatus !== "withdrawn" &&
        !db.prepare("select 1 from groups where id = ? and class_id = ? and active = 1").get(groupId, classId)) {
        throw new Error("该学员原小组已停用，请先选择当前小组后再恢复状态");
      }
      if (req.body.groupId !== undefined) {
        if (!db.prepare("select 1 from groups where id = ? and class_id = ? and active = 1").get(groupId, classId)) throw new Error("小组无效");
        setEnrollmentGroupFromSequence(db, enrollmentId, groupId, effectiveSequence);
      }
      if (req.body.identities !== undefined || req.body.roles !== undefined || req.body.groupId !== undefined) {
        const roles = req.body.identities !== undefined || req.body.roles !== undefined
          ? parseEnrollmentRoles(req.body.identities ?? req.body.roles)
          : (db.prepare("select role from enrollment_roles where enrollment_id = ?").all(enrollmentId) as Array<{ role: EnrollmentRole }>).map((item) => item.role);
        updateEnrollmentRoles(db, enrollmentId, classId, groupId, roles);
      }
      if (requestedStatus !== row.currentStatus) {
        if (requestedStatus !== "withdrawn") assertPersonAvailableForEnrollment(db, row.personId, classId);
        setEnrollmentStatusFromSequence(db, enrollmentId, requestedStatus, effectiveSequence);
      }
      db.exec("commit"); res.json({ ok: true, effectiveSequence });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.post("/classes/:classId/import/preview", requireAuth, requireClassAccess(db, true), upload.single("file"), async (req, res) => {
    const classId = numberParam(req.params.classId);
    if (!req.file) return void res.status(400).json({ error: "请选择 Excel 文件" });
    const rows = await parseRosterWorkbook(db, classId, req.file.buffer);
    const summary = { create: 0, update: 0, skip: 0, conflict: 0 };
    rows.forEach((row) => { summary[row.action] += 1; });
    res.json({ rows, summary });
  });

  router.get("/classes/:classId/import/template.xlsx", requireAuth, requireClassAccess(db, true), async (req, res) => {
    const classId = numberParam(req.params.classId);
    const classRow = db.prepare("select name from classes where id = ?").get(classId) as { name: string };
    const groups = db.prepare("select name from groups where class_id = ? and active = 1 order by sort_order").all(classId) as Array<{ name: string }>;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "班级共修管理系统";
    const roster = workbook.addWorksheet("学员名单");
    roster.columns = [
      { header: "姓名", key: "name", width: 18 },
      { header: "法名", key: "dharmaName", width: 18 },
      { header: "电话", key: "phone", width: 20 },
      { header: "小组", key: "groupName", width: 18 },
      { header: "状态", key: "status", width: 14 },
      { header: "身份", key: "identities", width: 28 },
      { header: "备注", key: "note", width: 30 }
    ];
    roster.getRow(1).font = { bold: true };
    roster.getColumn("phone").numFmt = "@";
    const groupValidation = {
      type: "list" as const,
      allowBlank: false,
      formulae: [`"${groups.map((group) => group.name.replaceAll('"', '""')).join(",")}"`]
    };
    for (let row = 2; row <= 1000; row += 1) {
      roster.getCell(`D${row}`).dataValidation = groupValidation;
      roster.getCell(`E${row}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"正常,休学,退学"'] };
    }
    const instructions = workbook.addWorksheet("填写说明");
    instructions.columns = [{ width: 24 }, { width: 72 }];
    instructions.addRows([
      ["班级", classRow.name],
      ["必填列", "姓名或法名至少填写一项、小组（模板须保留电话列，但普通学员的电话内容可以留空）"],
      ["选填列", "电话、状态、身份、备注；状态留空按正常，身份留空按学员"],
      ["身份填写", "可填写组长、慈善、传灯、文宣，多个身份用顿号分隔；班长请在班级设置中任命。"],
      ["电话格式", "普通学员可留空；无手机号的班长或辅导员可使用拼音账号登录。未写国家区号时默认按 +86 处理。"],
      ["无电话匹配", "再次导入无电话学员时按姓名＋法名匹配；本班有多名同名同法名学员时会提示冲突。"],
      ["可用小组", groups.map((group) => group.name).join("、")],
      ["导入流程", "上传后先预览新增、更新、重复和冲突，确认无冲突后再提交。"]
    ]);
    instructions.getColumn(1).font = { bold: true };
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="student-import-template.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  });

  router.post("/classes/:classId/import/commit", requireAuth, requireClassAccess(db, true), (req, res) => {
    const classId = numberParam(req.params.classId); const submittedRows = req.body.rows as ImportRow[];
    if (!Array.isArray(submittedRows) || submittedRows.length === 0) return void res.status(400).json({ error: "没有可导入的数据" });
    const rows = classifyRosterRows(db, classId, submittedRows);
    if (rows.some((row) => row.action === "conflict")) return void res.status(400).json({ error: "请先解决导入冲突" });
    const groups = new Map((db.prepare("select id, name from groups where class_id = ? and active = 1").all(classId) as Array<{ id: number; name: string }>).map((g) => [g.name, g.id]));
    const effectiveSequence = getNextEffectiveSequence(db, classId); let importedCount = 0;
    db.exec("begin immediate");
    try {
      for (const item of rows.filter((row) => row.action !== "skip")) {
        const groupId = groups.get(item.groupName); if (!groupId) throw new Error(`找不到小组“${item.groupName}”`);
        const person = createOrUpdatePerson(db, { ...item, preservePhoneWhenBlank: true });
        const existing = db.prepare("select id from enrollments where class_id = ? and person_id = ?").get(classId, person.personId) as { id: number } | undefined;
        if (existing) {
          db.prepare("update enrollments set note = ?, updated_at = current_timestamp where id = ?").run(item.note, existing.id);
          setEnrollmentGroupFromSequence(db, existing.id, groupId, effectiveSequence);
          updateEnrollmentRoles(db, existing.id, classId, groupId, item.identities);
          setEnrollmentStatusFromSequence(db, existing.id, item.status, effectiveSequence);
        } else {
          insertEnrollment(db, {
            classId, personId: person.personId, groupId, note: item.note, effectiveSequence,
            status: item.status, roles: item.identities
          });
        }
        importedCount += 1;
      }
      db.exec("commit"); res.json({ importedCount, effectiveSequence });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.get("/classes/:classId/lessons", requireAuth, requireClassAttendanceAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId); const today = shanghaiToday();
    const lessons = (db.prepare(
      `select id, sequence, sequence as lessonNumber, title, lesson_type as lessonType, cadence_mode as cadenceMode,
              outline_due_date as outlineDueDate, group_study_due_date as groupStudyDueDate,
              class_study_due_date as classStudyDueDate, roster_frozen_at as frozenAt,
              course_position as coursePosition
         from lessons where class_id = ? order by sequence`
    ).all(classId) as Array<Record<string, unknown>>).map((lesson) => {
      const start = addDays(String(lesson.outlineDueDate), -6); const final = String(lesson.classStudyDueDate);
      const hasRecordedAttendance = lessonHasRecordedAttendance(db, Number(lesson.id));
      const scheduleLocked = lessonScheduleLocked(db, { id: Number(lesson.id), classStudyDueDate: final }, today);
      return { ...lesson, started: start <= today, hasRecordedAttendance, scheduleLocked,
        scheduleEditable: req.user!.isAdmin || !scheduleLocked,
        lockedForMonitor: isMonitorLocked(final, today),
        status: start > today ? "future" : final >= today ? "current" : "finished" };
    });
    const breaks = db.prepare("select id, start_date as date, start_date as startDate, weeks, reason from schedule_breaks where class_id = ? order by start_date").all(classId);
    res.json({ lessons, breaks });
  });

  router.post("/classes/:classId/schedule/generate", requireAuth, requireClassScheduleAccess(db), (req, res) => {
    const classId = numberParam(req.params.classId);
    const firstDueDate = req.body.firstDueDate ?? req.body.firstClassStudyDueDate;
    const cadenceMode = req.body.cadenceMode === undefined ? undefined : String(req.body.cadenceMode) as CadenceMode;
    if (cadenceMode !== undefined && !CADENCE_MODES.includes(cadenceMode)) return void res.status(400).json({ error: "学习模式无效" });
    const seriesKey = String(req.body.seriesKey ?? "wisdom_life").trim();
    const startPosition = Number(req.body.startPosition ?? 1);
    const round = Number(req.body.round ?? 1);
    if (!/^[a-z0-9_]+$/.test(seriesKey)) return void res.status(400).json({ error: "课程体系无效" });
    if (!Number.isInteger(startPosition) || startPosition < 1) return void res.status(400).json({ error: "课程起点无效" });
    if (!Number.isInteger(round) || round < 1 || round > 20) return void res.status(400).json({ error: "学习遍数无效" });
    const generatedCount = setInitialSchedule(
      db, classId, validDate(firstDueDate), Number(req.body.count ?? 50), cadenceMode,
      { seriesKey, startPosition, round }
    );
    res.json({ generatedCount });
  });

  router.post("/classes/:classId/lessons/append", requireAuth, requireClassScheduleAccess(db), (req, res) => {
    const classId = numberParam(req.params.classId);
    const selectedCourse = req.body.course;
    let course: { seriesKey: string; startPosition: number; round: number } | undefined;
    if (selectedCourse !== undefined) {
      if (!selectedCourse || typeof selectedCourse !== "object" || Array.isArray(selectedCourse)) {
        return void res.status(400).json({ error: "追加课程选择无效" });
      }
      const seriesKey = String(selectedCourse.seriesKey ?? "").trim();
      const startPosition = Number(selectedCourse.startPosition);
      const round = Number(selectedCourse.round ?? 1);
      if (!/^[a-z0-9_]+$/.test(seriesKey)) return void res.status(400).json({ error: "课程体系无效" });
      if (!Number.isInteger(startPosition) || startPosition < 1) return void res.status(400).json({ error: "课程起点无效" });
      if (!Number.isInteger(round) || round < 1 || round > 20) return void res.status(400).json({ error: "学习遍数无效" });
      course = { seriesKey, startPosition, round };
    }
    const generatedCount = appendLessons(db, classId, Number(req.body.count ?? 24), course);
    res.json({ generatedCount });
  });

  router.post("/classes/:classId/schedule/rebuild-future", requireAuth, requireClassScheduleAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId);
    const cadenceMode = String(req.body.cadenceMode ?? "") as CadenceMode;
    if (!CADENCE_MODES.includes(cadenceMode)) return void res.status(400).json({ error: "学习模式无效" });
    const seriesKey = String(req.body.seriesKey ?? "").trim();
    const startPosition = Number(req.body.startPosition);
    const round = Number(req.body.round ?? 1);
    const count = Number(req.body.count);
    if (!/^[a-z0-9_]+$/.test(seriesKey)) return void res.status(400).json({ error: "课程体系无效" });
    if (!Number.isInteger(startPosition) || startPosition < 1) return void res.status(400).json({ error: "课程起点无效" });
    if (!Number.isInteger(round) || round < 1 || round > 20) return void res.status(400).json({ error: "学习遍数无效" });
    const result = rebuildFutureSchedule(db, classId, {
      firstDueDate: validDate(req.body.firstClassStudyDueDate ?? req.body.firstDueDate),
      count,
      cadenceMode,
      seriesKey,
      startPosition,
      round,
      confirmDiscardAttendance: req.body.confirmDiscardAttendance === true,
      allowLockedOverride: req.user!.isAdmin,
    });
    res.json(result);
  });

  router.post("/classes/:classId/lessons/insert", requireAuth, requireClassScheduleAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId);
    const lessonType = String(req.body.lessonType ?? "regular");
    if (!LESSON_TYPES.includes(lessonType as typeof LESSON_TYPES[number])) return void res.status(400).json({ error: "课次类型无效" });
    const coursePosition = req.body.coursePosition == null || req.body.coursePosition === ""
      ? null
      : Number(req.body.coursePosition);
    const result = insertLesson(db, classId, {
      beforeLessonId: numberParam(req.body.beforeLessonId, "插入位置"),
      title: String(req.body.title ?? ""),
      lessonType: lessonType as typeof LESSON_TYPES[number],
      classStudyDueDate: validDate(req.body.classStudyDueDate),
      coursePosition
    }, { allowLockedOverride: req.user!.isAdmin });
    res.json(result);
  });

  router.patch("/classes/:classId/lessons/:lessonId", requireAuth, requireClassScheduleAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId); const lessonId = numberParam(req.params.lessonId);
    const lessonType = req.body.lessonType === undefined ? undefined : String(req.body.lessonType);
    if (lessonType && !LESSON_TYPES.includes(lessonType as typeof LESSON_TYPES[number])) return void res.status(400).json({ error: "课次类型无效" });
    patchLesson(db, classId, lessonId, { title: req.body.title, lessonType: lessonType as typeof LESSON_TYPES[number] | undefined,
      classStudyDueDate: req.body.classStudyDueDate ? validDate(req.body.classStudyDueDate) : undefined },
    { allowLockedOverride: req.user!.isAdmin });
    res.json({ ok: true });
  });

  router.delete("/classes/:classId/lessons/:lessonId", requireAuth, requireClassScheduleAccess(db), (req: AuthedRequest, res) => {
    const result = deleteLesson(db, numberParam(req.params.classId), numberParam(req.params.lessonId), {
      confirmDiscardAttendance: req.body?.confirmDiscardAttendance === true
        || req.query.confirmDiscardAttendance === "true",
      allowLockedOverride: req.user!.isAdmin,
    });
    res.json(result);
  });

  router.post("/classes/:classId/breaks", requireAuth, requireClassScheduleAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId);
    addScheduleBreak(db, classId, validDate(req.body.startDate ?? req.body.date), Number(req.body.weeks ?? 1),
      String(req.body.reason ?? "放假/暂停"), req.user!.id, { allowLockedOverride: req.user!.isAdmin });
    res.json({ ok: true });
  });

  router.patch("/classes/:classId/breaks/:breakId", requireAuth, requireClassScheduleAccess(db), (req: AuthedRequest, res) => {
    const result = updateScheduleBreak(db, numberParam(req.params.classId), numberParam(req.params.breakId, "暂停周"), {
      startsOn: validDate(req.body.startDate ?? req.body.date),
      weeks: Number(req.body.weeks ?? 1),
      reason: String(req.body.reason ?? req.body.title ?? "放假/暂停"),
    }, {
      allowLockedOverride: req.user!.isAdmin,
      confirmLockedImpact: req.body.confirmLockedImpact === true,
    });
    res.json(result);
  });

  router.delete("/classes/:classId/breaks/:breakId", requireAuth, requireClassScheduleAccess(db), (req: AuthedRequest, res) => {
    const result = deleteScheduleBreak(db, numberParam(req.params.classId), numberParam(req.params.breakId, "暂停周"), {
      allowLockedOverride: req.user!.isAdmin,
      confirmLockedImpact: req.body?.confirmLockedImpact === true || req.query.confirmLockedImpact === "true",
    });
    res.json(result);
  });

  router.get("/classes/:classId/breaks", requireAuth, requireClassAccess(db), (req, res) => {
    const breaks = db.prepare(
      `select id, start_date as date, start_date as startDate, weeks, reason, reason as title
         from schedule_breaks where class_id = ? order by start_date`
    ).all(numberParam(req.params.classId));
    res.json({ breaks });
  });

  router.put("/classes/:classId/monitor", requireAuth, requireClassAccess(db, true), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId);
    if (req.body.studentId == null && req.body.enrollmentId == null) {
      const current = db.prepare("select user_id as userId from class_monitors where class_id = ?").get(classId) as { userId: number } | undefined;
      db.prepare("delete from class_monitors where class_id = ?").run(classId);
      if (current) deactivateRolelessUser(db, current.userId);
      return void res.json({ ok: true });
    }
    const classRow = db.prepare("select archived, counselor_user_id as counselorUserId from classes where id = ?").get(classId) as
      { archived: number; counselorUserId: number };
    if (classRow.archived) return void res.status(400).json({ error: "已归档班级不能设置班长" });
    const enrollmentId = numberParam(req.body.studentId ?? req.body.enrollmentId, "学员");
    const student = db.prepare(
      `select e.id, e.person_id as personId, p.name, p.dharma_name as dharmaName, p.phone
         from enrollments e
         join persons p on p.id = e.person_id
         join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
        where e.id = ? and e.class_id = ? and es.status = 'normal'`
    ).get(enrollmentId, classId) as { id: number; personId: number; name: string; dharmaName: string | null; phone: string | null } | undefined;
    if (!student) return void res.status(400).json({ error: "班长必须从本班在册学员中选择" });
    const existingUser = db.prepare("select id from users where person_id = ?").get(student.personId) as { id: number } | undefined;
    if (existingUser?.id === classRow.counselorUserId) {
      return void res.status(409).json({ error: "本班辅导员已经拥有全部管理权限，无需重复设置为班长" });
    }
    db.exec("begin immediate");
    try {
      const previous = db.prepare("select user_id as userId from class_monitors where class_id = ?").get(classId) as { userId: number } | undefined;
      const account = ensureClassOperatorAccount(db, student, req.body.username);
      db.prepare(
        "delete from class_monitors where user_id = ? and class_id in (select id from classes where archived = 1)"
      ).run(account.userId);
      const other = db.prepare(
        `select m.class_id as classId from class_monitors m join classes c on c.id = m.class_id
          where m.user_id = ? and m.class_id != ? and c.archived = 0`
      ).get(account.userId, classId) as { classId: number } | undefined;
      if (other) throw new Error("该账号已经是其他班级的班长");
      db.prepare("delete from class_attendance_assistants where class_id = ? and user_id = ?")
        .run(classId, account.userId);
      db.prepare("delete from class_monitors where class_id = ?").run(classId);
      db.prepare("insert into class_monitors (class_id, enrollment_id, user_id, assigned_by) values (?, ?, ?, ?)")
        .run(classId, enrollmentId, account.userId, req.user!.id);
      if (previous && previous.userId !== account.userId) deactivateRolelessUser(db, previous.userId);
      db.exec("commit"); res.json({
        ok: true, userId: account.userId, temporaryPassword: account.temporaryPassword, phone: student.phone,
        username: account.username, loginIdentifier: account.username
      });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.delete("/classes/:classId/monitor", requireAuth, requireClassAccess(db, true), (req, res) => {
    const classId = numberParam(req.params.classId);
    const current = db.prepare("select user_id as userId from class_monitors where class_id = ?").get(classId) as { userId: number } | undefined;
    db.prepare("delete from class_monitors where class_id = ?").run(classId);
    if (current) deactivateRolelessUser(db, current.userId);
    res.json({ ok: true });
  });

  router.post("/classes/:classId/monitor/reset-password", requireAuth, requireClassAccess(db, true), (req, res) => {
    const monitor = db.prepare("select user_id as userId from class_monitors where class_id = ?").get(numberParam(req.params.classId)) as { userId: number } | undefined;
    if (!monitor) return void res.status(404).json({ error: "本班尚未设置班长" });
    const temporaryPassword = generateTemporaryPassword();
    db.prepare("update users set password_hash = ?, must_change_password = 1, active = 1, updated_at = current_timestamp where id = ?")
      .run(createPasswordHash(temporaryPassword), monitor.userId);
    res.json({ temporaryPassword });
  });

  router.get("/classes/:classId/attendance-assistants", requireAuth, requireClassAccess(db, true), (req, res) => {
    const classId = numberParam(req.params.classId);
    const assistants = db.prepare(
      `select a.enrollment_id as enrollmentId, a.user_id as userId,
              coalesce(nullif(trim(p.name), ''), p.dharma_name) as name,
              p.dharma_name as dharmaName, p.phone, u.username
         from class_attendance_assistants a
         join enrollments e on e.id = a.enrollment_id
         join persons p on p.id = e.person_id
         join users u on u.id = a.user_id
        where a.class_id = ? order by a.assigned_at, a.enrollment_id`
    ).all(classId);
    res.json({ assistants });
  });

  router.post("/classes/:classId/attendance-assistants", requireAuth, requireClassAccess(db, true), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId);
    const enrollmentId = numberParam(req.body.studentId ?? req.body.enrollmentId, "学员");
    const classRow = db.prepare("select archived, counselor_user_id as counselorUserId from classes where id = ?").get(classId) as
      { archived: number; counselorUserId: number };
    if (classRow.archived) return void res.status(400).json({ error: "已归档班级不能设置考勤员" });
    const student = db.prepare(
      `select e.id, e.person_id as personId, p.name, p.dharma_name as dharmaName, p.phone
         from enrollments e
         join persons p on p.id = e.person_id
         join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
        where e.id = ? and e.class_id = ? and es.status = 'normal'`
    ).get(enrollmentId, classId) as ClassOperatorStudent | undefined;
    if (!student) return void res.status(400).json({ error: "考勤员必须从本班正常在册学员中选择" });
    if (db.prepare("select 1 from class_attendance_assistants where class_id = ? and enrollment_id = ?").get(classId, enrollmentId)) {
      return void res.status(409).json({ error: "该学员已经是本班考勤员" });
    }
    const existingUser = db.prepare("select id from users where person_id = ?").get(student.personId) as { id: number } | undefined;
    if (existingUser && existingUser.id === classRow.counselorUserId) {
      return void res.status(409).json({ error: "本班辅导员已经拥有全部考勤权限，无需重复设置" });
    }
    if (existingUser && db.prepare("select 1 from class_monitors where class_id = ? and user_id = ?").get(classId, existingUser.id)) {
      return void res.status(409).json({ error: "本班班长已经拥有考勤权限，无需重复设置" });
    }
    db.exec("begin immediate");
    try {
      const account = ensureClassOperatorAccount(db, student, req.body.username);
      db.prepare(
        "insert into class_attendance_assistants (class_id, enrollment_id, user_id, assigned_by) values (?, ?, ?, ?)"
      ).run(classId, enrollmentId, account.userId, req.user!.id);
      db.exec("commit");
      res.json({
        ok: true, enrollmentId, userId: account.userId, username: account.username,
        loginIdentifier: account.username, temporaryPassword: account.temporaryPassword
      });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.delete("/classes/:classId/attendance-assistants/:enrollmentId", requireAuth, requireClassAccess(db, true), (req, res) => {
    const classId = numberParam(req.params.classId);
    const enrollmentId = numberParam(req.params.enrollmentId, "考勤员");
    const current = db.prepare(
      "select user_id as userId from class_attendance_assistants where class_id = ? and enrollment_id = ?"
    ).get(classId, enrollmentId) as { userId: number } | undefined;
    if (!current) return void res.status(404).json({ error: "考勤员权限不存在" });
    db.prepare("delete from class_attendance_assistants where class_id = ? and enrollment_id = ?")
      .run(classId, enrollmentId);
    deactivateRolelessUser(db, current.userId);
    res.json({ ok: true });
  });

  router.post("/classes/:classId/attendance-assistants/:enrollmentId/reset-password", requireAuth, requireClassAccess(db, true), (req, res) => {
    const row = db.prepare(
      "select user_id as userId from class_attendance_assistants where class_id = ? and enrollment_id = ?"
    ).get(numberParam(req.params.classId), numberParam(req.params.enrollmentId, "考勤员")) as { userId: number } | undefined;
    if (!row) return void res.status(404).json({ error: "考勤员权限不存在" });
    const temporaryPassword = generateTemporaryPassword();
    db.prepare("update users set password_hash = ?, must_change_password = 1, active = 1, updated_at = current_timestamp where id = ?")
      .run(createPasswordHash(temporaryPassword), row.userId);
    db.prepare("delete from sessions_auth where user_id = ?").run(row.userId);
    res.json({ temporaryPassword });
  });

  router.get("/classes/:classId/attendance/:lessonId", requireAuth, requireClassAttendanceAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId); const lessonId = numberParam(req.params.lessonId); const today = shanghaiToday();
    const lesson = getLesson(db, classId, lessonId); if (!lesson) return void res.status(404).json({ error: "课次不存在" });
    const courseStart = addDays(String(lesson.outlineDueDate), -6);
    const previewOnly = courseStart > today;
    if (!previewOnly) freezeLessonRoster(db, lessonId);
    let rows = db.prepare(
      `select lr.id as rosterId, lr.enrollment_id as studentId, lr.student_name as name, lr.dharma_name as dharmaName,
              lr.group_id as groupId, lr.group_name as groupName,
              ao.status as outline, ag.status as groupStudy, ac.status as classStudy,
              ao.modified_at as outlineUpdatedAt, uo.display_name as outlineUpdatedBy,
              ag.modified_at as groupStudyUpdatedAt, ug.display_name as groupStudyUpdatedBy,
              ac.modified_at as classStudyUpdatedAt, uc.display_name as classStudyUpdatedBy,
              max(coalesce(ao.modified_at, ''), coalesce(ag.modified_at, ''), coalesce(ac.modified_at, '')) as updatedAt,
              case max(coalesce(ao.modified_at, ''), coalesce(ag.modified_at, ''), coalesce(ac.modified_at, ''))
                when coalesce(ac.modified_at, '') then uc.display_name
                when coalesce(ag.modified_at, '') then ug.display_name
                when coalesce(ao.modified_at, '') then uo.display_name
              end as updatedBy
         from lesson_roster lr
         left join attendance_entries ao on ao.lesson_roster_id = lr.id and ao.metric = 'outline'
         left join attendance_entries ag on ag.lesson_roster_id = lr.id and ag.metric = 'group_study'
         left join attendance_entries ac on ac.lesson_roster_id = lr.id and ac.metric = 'class_study'
         left join users uo on uo.id = ao.modified_by
         left join users ug on ug.id = ag.modified_by
         left join users uc on uc.id = ac.modified_by
        where lr.lesson_id = ? order by lr.group_id, lr.student_name`
    ).all(lessonId) as Array<Record<string, unknown>>;
    if (previewOnly && rows.length === 0) {
      rows = listLessonRosterPreview(db, classId, Number(lesson.sequence)).map((row) => ({
        rosterId: null,
        studentId: row.enrollmentId,
        name: row.name,
        dharmaName: row.dharmaName,
        groupId: row.groupId,
        groupName: row.groupName,
        outline: null,
        groupStudy: null,
        classStudy: null,
        updatedAt: null,
        updatedBy: null,
      }));
    }
    const history = db.prepare(
      `select aa.id, lr.enrollment_id as studentId, lr.student_name as name,
              aa.metric, aa.previous_status as previousStatus, aa.new_status as newStatus,
              u.display_name as modifiedBy, aa.modified_at as modifiedAt
         from attendance_audit aa
         join lesson_roster lr on lr.id = aa.lesson_roster_id
         join users u on u.id = aa.modified_by
        where aa.lesson_id = ?
        order by aa.modified_at desc, aa.id desc`
    ).all(lessonId);
    const locked = isMonitorLocked(String(lesson.classStudyDueDate), today);
    const openMetrics = {
      outline: addDays(String(lesson.outlineDueDate), -6) <= today,
      group_study: addDays(String(lesson.groupStudyDueDate), -6) <= today,
      class_study: addDays(String(lesson.classStudyDueDate), -6) <= today
    };
    const canEdit = courseStart <= today && (req.classPermission === "counselor" || !locked);
    res.json({ attendanceSchemaVersion: ATTENDANCE_SCHEMA_VERSION, previewOnly, attendanceOpensOn: courseStart,
      lesson: { ...lesson, lockedForMonitor: locked }, rows, records: rows, history, canEdit, lockedForMonitor: locked, openMetrics,
      statuses: { outline: OUTLINE_STATUSES, groupStudy: GROUP_STUDY_STATUSES, classStudy: CLASS_STUDY_STATUSES } });
  });

  router.put("/classes/:classId/attendance/:lessonId", requireAuth, requireClassAttendanceAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId); const lessonId = numberParam(req.params.lessonId); const today = shanghaiToday();
    const lesson = getLesson(db, classId, lessonId); if (!lesson) return void res.status(404).json({ error: "课次不存在" });
    if (req.body?.attendanceSchemaVersion !== ATTENDANCE_SCHEMA_VERSION) {
      return void res.status(409).json({
        error: "考勤页面已经更新，请刷新页面后重新操作",
        code: "ATTENDANCE_SCHEMA_VERSION_MISMATCH",
      });
    }
    if (addDays(String(lesson.outlineDueDate), -6) > today) return void res.status(400).json({ error: "该课尚未开始" });
    freezeLessonRoster(db, lessonId);
    if (req.classPermission !== "counselor" && isMonitorLocked(String(lesson.classStudyDueDate), today)) return void res.status(403).json({ error: "该课已超过14天修改期" });
    const allowed: Record<Metric, readonly string[]> = { outline: OUTLINE_STATUSES, group_study: GROUP_STUDY_STATUSES, class_study: CLASS_STUDY_STATUSES };
    const due: Record<Metric, string> = { outline: String(lesson.outlineDueDate), group_study: String(lesson.groupStudyDueDate), class_study: String(lesson.classStudyDueDate) };
    const records = Array.isArray(req.body.records) ? req.body.records : [];
    const upsert = db.prepare(
      `insert into attendance_entries (lesson_id, lesson_roster_id, metric, status, modified_by, modified_at)
       values (?, ?, ?, ?, ?, current_timestamp)
       on conflict(lesson_roster_id, metric) do update set status = excluded.status, modified_by = excluded.modified_by, modified_at = current_timestamp`
    );
    const remove = db.prepare("delete from attendance_entries where lesson_roster_id = ? and metric = ?");
    const audit = db.prepare(
      `insert into attendance_audit (lesson_id, lesson_roster_id, metric, previous_status, new_status, modified_by)
       values (?, ?, ?, ?, ?, ?)`
    );
    db.exec("begin immediate");
    try {
      for (const record of records as Array<Record<string, unknown>>) {
        const enrollmentId = Number(record.studentId ?? record.enrollmentId);
        const roster = db.prepare("select id from lesson_roster where lesson_id = ? and enrollment_id = ?").get(lessonId, enrollmentId) as { id: number } | undefined;
        if (!roster) throw new Error("学员不在本课名单中");
        const inputs: Array<[Metric, unknown]> = [
          ["outline", record.outlineStatus ?? record.outline],
          ["group_study", record.groupStudyStatus ?? record.groupStudy ?? record.group_study],
          ["class_study", record.classStudyStatus ?? record.classStudy ?? record.class_study]
        ];
        for (const [metric, raw] of inputs) {
          if (raw === undefined) continue;
          if (String(lesson.lessonType) === "review" && metric === "outline") continue;
          if (req.classPermission !== "counselor" && addDays(due[metric], -6) > today) throw new Error("该指标尚未开放填写");
          const value = raw == null || raw === "" ? null : String(raw);
          if (value && !allowed[metric].includes(value)) throw new Error("考勤状态无效");
          if (metric === "outline" && value === "not_required") throw new Error("只有复习课可以使用不需要");
          const previous = db.prepare("select status from attendance_entries where lesson_roster_id = ? and metric = ?").get(roster.id, metric) as { status: string } | undefined;
          if ((previous?.status ?? null) === value) continue;
          audit.run(lessonId, roster.id, metric, previous?.status ?? null, value, req.user!.id);
          if (value === null) remove.run(roster.id, metric); else upsert.run(lessonId, roster.id, metric, value, req.user!.id);
        }
      }
      db.exec("commit"); res.json({ ok: true });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.get("/classes/:classId/reports", requireAuth, requireClassReportAccess(db), (req, res) => {
    const selection = reportSelection(req);
    res.json(buildClassReport(db, numberParam(req.params.classId), selection.range, undefined, selection.customRange));
  });

  router.get("/classes/:classId/export.csv", requireAuth, requireClassAccess(db, true), (req, res) => {
    const selection = reportSelection(req);
    const report = buildClassReport(db, numberParam(req.params.classId), selection.range, undefined, selection.customRange);
    sendCsv(res, reportFilename(report, "csv"), buildCsvExportRows(report));
  });

  router.get("/classes/:classId/export.xlsx", requireAuth, requireClassAccess(db, true), async (req, res) => {
    const selection = reportSelection(req);
    const report = buildClassReport(db, numberParam(req.params.classId), selection.range, undefined, selection.customRange);
    const workbook = new ExcelJS.Workbook(); workbook.creator = "班级共修管理系统";
    const summary = workbook.addWorksheet("班级汇总");
    summary.columns = [{ header: "班级", key: "className", width: 22 }, { header: "统计范围", key: "rangeLabel", width: 28 }, { header: "指标", key: "metric", width: 20 }, { header: "完成", key: "completed", width: 12 },
      { header: "已登记适用", key: "applicable", width: 14 }, { header: "待登记", key: "pending", width: 12 }, { header: "完成率", key: "rate", width: 12 }];
    summary.addRows(Object.entries(report.classSummary).map(([metric, value]) => ({ className: report.class.name, rangeLabel: report.rangeLabel, metric: METRIC_NAMES[metric], ...(value as Record<string, unknown>),
      rate: (value as { rate: number | null }).rate == null ? "不适用" : `${(value as { rate: number }).rate}%` })));
    const group = workbook.addWorksheet("小组汇总");
    group.columns = [{ header: "班级", key: "className", width: 22 }, { header: "统计范围", key: "rangeLabel", width: 28 }, { header: "小组", key: "groupName", width: 16 },
      { header: "指标", key: "metric", width: 18 }, { header: "完成", key: "completed", width: 12 },
      { header: "已登记适用", key: "applicable", width: 14 }, { header: "待登记", key: "pending", width: 12 },
      { header: "完成率", key: "rate", width: 12 }];
    group.addRows(report.groupSummaries.flatMap((item) => Object.entries(item.metrics).map(([metric, value]) => ({
      className: report.class.name, rangeLabel: report.rangeLabel, groupName: item.groupName, metric: METRIC_NAMES[metric], completed: value.completed,
      applicable: value.applicable, pending: value.pending, rate: value.rate == null ? "不适用" : `${value.rate}%`
    }))));
    const personal = workbook.addWorksheet("个人统计");
    personal.columns = [{ header: "班级", key: "className", width: 22 }, { header: "统计范围", key: "rangeLabel", width: 28 }, { header: "组别", key: "groupName", width: 14 }, { header: "姓名", key: "name", width: 18 },
      { header: "法名", key: "dharmaName", width: 16 },
      { header: "导图/提纲", key: "outline", width: 14 }, { header: "组修", key: "group", width: 14 }, { header: "班修", key: "classStudy", width: 14 }];
    personal.addRows(report.personalStats.map((row) => ({ className: report.class.name, rangeLabel: report.rangeLabel, groupName: row.groupName, name: row.name, dharmaName: row.dharmaName,
      outline: row.metrics.outline.rate == null ? "不适用" : `${row.metrics.outline.rate}%`,
      group: row.metrics.group_study.rate == null ? "不适用" : `${row.metrics.group_study.rate}%`,
      classStudy: row.metrics.class_study.rate == null ? "不适用" : `${row.metrics.class_study.rate}%` })));
    const detail = workbook.addWorksheet("逐课明细");
    detail.columns = [{ header: "班级", key: "className", width: 22 }, { header: "统计范围", key: "rangeLabel", width: 28 }, { header: "小组", key: "groupName", width: 16 },
      { header: "姓名", key: "studentName", width: 18 }, { header: "法名", key: "dharmaName", width: 16 },
      { header: "课次", key: "lessonSequence", width: 10 }, { header: "课名", key: "lessonTitle", width: 22 },
      { header: "指标", key: "metricName", width: 18 }, { header: "应完成日期", key: "dueDate", width: 15 },
      { header: "状态", key: "statusName", width: 14 }];
    detail.addRows(report.details.map((row) => ({ ...row, rangeLabel: report.rangeLabel, metricName: METRIC_NAMES[String(row.metric)],
      statusName: row.status == null ? "待登记" : STATUS_NAMES[String(row.status)] })));
    const attention = workbook.addWorksheet("需关注名单");
    attention.columns = [{ header: "班级", key: "className", width: 22 }, { header: "统计范围", key: "rangeLabel", width: 28 }, { header: "小组", key: "groupName", width: 16 },
      { header: "姓名", key: "name", width: 18 }, { header: "原因", key: "reasons", width: 60 }];
    attention.addRows(report.attention.map((row) => ({ className: report.class.name, rangeLabel: report.rangeLabel, groupName: row.groupName,
      name: row.name, reasons: row.reasons.join("；") })));
    workbook.worksheets.forEach((sheet) => { sheet.getRow(1).font = { bold: true }; });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${reportFilename(report, "xlsx")}"`);
    await workbook.xlsx.write(res); res.end();
  });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const publicError = classifyHttpError(error);
    const requestId = (_req as AuthedRequest).requestId ?? randomUUID();
    if (publicError.internal) logError("unhandled_api_error", error, {
      requestId, method: _req.method, path: _req.originalUrl.split("?", 1)[0], userId: (_req as AuthedRequest).user?.id ?? null,
    });
    if (publicError.internal) safelyRecordAuditEvent(db, {
      eventType: "server_error",
      requestId,
      userId: (_req as AuthedRequest).user?.id,
      classId: Number.isInteger(Number(_req.params.classId)) ? Number(_req.params.classId) : null,
      outcome: "failure",
      httpStatus: publicError.status,
      method: _req.method,
      path: _req.originalUrl.split("?", 1)[0],
      clientIp: (_req as AuthedRequest).clientIp,
      details: { errorCode: publicError.code ?? null },
    });
    const body: Record<string, string> = { error: publicError.message };
    if (publicError.code) body.code = publicError.code;
    if (publicError.internal) body.requestId = requestId;
    res.status(publicError.status).json(body);
  });
  return router;
}

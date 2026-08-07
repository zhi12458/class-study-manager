import cookieParser from "cookie-parser";
import ExcelJS from "exceljs";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import {
  CADENCE_MODES, CLASS_STUDY_STATUSES, GROUP_STUDY_STATUSES, LESSON_TYPES,
  OUTLINE_STATUSES, REPORT_RANGES, type AttendanceStatus, type CadenceMode,
  type Metric, type ReportRange
} from "../shared/types.js";
import { normalizePhone } from "../shared/phone.js";
import { type AuthedRequest, requireAdmin, requireAuth, requireClassAccess } from "./access.js";
import {
  createPasswordHash, createSession, deleteSession, generateTemporaryPassword,
  listClassAccesses, loadSessionUser, verifyPassword
} from "./auth.js";
import { addScheduleBreak, appendLessons, createClass, patchLesson, setInitialSchedule, updateFutureCadence } from "./services/classes.js";
import { classifyRosterRows, parseRosterWorkbook, type ImportRow } from "./services/importRoster.js";
import { buildClassReport } from "./services/reportBuilder.js";
import {
  assertPersonAvailableForEnrollment, freezeLessonRoster, getNextEffectiveSequence,
  freezeStartedLessons, lessonStartDate, setEnrollmentGroupFromSequence, shanghaiToday
} from "./services/roster.js";
import { isMonitorLocked } from "./services/schedule.js";

const COOKIE = "class_study_session";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function numberParam(value: unknown, label = "ID"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label}无效`);
  return parsed;
}

function validDate(value: unknown): string {
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(value);
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error("日期无效");
  }
  return date;
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
  yes: "是", no: "否", not_required: "不需要", present: "出勤", absent: "缺勤",
  onsite: "现场", online: "网络", makeup: "补课", share: "分享"
};

function buildCsvExportRows(report: ReturnType<typeof buildClassReport>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const base = (recordType: string) => ({
    "记录类型": recordType, "班级": report.class.name, "时间范围": report.range,
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

function listClasses(db: DatabaseSync, userId: number, isAdmin: boolean, canCounsel: boolean) {
  const where = isAdmin ? "1 = 1" : "(? = 1 and c.counselor_user_id = ?) or (m.user_id = ? and c.archived = 0)";
  const params: SQLInputValue[] = isAdmin ? [] : [canCounsel ? 1 : 0, userId, userId];
  return db.prepare(
    `select c.id, c.name, c.cadence_mode as cadenceMode, c.archived,
            c.counselor_user_id as counselorId, cu.display_name as counselorName,
            m.enrollment_id as monitorId, mp.name as monitorName,
            (select count(*) from groups g where g.class_id = c.id and g.active = 1) as groupCount,
            (select count(*) from enrollments e where e.class_id = c.id and e.inactive_from_sequence is null) as studentCount,
            case when ? = 1 and c.counselor_user_id = ? then 'counselor' when m.user_id = ? then 'monitor' else 'admin' end as permission
       from classes c
       join users cu on cu.id = c.counselor_user_id
       left join class_monitors m on m.class_id = c.id
       left join enrollments me on me.id = m.enrollment_id
       left join persons mp on mp.id = me.person_id
      where ${where}
      order by c.archived, c.id desc`
  ).all(canCounsel ? 1 : 0, userId, userId, ...params);
}

function deactivateRolelessUser(db: DatabaseSync, userId: number): void {
  const user = db.prepare("select is_admin as isAdmin, can_counsel as canCounsel from users where id = ?").get(userId) as
    | { isAdmin: number; canCounsel: number }
    | undefined;
  if (!user || user.isAdmin || user.canCounsel) return;
  const hasMonitorAccess = db.prepare(
    "select 1 from class_monitors m join classes c on c.id = m.class_id where m.user_id = ? and c.archived = 0 limit 1"
  ).get(userId);
  if (hasMonitorAccess) return;
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

function createOrUpdatePerson(db: DatabaseSync, input: { name: string; dharmaName?: string | null; phone: string }) {
  const phone = normalizePhone(input.phone);
  const existing = db.prepare("select id from persons where phone = ?").get(phone) as { id: number } | undefined;
  if (existing) {
    if (input.dharmaName === undefined) {
      db.prepare("update persons set name = ?, updated_at = current_timestamp where id = ?")
        .run(input.name.trim(), existing.id);
    } else {
      db.prepare("update persons set name = ?, dharma_name = ?, updated_at = current_timestamp where id = ?")
        .run(input.name.trim(), input.dharmaName?.trim() || null, existing.id);
    }
    db.prepare("update users set display_name = ?, updated_at = current_timestamp where person_id = ?")
      .run(input.name.trim(), existing.id);
    return { personId: existing.id, phone, existing: true };
  }
  const result = db.prepare("insert into persons (name, dharma_name, phone) values (?, ?, ?)")
    .run(input.name.trim(), input.dharmaName?.trim() || null, phone);
  return { personId: Number(result.lastInsertRowid), phone, existing: false };
}

function insertEnrollment(db: DatabaseSync, input: {
  classId: number; personId: number; groupId: number; note?: string | null; effectiveSequence: number;
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
  return enrollmentId;
}

export function createApiRouter(db: DatabaseSync) {
  const router = express.Router();
  router.use(cookieParser());
  router.use(express.json({ limit: "4mb" }));
  router.use(loadUser(db));

  router.get("/health", (_req, res) => res.json({ ok: true, service: "class-study-manager" }));

  router.post("/auth/login", (req, res) => {
    const identifier = String(req.body.identifier ?? req.body.username ?? req.body.phone ?? "").trim();
    const password = String(req.body.password ?? "");
    if (!identifier || !password) return void res.status(400).json({ error: "请输入账号和密码" });
    let normalized = identifier;
    if (identifier !== "admin" && !identifier.startsWith("admin")) {
      try { normalized = normalizePhone(identifier); } catch { /* custom admin name remains usable */ }
    }
    const user = db.prepare("select id, password_hash as passwordHash from users where username = ? and active = 1")
      .get(normalized) as { id: number; passwordHash: string } | undefined;
    if (!user || !verifyPassword(password, user.passwordHash)) return void res.status(401).json({ error: "账号或密码不正确" });
    const token = createSession(db, user.id);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: process.env.COOKIE_SECURE === "true", maxAge: 7 * 86_400_000 });
    res.json({ ok: true });
  });

  router.get("/auth/me", (req: AuthedRequest, res) => {
    if (!req.user) return void res.json({ user: null, classAccesses: [] });
    res.json({ user: req.user, classAccesses: listClassAccesses(db, req.user) });
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
      `select u.id, u.person_id as personId, u.display_name as displayName, p.phone,
              u.can_counsel as active, u.active as accountActive,
              (select count(*) from classes c where c.counselor_user_id = u.id and c.archived = 0) as activeClassCount,
              (select count(*) from classes c where c.counselor_user_id = u.id and c.archived = 1) as archivedClassCount,
              (select count(*) from class_monitors m join classes c on c.id = m.class_id where m.user_id = u.id and c.archived = 0) as monitorClassCount,
              case when
                not exists (select 1 from classes c where c.counselor_user_id = u.id or c.created_by = u.id)
                and not exists (select 1 from schedule_breaks b where b.created_by = u.id)
                and not exists (select 1 from attendance_entries a where a.modified_by = u.id)
                and not exists (select 1 from attendance_audit a where a.modified_by = u.id)
                and not exists (select 1 from class_monitors m where m.user_id = u.id or m.assigned_by = u.id)
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

  router.post("/admin/counselors", requireAdmin, (req: AuthedRequest, res) => {
    const name = String(req.body.displayName ?? req.body.name ?? "").trim();
    if (!name) return void res.status(400).json({ error: "姓名必填" });
    const phone = normalizePhone(String(req.body.phone ?? ""));
    db.exec("begin immediate");
    try {
      const person = createOrUpdatePerson(db, { name, phone });
      const existingUser = db.prepare("select id, can_counsel as canCounsel from users where person_id = ?").get(person.personId) as
        | { id: number; canCounsel: number }
        | undefined;
      let userId: number; let temporaryPassword: string | undefined;
      if (existingUser) {
        userId = existingUser.id;
        db.prepare("update users set counselor_role = 1, can_counsel = 1, active = 1, display_name = ?, username = ?, updated_at = current_timestamp where id = ?")
          .run(name, phone, userId);
      } else {
        temporaryPassword = generateTemporaryPassword();
        const result = db.prepare(
          `insert into users (person_id, username, password_hash, display_name, counselor_role, can_counsel, must_change_password)
           values (?, ?, ?, ?, 1, 1, 1)`
        ).run(person.personId, phone, createPasswordHash(temporaryPassword), name);
        userId = Number(result.lastInsertRowid);
      }
      db.exec("commit");
      res.json({ id: userId, temporaryPassword, phone });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.patch("/admin/counselors/:id", requireAdmin, (req, res) => {
    const id = numberParam(req.params.id, "辅导员账号 ID");
    if (typeof req.body.active !== "boolean") return void res.status(400).json({ error: "请指定启用或停用状态" });
    const counselor = db.prepare(
      "select id, is_admin as isAdmin from users where id = ? and counselor_role = 1"
    ).get(id) as { id: number; isAdmin: number } | undefined;
    if (!counselor || counselor.isAdmin) return void res.status(404).json({ error: "辅导员账号不存在" });

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
    db.exec("begin immediate");
    try {
      db.prepare("update users set can_counsel = 0, active = ?, updated_at = current_timestamp where id = ?").run(isMonitor ? 1 : 0, id);
      if (!isMonitor) db.prepare("delete from sessions_auth where user_id = ?").run(id);
      db.exec("commit");
      res.json({ ok: true, active: false, accountActive: isMonitor });
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
        (select count(*) from class_counselor_history h where h.counselor_user_id = ? or h.assigned_by = ?) +
        (select count(*) from enrollments e where e.person_id = ?) as count`
    ).get(id, id, id, id, id, id, id, id, id, counselor.personId) as { count: number };
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
      firstDueDate: req.body.firstDueDate ? validDate(req.body.firstDueDate) : undefined,
      lessonCount: req.body.lessonCount ? Number(req.body.lessonCount) : 24
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
             join enrollments oe on oe.person_id = e.person_id and oe.class_id != e.class_id and oe.inactive_from_sequence is null
             join classes other on other.id = oe.class_id and other.archived = 0
            where e.class_id = ? and e.inactive_from_sequence is null limit 1`
        ).get(classId) as { name: string; otherClassName: string } | undefined;
        if (conflict) throw new Error(`无法恢复班级：学员“${conflict.name}”已在“${conflict.otherClassName}”就读`);
      }
      if (name !== undefined) db.prepare("update classes set name = ?, updated_at = current_timestamp where id = ?").run(name, classId);
      if (counselorId !== undefined && counselorId !== classState.counselorId) {
        db.prepare("update class_counselor_history set ended_at = current_timestamp where class_id = ? and ended_at is null").run(classId);
        db.prepare("insert into class_counselor_history (class_id, counselor_user_id, assigned_by) values (?, ?, ?)")
          .run(classId, counselorId, req.user!.id);
        db.prepare("update classes set counselor_user_id = ?, updated_at = current_timestamp where id = ?").run(counselorId, classId);
      }
      if (modeChanged) updateFutureCadence(db, classId, mode, { manageTransaction: false, freezeStarted: false });
      if (req.body.archived !== undefined) {
        db.prepare("update classes set archived = ?, updated_at = current_timestamp where id = ?").run(req.body.archived ? 1 : 0, classId);
        if (req.body.archived === true) db.prepare("delete from class_monitors where class_id = ?").run(classId);
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
              `select 1 from group_assignments ga join enrollments e on e.id = ga.enrollment_id
                where ga.group_id = ? and ga.effective_to_sequence is null and e.inactive_from_sequence is null limit 1`
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

  router.get("/classes/:classId/groups", requireAuth, requireClassAccess(db), (req, res) => {
    const classId = numberParam(req.params.classId);
    const groups = db.prepare(
      `select g.id, g.name, g.sort_order as sortOrder, g.active,
        (select count(*) from group_assignments ga join enrollments e on e.id = ga.enrollment_id
          where ga.group_id = g.id and ga.effective_to_sequence is null and e.inactive_from_sequence is null) as studentCount
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
        `select 1 from group_assignments ga join enrollments e on e.id = ga.enrollment_id
          where ga.group_id = ? and ga.effective_to_sequence is null and e.inactive_from_sequence is null limit 1`
      ).get(groupId);
      if (assigned) return void res.status(400).json({ error: "请先把该组学员转入其他小组" });
      db.prepare("update groups set active = 0, archived_at = current_timestamp where id = ?").run(groupId);
    }
    res.json({ ok: true });
  });

  router.get("/classes/:classId/students", requireAuth, requireClassAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId);
    const students = db.prepare(
      `select e.id, e.id as studentId, e.person_id as personId, p.name, p.dharma_name as dharmaName,
              p.phone, e.note, g.id as groupId, g.name as groupName,
              case when e.inactive_from_sequence is null then 1 else 0 end as active,
              e.active_from_sequence as activeFromSequence, e.inactive_from_sequence as inactiveFromSequence
         from enrollments e join persons p on p.id = e.person_id
         left join group_assignments ga on ga.enrollment_id = e.id and ga.effective_to_sequence is null
         left join groups g on g.id = ga.group_id
        where e.class_id = ? order by active desc, g.sort_order, p.name`
    ).all(classId).map((row) => ({ ...(row as Record<string, unknown>), active: Boolean((row as Record<string, unknown>).active) }));
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
    const name = String(req.body.name ?? "").trim(); if (!name) return void res.status(400).json({ error: "姓名必填" });
    const groupId = numberParam(req.body.groupId, "小组");
    if (!db.prepare("select 1 from groups where id = ? and class_id = ? and active = 1").get(groupId, classId)) return void res.status(400).json({ error: "小组无效" });
    const effectiveSequence = getNextEffectiveSequence(db, classId);
    db.exec("begin immediate");
    try {
      const person = createOrUpdatePerson(db, { name, dharmaName: req.body.dharmaName, phone: String(req.body.phone ?? "") });
      const id = insertEnrollment(db, { classId, personId: person.personId, groupId, note: req.body.note, effectiveSequence });
      db.exec("commit"); res.json({ id, studentId: id, effectiveSequence });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.patch("/classes/:classId/students/:studentId", requireAuth, requireClassAccess(db, true), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId); const enrollmentId = numberParam(req.params.studentId, "学员 ID");
    const row = db.prepare(
      `select e.person_id as personId, e.active_from_sequence as activeFromSequence,
              e.inactive_from_sequence as inactiveFromSequence, p.phone,
              (select id from users where person_id = e.person_id) as userId
         from enrollments e join persons p on p.id = e.person_id where e.id = ? and e.class_id = ?`
    ).get(enrollmentId, classId) as { personId: number; activeFromSequence: number; inactiveFromSequence: number | null; phone: string; userId: number | null } | undefined;
    if (!row) return void res.status(404).json({ error: "学员不存在" });
    if (req.body.active === false && row.inactiveFromSequence === null &&
      db.prepare("select 1 from class_monitors where class_id = ? and enrollment_id = ?").get(classId, enrollmentId)) {
      return void res.status(400).json({ error: "该学员当前是班长，请先更换或取消班长后再停用" });
    }
    const effectiveSequence = getNextEffectiveSequence(db, classId);
    db.exec("begin immediate");
    try {
      if (req.body.name !== undefined || req.body.dharmaName !== undefined || req.body.phone !== undefined) {
        const current = db.prepare("select name, dharma_name as dharmaName, phone from persons where id = ?").get(row.personId) as Record<string, unknown>;
        const phone = req.body.phone === undefined ? String(current.phone) : normalizePhone(String(req.body.phone));
        if (phone !== row.phone && row.userId && !req.user!.isAdmin) throw new Error("该手机号已绑定登录账号，请联系管理员修改");
        const dharmaName = req.body.dharmaName === undefined
          ? (current.dharmaName == null ? null : String(current.dharmaName))
          : String(req.body.dharmaName || "").trim() || null;
        const updatedName = String(req.body.name ?? current.name).trim();
        if (!updatedName) throw new Error("姓名必填");
        db.prepare("update persons set name = ?, dharma_name = ?, phone = ?, updated_at = current_timestamp where id = ?")
          .run(updatedName, dharmaName, phone, row.personId);
        if (row.userId && phone !== row.phone) db.prepare("update users set username = ?, display_name = ?, updated_at = current_timestamp where id = ?")
          .run(phone, updatedName, row.userId);
        else if (row.userId) db.prepare("update users set display_name = ?, updated_at = current_timestamp where id = ?").run(updatedName, row.userId);
      }
      if (req.body.note !== undefined) db.prepare("update enrollments set note = ?, updated_at = current_timestamp where id = ?")
        .run(String(req.body.note || "").trim() || null, enrollmentId);
      if (req.body.groupId !== undefined) {
        const groupId = numberParam(req.body.groupId, "小组");
        if (!db.prepare("select 1 from groups where id = ? and class_id = ? and active = 1").get(groupId, classId)) throw new Error("小组无效");
        setEnrollmentGroupFromSequence(db, enrollmentId, groupId, effectiveSequence);
      }
      if (req.body.active === false && row.inactiveFromSequence === null) {
        const hasHistory = db.prepare("select 1 from lesson_roster where enrollment_id = ? limit 1").get(enrollmentId);
        if (!hasHistory && effectiveSequence <= row.activeFromSequence) {
          db.prepare("delete from enrollments where id = ?").run(enrollmentId);
        } else {
          db.prepare("update enrollments set inactive_from_sequence = ?, updated_at = current_timestamp where id = ?")
            .run(Math.max(effectiveSequence, row.activeFromSequence + 1), enrollmentId);
        }
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
      { header: "备注", key: "note", width: 30 }
    ];
    roster.getRow(1).font = { bold: true };
    roster.getColumn("phone").numFmt = "@";
    const groupValidation = {
      type: "list" as const,
      allowBlank: false,
      formulae: [`"${groups.map((group) => group.name.replaceAll('"', '""')).join(",")}"`]
    };
    for (let row = 2; row <= 1000; row += 1) roster.getCell(`D${row}`).dataValidation = groupValidation;
    const instructions = workbook.addWorksheet("填写说明");
    instructions.columns = [{ width: 24 }, { width: 72 }];
    instructions.addRows([
      ["班级", classRow.name],
      ["必填列", "姓名、电话、小组"],
      ["选填列", "法名、备注"],
      ["电话格式", "可填写中国大陆手机号；未写国家区号时默认按 +86 处理。"],
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
        const person = createOrUpdatePerson(db, item);
        const existing = db.prepare("select id from enrollments where class_id = ? and person_id = ?").get(classId, person.personId) as { id: number } | undefined;
        if (existing) {
          db.prepare("update enrollments set note = ?, updated_at = current_timestamp where id = ?").run(item.note, existing.id);
          setEnrollmentGroupFromSequence(db, existing.id, groupId, effectiveSequence);
        } else {
          insertEnrollment(db, { classId, personId: person.personId, groupId, note: item.note, effectiveSequence });
        }
        importedCount += 1;
      }
      db.exec("commit"); res.json({ importedCount, effectiveSequence });
    } catch (error) { db.exec("rollback"); throw error; }
  });

  router.get("/classes/:classId/lessons", requireAuth, requireClassAccess(db), (req, res) => {
    const classId = numberParam(req.params.classId); const today = shanghaiToday();
    const lessons = (db.prepare(
      `select id, sequence, sequence as lessonNumber, title, lesson_type as lessonType, cadence_mode as cadenceMode,
              outline_due_date as outlineDueDate, group_study_due_date as groupStudyDueDate,
              class_study_due_date as classStudyDueDate, roster_frozen_at as frozenAt
         from lessons where class_id = ? order by sequence`
    ).all(classId) as Array<Record<string, unknown>>).map((lesson) => {
      const start = addDays(String(lesson.outlineDueDate), -6); const final = String(lesson.classStudyDueDate);
      return { ...lesson, started: start <= today, lockedForMonitor: isMonitorLocked(final, today),
        status: start > today ? "future" : final >= today ? "current" : "finished" };
    });
    const breaks = db.prepare("select id, start_date as date, start_date as startDate, weeks, reason from schedule_breaks where class_id = ? order by start_date").all(classId);
    res.json({ lessons, breaks });
  });

  router.post("/classes/:classId/schedule/generate", requireAuth, requireClassAccess(db, true), (req, res) => {
    const classId = numberParam(req.params.classId);
    const firstDueDate = req.body.firstDueDate ?? req.body.firstClassStudyDueDate;
    const cadenceMode = req.body.cadenceMode === undefined ? undefined : String(req.body.cadenceMode) as CadenceMode;
    if (cadenceMode !== undefined && !CADENCE_MODES.includes(cadenceMode)) return void res.status(400).json({ error: "学习模式无效" });
    setInitialSchedule(db, classId, validDate(firstDueDate), Number(req.body.count ?? 24), cadenceMode);
    res.json({ generatedCount: Number(req.body.count ?? 24) });
  });

  router.post("/classes/:classId/lessons/append", requireAuth, requireClassAccess(db, true), (req, res) => {
    const classId = numberParam(req.params.classId); const generatedCount = appendLessons(db, classId, Number(req.body.count ?? 24));
    res.json({ generatedCount });
  });

  router.patch("/classes/:classId/lessons/:lessonId", requireAuth, requireClassAccess(db, true), (req, res) => {
    const classId = numberParam(req.params.classId); const lessonId = numberParam(req.params.lessonId);
    const lessonType = req.body.lessonType === undefined ? undefined : String(req.body.lessonType);
    if (lessonType && !LESSON_TYPES.includes(lessonType as typeof LESSON_TYPES[number])) return void res.status(400).json({ error: "课次类型无效" });
    patchLesson(db, classId, lessonId, { title: req.body.title, lessonType: lessonType as typeof LESSON_TYPES[number] | undefined,
      classStudyDueDate: req.body.classStudyDueDate ? validDate(req.body.classStudyDueDate) : undefined });
    res.json({ ok: true });
  });

  router.post("/classes/:classId/breaks", requireAuth, requireClassAccess(db, true), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId);
    addScheduleBreak(db, classId, validDate(req.body.startDate ?? req.body.date), Number(req.body.weeks ?? 1), String(req.body.reason ?? "放假/暂停"), req.user!.id);
    res.json({ ok: true });
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
    const classRow = db.prepare("select archived from classes where id = ?").get(classId) as { archived: number };
    if (classRow.archived) return void res.status(400).json({ error: "已归档班级不能设置班长" });
    const enrollmentId = numberParam(req.body.studentId ?? req.body.enrollmentId, "学员");
    const student = db.prepare(
      `select e.id, e.person_id as personId, p.name, p.phone from enrollments e join persons p on p.id = e.person_id
        where e.id = ? and e.class_id = ? and e.inactive_from_sequence is null`
    ).get(enrollmentId, classId) as { id: number; personId: number; name: string; phone: string } | undefined;
    if (!student) return void res.status(400).json({ error: "班长必须从本班在册学员中选择" });
    db.exec("begin immediate");
    try {
      const previous = db.prepare("select user_id as userId from class_monitors where class_id = ?").get(classId) as { userId: number } | undefined;
      let user = db.prepare("select id from users where person_id = ?").get(student.personId) as { id: number } | undefined;
      let temporaryPassword: string | undefined;
      if (!user) {
        temporaryPassword = generateTemporaryPassword();
        const result = db.prepare(
          `insert into users (person_id, username, password_hash, display_name, must_change_password) values (?, ?, ?, ?, 1)`
        ).run(student.personId, student.phone, createPasswordHash(temporaryPassword), student.name);
        user = { id: Number(result.lastInsertRowid) };
      }
      db.prepare("update users set active = 1, updated_at = current_timestamp where id = ?").run(user.id);
      db.prepare(
        "delete from class_monitors where user_id = ? and class_id in (select id from classes where archived = 1)"
      ).run(user.id);
      const other = db.prepare(
        `select m.class_id as classId from class_monitors m join classes c on c.id = m.class_id
          where m.user_id = ? and m.class_id != ? and c.archived = 0`
      ).get(user.id, classId) as { classId: number } | undefined;
      if (other) throw new Error("该账号已经是其他班级的班长");
      db.prepare("delete from class_monitors where class_id = ?").run(classId);
      db.prepare("insert into class_monitors (class_id, enrollment_id, user_id, assigned_by) values (?, ?, ?, ?)")
        .run(classId, enrollmentId, user.id, req.user!.id);
      if (previous && previous.userId !== user.id) deactivateRolelessUser(db, previous.userId);
      db.exec("commit"); res.json({ ok: true, userId: user.id, temporaryPassword, phone: student.phone });
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

  router.get("/classes/:classId/attendance/:lessonId", requireAuth, requireClassAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId); const lessonId = numberParam(req.params.lessonId); const today = shanghaiToday();
    const lesson = getLesson(db, classId, lessonId); if (!lesson) return void res.status(404).json({ error: "课次不存在" });
    const courseStart = addDays(String(lesson.outlineDueDate), -6);
    if (courseStart <= today) freezeLessonRoster(db, lessonId);
    const rows = db.prepare(
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
    ).all(lessonId);
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
    res.json({ lesson: { ...lesson, lockedForMonitor: locked }, rows, records: rows, history, canEdit, lockedForMonitor: locked, openMetrics,
      statuses: { outline: OUTLINE_STATUSES, groupStudy: GROUP_STUDY_STATUSES, classStudy: CLASS_STUDY_STATUSES } });
  });

  router.put("/classes/:classId/attendance/:lessonId", requireAuth, requireClassAccess(db), (req: AuthedRequest, res) => {
    const classId = numberParam(req.params.classId); const lessonId = numberParam(req.params.lessonId); const today = shanghaiToday();
    const lesson = getLesson(db, classId, lessonId); if (!lesson) return void res.status(404).json({ error: "课次不存在" });
    if (addDays(String(lesson.outlineDueDate), -6) > today) return void res.status(400).json({ error: "该课尚未开始" });
    freezeLessonRoster(db, lessonId);
    if (req.classPermission === "monitor" && isMonitorLocked(String(lesson.classStudyDueDate), today)) return void res.status(403).json({ error: "该课已超过14天修改期" });
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
          if (req.classPermission === "monitor" && addDays(due[metric], -6) > today) throw new Error("该指标尚未开放填写");
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

  router.get("/classes/:classId/reports", requireAuth, requireClassAccess(db), (req, res) => {
    const range = String(req.query.range ?? "recent") as ReportRange;
    if (!REPORT_RANGES.includes(range)) return void res.status(400).json({ error: "时间范围无效" });
    res.json(buildClassReport(db, numberParam(req.params.classId), range));
  });

  router.get("/classes/:classId/export.csv", requireAuth, requireClassAccess(db, true), (req, res) => {
    const range = String(req.query.range ?? "recent") as ReportRange;
    if (!REPORT_RANGES.includes(range)) return void res.status(400).json({ error: "时间范围无效" });
    const report = buildClassReport(db, numberParam(req.params.classId), range);
    sendCsv(res, "class-study-report.csv", buildCsvExportRows(report));
  });

  router.get("/classes/:classId/export.xlsx", requireAuth, requireClassAccess(db, true), async (req, res) => {
    const range = String(req.query.range ?? "recent") as ReportRange;
    if (!REPORT_RANGES.includes(range)) return void res.status(400).json({ error: "时间范围无效" });
    const report = buildClassReport(db, numberParam(req.params.classId), range);
    const workbook = new ExcelJS.Workbook(); workbook.creator = "班级共修管理系统";
    const summary = workbook.addWorksheet("班级汇总");
    summary.columns = [{ header: "班级", key: "className", width: 22 }, { header: "指标", key: "metric", width: 20 }, { header: "完成", key: "completed", width: 12 },
      { header: "已登记适用", key: "applicable", width: 14 }, { header: "待登记", key: "pending", width: 12 }, { header: "完成率", key: "rate", width: 12 }];
    summary.addRows(Object.entries(report.classSummary).map(([metric, value]) => ({ className: report.class.name, metric: METRIC_NAMES[metric], ...(value as Record<string, unknown>),
      rate: (value as { rate: number | null }).rate == null ? "不适用" : `${(value as { rate: number }).rate}%` })));
    const group = workbook.addWorksheet("小组汇总");
    group.columns = [{ header: "班级", key: "className", width: 22 }, { header: "小组", key: "groupName", width: 16 },
      { header: "指标", key: "metric", width: 18 }, { header: "完成", key: "completed", width: 12 },
      { header: "已登记适用", key: "applicable", width: 14 }, { header: "待登记", key: "pending", width: 12 },
      { header: "完成率", key: "rate", width: 12 }];
    group.addRows(report.groupSummaries.flatMap((item) => Object.entries(item.metrics).map(([metric, value]) => ({
      className: report.class.name, groupName: item.groupName, metric: METRIC_NAMES[metric], completed: value.completed,
      applicable: value.applicable, pending: value.pending, rate: value.rate == null ? "不适用" : `${value.rate}%`
    }))));
    const personal = workbook.addWorksheet("个人统计");
    personal.columns = [{ header: "班级", key: "className", width: 22 }, { header: "组别", key: "groupName", width: 14 }, { header: "姓名", key: "name", width: 18 },
      { header: "法名", key: "dharmaName", width: 16 },
      { header: "导图/提纲", key: "outline", width: 14 }, { header: "组修", key: "group", width: 14 }, { header: "班修", key: "classStudy", width: 14 }];
    personal.addRows(report.personalStats.map((row) => ({ className: report.class.name, groupName: row.groupName, name: row.name, dharmaName: row.dharmaName,
      outline: row.metrics.outline.rate == null ? "不适用" : `${row.metrics.outline.rate}%`,
      group: row.metrics.group_study.rate == null ? "不适用" : `${row.metrics.group_study.rate}%`,
      classStudy: row.metrics.class_study.rate == null ? "不适用" : `${row.metrics.class_study.rate}%` })));
    const detail = workbook.addWorksheet("逐课明细");
    detail.columns = [{ header: "班级", key: "className", width: 22 }, { header: "小组", key: "groupName", width: 16 },
      { header: "姓名", key: "studentName", width: 18 }, { header: "法名", key: "dharmaName", width: 16 },
      { header: "课次", key: "lessonSequence", width: 10 }, { header: "课名", key: "lessonTitle", width: 22 },
      { header: "指标", key: "metricName", width: 18 }, { header: "应完成日期", key: "dueDate", width: 15 },
      { header: "状态", key: "statusName", width: 14 }];
    detail.addRows(report.details.map((row) => ({ ...row, metricName: METRIC_NAMES[String(row.metric)],
      statusName: row.status == null ? "待登记" : STATUS_NAMES[String(row.status)] })));
    const attention = workbook.addWorksheet("需关注名单");
    attention.columns = [{ header: "班级", key: "className", width: 22 }, { header: "小组", key: "groupName", width: 16 },
      { header: "姓名", key: "name", width: 18 }, { header: "原因", key: "reasons", width: 60 }];
    attention.addRows(report.attention.map((row) => ({ className: report.class.name, groupName: row.groupName,
      name: row.name, reasons: row.reasons.join("；") })));
    workbook.worksheets.forEach((sheet) => { sheet.getRow(1).font = { bold: true }; });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="class-study-report.xlsx"');
    await workbook.xlsx.write(res); res.end();
  });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "服务器错误";
    console.error(error);
    const conflict = /unique|已存在|重复/i.test(message);
    res.status(conflict ? 409 : 400).json({ error: message });
  });
  return router;
}

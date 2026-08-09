import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { AttendanceFact, Metric, MetricRate, ReportRange } from "../../shared/types.js";
import { buildReportSummary, detectClassStudyRisk } from "./reports.js";
import { freezeStartedLessons, shanghaiToday } from "./roster.js";

export interface CustomReportRange {
  from: string;
  to: string;
}

function monthStart(today: string): string { return `${today.slice(0, 7)}-01`; }

function subtractMonths(value: string, months: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString().slice(0, 10);
}

function metricSummary(rate: MetricRate) {
  return { completed: rate.completed, applicable: rate.recorded, recorded: rate.recorded, pending: rate.pending,
    notRequired: rate.notRequired, rate: rate.rate };
}

function rangeDates(
  db: DatabaseSync,
  classId: number,
  range: ReportRange,
  today: string,
  customRange?: CustomReportRange,
) {
  if (range === "month") return { from: monthStart(today), to: today, lessonId: null as number | null };
  if (range === "three_months") return { from: subtractMonths(today, 3), to: today, lessonId: null as number | null };
  if (range === "history") {
    const first = db.prepare(
      `select min(outline_due_date) as outlineDate, min(group_study_due_date) as groupDate,
              min(class_study_due_date) as classDate from lessons where class_id = ?`
    ).get(classId) as { outlineDate: string | null; groupDate: string | null; classDate: string | null };
    const from = [first.outlineDate, first.groupDate, first.classDate].filter((value): value is string => Boolean(value)).sort()[0] ?? today;
    return { from, to: today, lessonId: null as number | null };
  }
  if (range === "custom") {
    if (!customRange) throw new Error("自定义统计必须提供开始和结束日期");
    return { ...customRange, lessonId: null as number | null };
  }
  const lessons = db.prepare(
    `select id, outline_due_date as outlineDueDate, class_study_due_date as classStudyDueDate
       from lessons where class_id = ? order by sequence`
  ).all(classId) as Array<{ id: number; outlineDueDate: string; classStudyDueDate: string }>;
  const current = lessons.find((lesson) => {
    const start = new Date(new Date(`${lesson.outlineDueDate}T00:00:00Z`).getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
    return start <= today && lesson.classStudyDueDate >= today;
  });
  const recent = current ?? [...lessons].reverse().find((lesson) => lesson.classStudyDueDate <= today) ?? null;
  if (!recent) return { from: today, to: today, lessonId: -1 };
  return {
    from: [recent.outlineDueDate, recent.classStudyDueDate].sort()[0],
    to: recent.classStudyDueDate < today ? recent.classStudyDueDate : today,
    lessonId: recent.id,
  };
}

function rangeLabel(range: ReportRange, from: string, to: string): string {
  if (range === "recent") return "最近课次";
  if (range === "history") return "完整历史";
  if (range === "month") return `当月（${from} 至 ${to}）`;
  if (range === "three_months") return `最近3个月（${from} 至 ${to}）`;
  return `${from} 至 ${to}`;
}

export function buildClassReport(
  db: DatabaseSync,
  classId: number,
  range: ReportRange,
  today = shanghaiToday(),
  customRange?: CustomReportRange,
) {
  freezeStartedLessons(db, classId, today);
  const classInfo = db.prepare("select id, name from classes where id = ?").get(classId) as { id: number; name: string } | undefined;
  if (!classInfo) throw new Error("班级不存在");
  const selected = rangeDates(db, classId, range, today, customRange);
  const conditions = ["l.class_id = ?"];
  const params: SQLInputValue[] = [classId];
  if (selected.lessonId !== null) { conditions.push("l.id = ?"); params.push(selected.lessonId); }

  const rows = db.prepare(
    `select lr.enrollment_id as enrollmentId, lr.student_name as studentName, lr.dharma_name as dharmaName,
            lr.group_id as groupId, lr.group_name as groupName,
            l.id as lessonId, l.sequence as lessonSequence, l.title as lessonTitle, l.lesson_type as lessonType,
            l.outline_due_date as outlineDueDate, l.group_study_due_date as groupStudyDueDate,
            l.class_study_due_date as classStudyDueDate,
            ao.status as outlineStatus, ag.status as groupStatus, ac.status as classStatus
       from lessons l
       join lesson_roster lr on lr.lesson_id = l.id
       left join attendance_entries ao on ao.lesson_roster_id = lr.id and ao.metric = 'outline'
       left join attendance_entries ag on ag.lesson_roster_id = lr.id and ag.metric = 'group_study'
       left join attendance_entries ac on ac.lesson_roster_id = lr.id and ac.metric = 'class_study'
      where ${conditions.join(" and ")}
      order by l.sequence, lr.group_id, lr.student_name`
  ).all(...params) as Array<Record<string, unknown>>;

  const facts: AttendanceFact[] = [];
  const details: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const metricData: Array<[Metric, string, unknown]> = [
      ["outline", String(row.outlineDueDate), row.outlineStatus],
      ["group_study", String(row.groupStudyDueDate), row.groupStatus],
      ["class_study", String(row.classStudyDueDate), row.classStatus]
    ];
    for (const [metric, dueDate, status] of metricData) {
      if (dueDate < selected.from || dueDate > selected.to) continue;
      facts.push({
        enrollmentId: Number(row.enrollmentId), studentName: String(row.studentName),
        groupId: Number(row.groupId), groupName: String(row.groupName), lessonId: Number(row.lessonId),
        lessonSequence: Number(row.lessonSequence), metric, dueDate,
        status: status == null ? null : String(status) as AttendanceFact["status"]
      });
      details.push({
        classId: classInfo.id, className: classInfo.name,
        groupId: Number(row.groupId), groupName: String(row.groupName),
        studentId: Number(row.enrollmentId), studentName: String(row.studentName),
        dharmaName: row.dharmaName == null ? null : String(row.dharmaName),
        lessonId: Number(row.lessonId), lessonSequence: Number(row.lessonSequence),
        lessonTitle: String(row.lessonTitle), lessonType: String(row.lessonType),
        metric, dueDate, status: status == null ? null : String(status)
      });
    }
  }
  const summary = buildReportSummary(facts);
  const latestIdentity = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    const id = Number(row.enrollmentId);
    const previous = latestIdentity.get(id);
    if (!previous || Number(row.lessonSequence) >= Number(previous.lessonSequence)) latestIdentity.set(id, row);
  }

  const riskRows = db.prepare(
    `select lr.enrollment_id as enrollmentId, lr.student_name as studentName, lr.group_name as groupName,
            l.class_study_due_date as dueDate, l.sequence as lessonSequence, a.status
       from lessons l join lesson_roster lr on lr.lesson_id = l.id
       left join attendance_entries a on a.lesson_roster_id = lr.id and a.metric = 'class_study'
      where l.class_id = ? and l.class_study_due_date <= ? order by l.sequence`
  ).all(classId, today) as Array<Record<string, unknown>>;
  const byStudent = new Map<number, typeof riskRows>();
  riskRows.forEach((row) => {
    const id = Number(row.enrollmentId); const list = byStudent.get(id) ?? []; list.push(row); byStudent.set(id, list);
  });
  const attention = [...byStudent.entries()].flatMap(([enrollmentId, records]) => {
    const risk = detectClassStudyRisk(records.map((row) => ({
      dueDate: String(row.dueDate), lessonSequence: Number(row.lessonSequence),
      status: row.status == null ? null : String(row.status) as "onsite" | "online" | "makeup" | "share" | "absent"
    })), today);
    return risk.needsAttention ? [{ enrollmentId, studentId: enrollmentId, name: String(records.at(-1)?.studentName),
      groupName: String(records.at(-1)?.groupName), reasons: risk.reasons }] : [];
  });

  const lessons = db.prepare(
    `select id, sequence, sequence as lessonNumber, title, lesson_type as lessonType, cadence_mode as cadenceMode,
      outline_due_date as outlineDueDate, group_study_due_date as groupStudyDueDate,
      class_study_due_date as classStudyDueDate from lessons where class_id = ? order by sequence`
  ).all(classId);

  return {
    range, rangeLabel: rangeLabel(range, selected.from, selected.to), class: { id: classInfo.id, name: classInfo.name },
    classSummary: Object.fromEntries(Object.entries(summary.classSummary).map(([metric, rate]) => [metric, metricSummary(rate)])),
    groupSummaries: summary.groupSummaries.map((group) => ({ ...group,
      metrics: Object.fromEntries(Object.entries(group.metrics).map(([metric, rate]) => [metric, metricSummary(rate)])) })),
    personalStats: summary.personalStats.map((student) => ({ studentId: student.enrollmentId, enrollmentId: student.enrollmentId,
      name: student.studentName, studentName: student.studentName,
      dharmaName: latestIdentity.get(student.enrollmentId)?.dharmaName ?? null, groupName: student.groupName,
      metrics: Object.fromEntries(Object.entries(student.metrics).map(([metric, rate]) => [metric, metricSummary(rate)])) })),
    attention, lessons, details, filters: { from: selected.from, to: selected.to }
  };
}

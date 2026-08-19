import {
  METRICS,
  type AttendanceFact,
  type AttendanceStatus,
  type ClassStudyStatus,
  type Metric,
  type MetricRate,
} from "../../shared/types.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const ALLOWED_STATUSES: Record<Metric, readonly AttendanceStatus[]> = {
  outline: ["yes", "no", "not_required"],
  group_study: ["onsite", "online", "official_duty", "absent", "observer"],
  class_study: ["onsite", "online", "official_duty", "absent", "observer"],
};

const COMPLETED_STATUSES: Record<Metric, ReadonlySet<AttendanceStatus>> = {
  outline: new Set(["yes"]),
  group_study: new Set(["onsite", "online"]),
  class_study: new Set(["onsite", "online"]),
};

const INVALID_CLASS_STUDY_STATUSES = new Set<ClassStudyStatus>(["observer", "absent"]);

export interface GroupReportSummary {
  groupId: number;
  groupName: string;
  metrics: Record<Metric, MetricRate>;
}

export interface PersonalReportSummary {
  enrollmentId: number;
  studentName: string;
  groupId: number;
  groupName: string;
  metrics: Record<Metric, MetricRate>;
}

export interface ReportSummary {
  classSummary: Record<Metric, MetricRate>;
  groupSummaries: GroupReportSummary[];
  personalStats: PersonalReportSummary[];
}

export interface ClassStudyRecord {
  dueDate: string;
  status: ClassStudyStatus | null | undefined;
  lessonSequence?: number;
}

export interface ClassStudyRisk {
  needsAttention: boolean;
  consecutiveTrigger: boolean;
  rollingThreeMonthTrigger: boolean;
  consecutiveInvalidCount: number;
  invalidInThreeMonths: number;
  reasons: string[];
}

function parseDateOnly(value: string, fieldName = "日期"): Date {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${fieldName}必须使用 YYYY-MM-DD 格式`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName}不是有效日期`);
  }
  return parsed;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function todayInShanghai(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function subtractCalendarMonths(value: string, months: number): string {
  const date = parseDateOnly(value);
  const sourceYear = date.getUTCFullYear();
  const sourceMonth = date.getUTCMonth();
  const sourceDay = date.getUTCDate();
  const absoluteTargetMonth = sourceYear * 12 + sourceMonth - months;
  const targetYear = Math.floor(absoluteTargetMonth / 12);
  const targetMonth = ((absoluteTargetMonth % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return formatDateOnly(
    new Date(Date.UTC(targetYear, targetMonth, Math.min(sourceDay, lastDayOfTargetMonth))),
  );
}

function assertMetric(metric: Metric): void {
  if (!METRICS.includes(metric)) {
    throw new Error(`不支持的考勤指标：${String(metric)}`);
  }
}

function assertStatusForMetric(metric: Metric, status: AttendanceStatus): void {
  if (!ALLOWED_STATUSES[metric].includes(status)) {
    throw new Error(`状态 ${status} 不适用于指标 ${metric}`);
  }
}

/** Calculate one metric as a percentage using recorded applicable rows only. */
export function calculateMetricRate(
  metric: Metric,
  statuses: readonly (AttendanceStatus | null | undefined)[],
): MetricRate {
  assertMetric(metric);

  let completed = 0;
  let recorded = 0;
  let pending = 0;
  let notRequired = 0;

  for (const status of statuses) {
    if (status == null) {
      pending += 1;
      continue;
    }
    assertStatusForMetric(metric, status);
    if (metric === "outline" && status === "not_required") {
      notRequired += 1;
      continue;
    }

    recorded += 1;
    if (COMPLETED_STATUSES[metric].has(status)) completed += 1;
  }

  return {
    metric,
    completed,
    recorded,
    pending,
    notRequired,
    rate: recorded === 0 ? null : Number(((completed / recorded) * 100).toFixed(2)),
  };
}

function summarizeFacts(facts: readonly AttendanceFact[]): Record<Metric, MetricRate> {
  return Object.fromEntries(
    METRICS.map((metric) => [
      metric,
      calculateMetricRate(
        metric,
        facts.filter((fact) => fact.metric === metric).map((fact) => fact.status),
      ),
    ]),
  ) as Record<Metric, MetricRate>;
}

/**
 * Build class, historical-group, and personal summaries from the exact same
 * attendance facts. The class result is calculated from raw person-lessons,
 * not by averaging personal percentages.
 */
export function buildReportSummary(facts: readonly AttendanceFact[]): ReportSummary {
  const groupFacts = new Map<string, AttendanceFact[]>();
  const personFacts = new Map<number, AttendanceFact[]>();

  for (const fact of facts) {
    const groupKey = `${fact.groupId}\u0000${fact.groupName}`;
    const factsForGroup = groupFacts.get(groupKey) ?? [];
    factsForGroup.push(fact);
    groupFacts.set(groupKey, factsForGroup);

    const factsForPerson = personFacts.get(fact.enrollmentId) ?? [];
    factsForPerson.push(fact);
    personFacts.set(fact.enrollmentId, factsForPerson);
  }

  const groupSummaries = [...groupFacts.values()]
    .map((items): GroupReportSummary => ({
      groupId: items[0].groupId,
      groupName: items[0].groupName,
      metrics: summarizeFacts(items),
    }))
    .sort((left, right) => left.groupId - right.groupId || left.groupName.localeCompare(right.groupName, "zh-CN"));

  const personalStats = [...personFacts.values()]
    .map((items): PersonalReportSummary => {
      const latestFact = items.reduce((latest, fact) =>
        fact.lessonSequence >= latest.lessonSequence ? fact : latest,
      );
      return {
        enrollmentId: latestFact.enrollmentId,
        studentName: latestFact.studentName,
        groupId: latestFact.groupId,
        groupName: latestFact.groupName,
        metrics: summarizeFacts(items),
      };
    })
    .sort(
      (left, right) =>
        left.groupId - right.groupId ||
        left.studentName.localeCompare(right.studentName, "zh-CN") ||
        left.enrollmentId - right.enrollmentId,
    );

  return {
    classSummary: summarizeFacts(facts),
    groupSummaries,
    personalStats,
  };
}

/**
 * Detect the class-study-only attention rules. Blank records and future
 * lessons are ignored; a valid recorded status breaks the consecutive chain.
 */
export function detectClassStudyRisk(
  records: readonly ClassStudyRecord[],
  asOfDate = todayInShanghai(),
): ClassStudyRisk {
  const asOfTime = parseDateOnly(asOfDate, "统计日期").getTime();
  const rollingStartTime = parseDateOnly(subtractCalendarMonths(asOfDate, 3)).getTime();

  const recorded = records
    .filter((record): record is ClassStudyRecord & { status: ClassStudyStatus } => {
      const dueTime = parseDateOnly(record.dueDate, "班修日期").getTime();
      if (record.status == null || dueTime > asOfTime) return false;
      if (!ALLOWED_STATUSES.class_study.includes(record.status)) {
        throw new Error(`状态 ${String(record.status)} 不适用于指标 class_study`);
      }
      return true;
    })
    .sort((left, right) => {
      const byDate = parseDateOnly(right.dueDate).getTime() - parseDateOnly(left.dueDate).getTime();
      if (byDate !== 0) return byDate;
      return (right.lessonSequence ?? 0) - (left.lessonSequence ?? 0);
    });

  let consecutiveInvalidCount = 0;
  for (const record of recorded) {
    if (!INVALID_CLASS_STUDY_STATUSES.has(record.status)) break;
    consecutiveInvalidCount += 1;
  }

  const invalidInThreeMonths = recorded.filter((record) => {
    const dueTime = parseDateOnly(record.dueDate).getTime();
    return dueTime >= rollingStartTime && INVALID_CLASS_STUDY_STATUSES.has(record.status);
  }).length;

  const consecutiveTrigger = consecutiveInvalidCount >= 3;
  const rollingThreeMonthTrigger = invalidInThreeMonths >= 5;
  const reasons: string[] = [];
  if (consecutiveTrigger) reasons.push("最近连续 3 次班修为旁听或旷课");
  if (rollingThreeMonthTrigger) reasons.push("最近 3 个月有 5 次或以上班修为旁听或旷课");

  return {
    needsAttention: consecutiveTrigger || rollingThreeMonthTrigger,
    consecutiveTrigger,
    rollingThreeMonthTrigger,
    consecutiveInvalidCount,
    invalidInThreeMonths,
    reasons,
  };
}

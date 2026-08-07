import type { CadenceMode, LessonScheduleItem, LessonType } from "../../shared/types.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

export interface GenerateScheduleOptions {
  firstFinalDueDate: string;
  count?: number;
  cadenceMode?: CadenceMode;
  cadenceModes?: readonly CadenceMode[];
  lessonTypes?: readonly LessonType[];
  titles?: readonly string[];
  startSequence?: number;
}

export interface BreakWeekPlan {
  startsOn: string;
  endsOn: string;
  title: string;
}

export interface BreakInsertionResult {
  breakWeek: BreakWeekPlan;
  lessons: LessonScheduleItem[];
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

function addCalendarDays(value: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new Error("位移天数必须是整数");
  }
  const date = parseDateOnly(value);
  return formatDateOnly(new Date(date.getTime() + days * DAY_IN_MILLISECONDS));
}

function compareDateOnly(left: string, right: string): number {
  return parseDateOnly(left).getTime() - parseDateOnly(right).getTime();
}

function assertCadenceMode(value: CadenceMode): void {
  if (value !== "same_week" && value !== "parallel_two_week") {
    throw new Error(`不支持的学习模式：${String(value)}`);
  }
}

function assertLessonType(value: LessonType): void {
  if (value !== "regular" && value !== "review") {
    throw new Error(`不支持的课次类型：${String(value)}`);
  }
}

/**
 * Starting from the first lesson's final/class-study due date, create an
 * immutable lesson schedule. A lesson's own cadence determines the distance
 * from the preceding final due date, which also makes a future mode change
 * deterministic.
 */
export function generateSchedule(options: GenerateScheduleOptions): LessonScheduleItem[] {
  parseDateOnly(options.firstFinalDueDate, "第一课截止日");

  const count = options.count ?? 24;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("课次数量必须是大于 0 的整数");
  }

  const startSequence = options.startSequence ?? 1;
  if (!Number.isInteger(startSequence) || startSequence < 1) {
    throw new Error("起始课程序号必须是大于 0 的整数");
  }

  const defaultCadence = options.cadenceMode ?? "same_week";
  assertCadenceMode(defaultCadence);

  const lessons: LessonScheduleItem[] = [];
  let finalDueDate = options.firstFinalDueDate;

  for (let index = 0; index < count; index += 1) {
    const cadenceMode = options.cadenceModes?.[index] ?? defaultCadence;
    const lessonType = options.lessonTypes?.[index] ?? "regular";
    assertCadenceMode(cadenceMode);
    assertLessonType(lessonType);

    if (index > 0) {
      finalDueDate = addCalendarDays(
        finalDueDate,
        cadenceMode === "parallel_two_week" ? 14 : 7,
      );
    }

    const firstStageDueDate =
      cadenceMode === "parallel_two_week" ? addCalendarDays(finalDueDate, -7) : finalDueDate;
    const sequence = startSequence + index;
    const suppliedTitle = options.titles?.[index]?.trim();

    lessons.push({
      sequence,
      title: suppliedTitle || `第${sequence}课`,
      lessonType,
      cadenceMode,
      outlineDueDate: firstStageDueDate,
      groupStudyDueDate: firstStageDueDate,
      classStudyDueDate: finalDueDate,
    });
  }

  return lessons;
}

/** Shift the selected lesson and all subsequent lessons without mutating input. */
export function shiftScheduleFrom(
  lessons: readonly LessonScheduleItem[],
  fromSequence: number,
  deltaDays: number,
): LessonScheduleItem[] {
  if (!Number.isInteger(fromSequence) || fromSequence < 1) {
    throw new Error("课程序号必须是大于 0 的整数");
  }
  if (!Number.isInteger(deltaDays)) {
    throw new Error("位移天数必须是整数");
  }
  if (!lessons.some((lesson) => lesson.sequence === fromSequence)) {
    throw new Error(`找不到第 ${fromSequence} 课`);
  }

  return lessons.map((lesson) => {
    if (lesson.sequence < fromSequence) return { ...lesson };
    return {
      ...lesson,
      outlineDueDate: addCalendarDays(lesson.outlineDueDate, deltaDays),
      groupStudyDueDate: addCalendarDays(lesson.groupStudyDueDate, deltaDays),
      classStudyDueDate: addCalendarDays(lesson.classStudyDueDate, deltaDays),
    };
  });
}

/**
 * Insert a seven-day no-study week. Each phase on or after the break is moved
 * by one week. This deliberately supports a break between the first and final
 * phases of a parallel lesson.
 */
export function insertBreak(
  lessons: readonly LessonScheduleItem[],
  startsOn: string,
  title = "放假/暂停",
): BreakInsertionResult {
  parseDateOnly(startsOn, "暂停周开始日");
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    throw new Error("暂停周名称不能为空");
  }

  const shiftIfNeeded = (dueDate: string): string =>
    compareDateOnly(dueDate, startsOn) >= 0 ? addCalendarDays(dueDate, 7) : dueDate;

  return {
    breakWeek: {
      startsOn,
      endsOn: addCalendarDays(startsOn, 6),
      title: normalizedTitle,
    },
    lessons: lessons.map((lesson) => ({
      ...lesson,
      outlineDueDate: shiftIfNeeded(lesson.outlineDueDate),
      groupStudyDueDate: shiftIfNeeded(lesson.groupStudyDueDate),
      classStudyDueDate: shiftIfNeeded(lesson.classStudyDueDate),
    })),
  };
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

/** First date on which a monitor can no longer edit the lesson. */
export function monitorLockDate(finalDueDate: string): string {
  return addCalendarDays(finalDueDate, 14);
}

/**
 * A monitor is locked at 00:00 on the fourteenth calendar day after the final
 * due date. Administrators and counselors should bypass this pure rule.
 */
export function isMonitorLocked(finalDueDate: string, asOfDate = todayInShanghai()): boolean {
  parseDateOnly(asOfDate, "检查日期");
  return compareDateOnly(asOfDate, monitorLockDate(finalDueDate)) >= 0;
}

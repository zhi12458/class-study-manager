export const CADENCE_MODES = ["same_week", "parallel_two_week"] as const;
export type CadenceMode = (typeof CADENCE_MODES)[number];

export const LESSON_TYPES = ["regular", "review"] as const;
export type LessonType = (typeof LESSON_TYPES)[number];

export const METRICS = ["outline", "group_study", "class_study"] as const;
export type Metric = (typeof METRICS)[number];

export const OUTLINE_STATUSES = ["yes", "no", "not_required"] as const;
export type OutlineStatus = (typeof OUTLINE_STATUSES)[number];

export const GROUP_STUDY_STATUSES = ["present", "absent"] as const;
export type GroupStudyStatus = (typeof GROUP_STUDY_STATUSES)[number];

export const CLASS_STUDY_STATUSES = ["onsite", "online", "makeup", "share", "absent"] as const;
export type ClassStudyStatus = (typeof CLASS_STUDY_STATUSES)[number];
export type AttendanceStatus = OutlineStatus | GroupStudyStatus | ClassStudyStatus;

export const REPORT_RANGES = ["recent", "month", "three_months", "history"] as const;
export type ReportRange = (typeof REPORT_RANGES)[number];

export type ClassPermission = "counselor" | "monitor";

export interface ClassAccess {
  classId: number;
  className: string;
  permission: ClassPermission;
  archived: boolean;
}

export interface AuthUser {
  id: number;
  personId: number | null;
  displayName: string;
  phone: string | null;
  isAdmin: boolean;
  canCounsel: boolean;
  mustChangePassword: boolean;
}

export interface LessonScheduleItem {
  sequence: number;
  title: string;
  lessonType: LessonType;
  cadenceMode: CadenceMode;
  outlineDueDate: string;
  groupStudyDueDate: string;
  classStudyDueDate: string;
}

export interface AttendanceFact {
  enrollmentId: number;
  studentName: string;
  groupId: number;
  groupName: string;
  lessonId: number;
  lessonSequence: number;
  metric: Metric;
  dueDate: string;
  status: AttendanceStatus | null;
}

export interface MetricRate {
  metric: Metric;
  completed: number;
  recorded: number;
  pending: number;
  notRequired: number;
  rate: number | null;
}

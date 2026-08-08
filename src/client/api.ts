export type ClassPermission = "counselor" | "monitor";
export type CadenceMode = "same_week" | "parallel_two_week";
export type LessonType = "regular" | "review";
export type Metric = "outline" | "group_study" | "class_study";
export type OutlineStatus = "yes" | "no" | "not_required";
export type GroupStudyStatus = "present" | "absent";
export type ClassStudyStatus = "onsite" | "online" | "makeup" | "share" | "absent";
export type ReportRange = "recent" | "month" | "three_months" | "history";
export type EnrollmentStatus = "normal" | "leave" | "withdrawn";
export type EnrollmentRole = "monitor" | "group_leader" | "charity" | "dharma_light" | "communications" | "student";

export interface ClassAccess {
  classId: number;
  className: string;
  permission: ClassPermission | "admin";
  archived?: boolean;
}

export interface CurrentUser {
  id: number;
  displayName: string;
  name?: string | null;
  dharmaName?: string | null;
  phone?: string | null;
  username?: string | null;
  isAdmin: boolean;
  canCounsel: boolean;
  mustChangePassword: boolean;
  classAccesses: ClassAccess[];
}

export interface Counselor {
  id: number;
  personId?: number;
  displayName: string;
  name?: string | null;
  dharmaName?: string | null;
  phone: string | null;
  username?: string | null;
  active?: boolean;
  accountActive?: boolean;
  activeClassCount?: number;
  archivedClassCount?: number;
  monitorClassCount?: number;
  deletable?: boolean;
}

export interface ClassSummary {
  id: number;
  name: string;
  counselorId?: number | null;
  counselorName?: string | null;
  monitorId?: number | null;
  monitorName?: string | null;
  groupCount?: number;
  studentCount?: number;
  cadenceMode?: CadenceMode;
  archived?: boolean;
  deletable?: boolean;
  permission?: ClassPermission | "admin";
}

export interface Group {
  id: number;
  name: string;
  sortOrder?: number;
  active?: boolean;
  studentCount?: number;
}

export interface Student {
  id: number;
  personId?: number;
  name: string;
  legalName?: string | null;
  dharmaName?: string | null;
  phone?: string | null;
  note?: string | null;
  groupId: number;
  groupName?: string;
  active?: boolean;
  status?: EnrollmentStatus;
  identities?: EnrollmentRole[];
  effectiveFromLessonId?: number | null;
}

export interface Lesson {
  id: number;
  lessonNumber: number;
  title: string;
  lessonType: LessonType;
  cadenceMode: CadenceMode;
  outlineDueDate: string;
  groupStudyDueDate: string;
  classStudyDueDate: string;
  started?: boolean;
  lockedForMonitor?: boolean;
  status?: "future" | "current" | "finished";
}

export interface BreakWeek {
  id: number;
  date: string;
  title?: string;
  reason?: string;
}

export interface AttendanceRow {
  studentId: number;
  name: string;
  dharmaName?: string | null;
  groupId: number;
  groupName: string;
  outline: OutlineStatus | null;
  groupStudy: GroupStudyStatus | null;
  classStudy: ClassStudyStatus | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

export interface AttendancePayload {
  lesson: Lesson;
  rows: AttendanceRow[];
  canEdit: boolean;
  lockedForMonitor: boolean;
  openMetrics?: Record<Metric, boolean>;
}

export interface MetricSummary {
  completed: number;
  applicable: number;
  pending: number;
  rate: number | null;
}

export interface ReportPayload {
  range: ReportRange;
  classSummary: Record<Metric, MetricSummary>;
  groupSummaries: Array<{
    groupId: number;
    groupName: string;
    metrics: Record<Metric, MetricSummary>;
  }>;
  personalStats: Array<{
    studentId: number;
    name: string;
    dharmaName?: string | null;
    groupName: string;
    metrics: Record<Metric, MetricSummary>;
  }>;
  attention: Array<{
    studentId: number;
    name: string;
    groupName: string;
    reasons: string[];
  }>;
  lessons?: Lesson[];
}

export interface ImportPreview {
  token?: string;
  rows: Array<{
    rowNumber: number;
    name: string;
    dharmaName?: string | null;
    phone: string;
    groupName: string;
    note?: string | null;
    status: EnrollmentStatus;
    identities: EnrollmentRole[];
    action: "create" | "update" | "skip" | "conflict";
    message?: string;
  }>;
  summary?: { create: number; update: number; skip: number; conflict: number };
}

function pickArray<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as T[];
  }
  return [];
}

export function asList<T>(value: unknown, ...keys: string[]): T[] {
  return pickArray<T>(value, keys);
}

export async function apiJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");

  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text().then((text) => (text ? { message: text } : {}));

  if (!response.ok) {
    const detail = body as { error?: string; message?: string };
    const error = new Error(detail.error || detail.message || `请求失败（${response.status}）`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return body as T;
}

export function unwrap<T>(value: T | { data: T }, key?: string): T {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (key && key in record) return record[key] as T;
    if ("data" in record) return record.data as T;
  }
  return value as T;
}

export function exportUrl(classId: number, format: "xlsx" | "csv", range: ReportRange): string {
  const params = new URLSearchParams({ range });
  return `/api/classes/${classId}/export.${format}?${params.toString()}`;
}

export function normalizeMe(payload: unknown): CurrentUser {
  const root = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if ("user" in root && root.user == null) throw new Error("未登录");
  const raw = ((root.user ?? root.account ?? root.data ?? root) || {}) as Record<string, unknown>;
  const accessRaw = (root.classAccesses ?? raw.classAccesses ?? root.classes ?? raw.classes ?? []) as unknown;
  const role = String(raw.role ?? raw.globalRole ?? "");
  return {
    id: Number(raw.id ?? raw.accountId ?? 0),
    displayName: String(raw.displayName ?? raw.name ?? raw.username ?? "用户"),
    name: raw.name == null ? null : String(raw.name),
    dharmaName: raw.dharmaName == null ? null : String(raw.dharmaName),
    phone: raw.phone == null ? null : String(raw.phone),
    username: raw.username == null ? null : String(raw.username),
    isAdmin: Boolean(raw.isAdmin ?? role === "admin"),
    canCounsel: Boolean(raw.canCounsel ?? raw.isAdmin ?? (role === "admin" || role === "counselor")),
    mustChangePassword: Boolean(raw.mustChangePassword ?? raw.passwordChangeRequired ?? raw.forcePasswordChange),
    classAccesses: pickArray<Record<string, unknown>>(accessRaw, ["classAccesses", "classes"]).map((item) => ({
      classId: Number(item.classId ?? item.id),
      className: String(item.className ?? item.name ?? "未命名班级"),
      permission: (item.permission ?? item.role ?? (role === "admin" ? "admin" : "monitor")) as ClassAccess["permission"],
      archived: Boolean(item.archived)
    }))
  };
}

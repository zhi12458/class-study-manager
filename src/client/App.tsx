import {
  AlertTriangle,
  Archive,
  BarChart3,
  BookOpenCheck,
  CalendarDays,
  Check,
  ChevronDown,
  ClipboardCheck,
  CloudSun,
  Download,
  FileSpreadsheet,
  GraduationCap,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  LogOut,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Upload,
  UserCog,
  UserPlus,
  UserRound,
  Users,
  X
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import {
  apiJson,
  asList,
  exportUrl,
  normalizeMe,
  type AttendancePayload,
  type AttendanceRow,
  type CadenceMode,
  type ClassStudyStatus,
  type ClassSummary,
  type Counselor,
  type CurrentUser,
  type EnrollmentRole,
  type EnrollmentStatus,
  type Group,
  type GroupStudyStatus,
  type ImportPreview,
  type Lesson,
  type Metric,
  type MetricSummary,
  type OutlineStatus,
  type ReportPayload,
  type ReportRange,
  type Student
} from "./api";

const METRIC_LABELS: Record<Metric, string> = {
  outline: "导图/提纲",
  group_study: "组修",
  class_study: "班修"
};
const RANGE_LABELS: Record<ReportRange, string> = {
  recent: "最近",
  month: "当月",
  three_months: "最近 3 个月",
  history: "历史",
  custom: "自定义时间段"
};
const PRESET_REPORT_RANGES = ["recent", "month", "three_months", "history"] as const;
type PresetReportRange = (typeof PRESET_REPORT_RANGES)[number];
const OUTLINE_OPTIONS: Array<{ value: OutlineStatus; label: string }> = [
  { value: "yes", label: "是" },
  { value: "no", label: "否" }
];
const GROUP_OPTIONS: Array<{ value: GroupStudyStatus; label: string }> = [
  { value: "present", label: "出勤" },
  { value: "absent", label: "缺勤" }
];
const CLASS_OPTIONS: Array<{ value: ClassStudyStatus; label: string }> = [
  { value: "onsite", label: "现场" },
  { value: "online", label: "网络" },
  { value: "makeup", label: "补课" },
  { value: "share", label: "分享" },
  { value: "absent", label: "缺勤" }
];
const ENROLLMENT_STATUS_LABELS: Record<EnrollmentStatus, string> = { normal: "正常", leave: "休学", withdrawn: "退学" };
const ENROLLMENT_ROLE_LABELS: Record<EnrollmentRole, string> = {
  monitor: "班长", group_leader: "组长", charity: "慈善", dharma_light: "传灯",
  communications: "文宣", student: "学员"
};
const EDITABLE_ROLE_OPTIONS: Array<{ value: EnrollmentRole; label: string }> = [
  { value: "group_leader", label: "组长" }, { value: "charity", label: "慈善" },
  { value: "dharma_light", label: "传灯" }, { value: "communications", label: "文宣" }
];

type NoticeState = { tone: "success" | "error" | "info"; text: string } | null;
type NavContextValue = { path: string; go: (path: string) => boolean; dirty: boolean; setDirty: (dirty: boolean) => void };

const NavContext = createContext<NavContextValue>({ path: "/", go: () => false, dirty: false, setDirty: () => undefined });

function useNavigation() {
  return useContext(NavContext);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

function dateOnly(value: unknown) {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

function shanghaiTodayClient(): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function classFromRaw(raw: Record<string, unknown>): ClassSummary {
  return {
    id: Number(raw.id ?? raw.classId),
    name: String(raw.name ?? raw.className ?? "未命名班级"),
    counselorId: raw.counselorId == null ? null : Number(raw.counselorId),
    counselorName: raw.counselorName == null ? null : String(raw.counselorName),
    monitorId: raw.monitorId == null ? null : Number(raw.monitorId),
    monitorName: raw.monitorName == null ? null : String(raw.monitorName),
    groupCount: Number(raw.groupCount ?? 0),
    studentCount: Number(raw.studentCount ?? 0),
    cadenceMode: (raw.cadenceMode ?? "same_week") as CadenceMode,
    meetingTime: raw.meetingTime == null ? null : String(raw.meetingTime),
    sourceProgress: raw.sourceProgress == null ? null : String(raw.sourceProgress),
    courseSeriesKey: raw.courseSeriesKey == null ? null : String(raw.courseSeriesKey),
    courseRound: Number(raw.courseRound ?? 1),
    courseStartPosition: Number(raw.courseStartPosition ?? 1),
    archived: Boolean(raw.archived),
    deletable: Boolean(raw.deletable),
    permission: (raw.permission ?? "admin") as ClassSummary["permission"]
  };
}

function groupFromRaw(raw: Record<string, unknown>): Group {
  return {
    id: Number(raw.id ?? raw.groupId),
    name: String(raw.name ?? raw.groupName ?? "未命名小组"),
    sortOrder: Number(raw.sortOrder ?? 0),
    active: raw.active == null ? true : Boolean(raw.active),
    studentCount: Number(raw.studentCount ?? 0)
  };
}

function studentFromRaw(raw: Record<string, unknown>): Student {
  return {
    id: Number(raw.id ?? raw.studentId),
    personId: raw.personId == null ? undefined : Number(raw.personId),
    name: String(raw.name ?? ""),
    legalName: raw.legalName == null ? null : String(raw.legalName),
    dharmaName: raw.dharmaName == null ? null : String(raw.dharmaName),
    phone: raw.phone == null ? null : String(raw.phone),
    note: raw.note == null && raw.notes == null ? null : String(raw.note ?? raw.notes),
    groupId: Number(raw.groupId ?? 0),
    groupName: String(raw.groupName ?? ""),
    active: raw.active == null ? true : Boolean(raw.active),
    status: (raw.status ?? "normal") as EnrollmentStatus,
    identities: Array.isArray(raw.identities) ? raw.identities.map(String) as EnrollmentRole[] : ["student"],
    effectiveFromLessonId: raw.effectiveFromLessonId == null ? null : Number(raw.effectiveFromLessonId)
  };
}

function lessonFromRaw(raw: Record<string, unknown>): Lesson {
  return {
    id: Number(raw.id ?? raw.lessonId),
    lessonNumber: Number(raw.sequence ?? raw.lessonNumber ?? raw.number ?? 0),
    coursePosition: raw.coursePosition == null ? null : Number(raw.coursePosition),
    title: String(raw.title ?? raw.name ?? `第 ${raw.sequence ?? raw.lessonNumber ?? ""} 课`),
    lessonType: (raw.lessonType ?? "regular") as Lesson["lessonType"],
    cadenceMode: (raw.cadenceMode ?? "same_week") as CadenceMode,
    outlineDueDate: dateOnly(raw.outlineDueDate ?? raw.outlineDate),
    groupStudyDueDate: dateOnly(raw.groupStudyDueDate ?? raw.groupDate),
    classStudyDueDate: dateOnly(raw.classStudyDueDate ?? raw.dueDate),
    started: Boolean(raw.started),
    lockedForMonitor: Boolean(raw.lockedForMonitor),
    status: raw.status as Lesson["status"]
  };
}

function formatRate(summary?: MetricSummary) {
  if (!summary || summary.rate == null || summary.applicable === 0) return "不适用";
  return `${Math.round(summary.rate)}%`;
}

function Notice({ notice, onClose }: { notice: NoticeState; onClose?: () => void }) {
  if (!notice) return null;
  return (
    <div className={`notice ${notice.tone}`} role="status">
      <span>{notice.text}</span>
      {onClose && (
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭提示">
          <X size={16} />
        </button>
      )}
    </div>
  );
}

function Loading({ text = "正在加载..." }: { text?: string }) {
  return (
    <div className="loading-state">
      <LoaderCircle className="spin" size={22} />
      {text}
    </div>
  );
}

function EmptyState({ icon, title, detail, action }: { icon?: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon ?? <CloudSun size={28} />}</div>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}

function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  const titleId = useId();
  onCloseRef.current = onClose;
  const close = () => {
    const returnFocus = returnFocusRef.current;
    onCloseRef.current();
    window.setTimeout(() => returnFocus?.focus({ preventScroll: true }), 0);
  };
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector = "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusFirst = () => {
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector);
      (focusable?.[0] ?? dialogRef.current)?.focus();
    };
    const frame = window.requestAnimationFrame(focusFirst);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)]
        .filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={dialogRef} className={`modal-card ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-button" onClick={close} aria-label="关闭">
            <X size={19} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function AppNavigation({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(window.location.pathname);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const go = useCallback((next: string) => {
    if (next === window.location.pathname) return true;
    if (dirtyRef.current && !window.confirm("当前考勤还有未保存的修改，确定离开吗？")) return false;
    setDirty(false);
    window.history.pushState({}, "", next);
    setPath(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const popState = () => {
      if (dirtyRef.current && !window.confirm("当前考勤还有未保存的修改，确定离开吗？")) {
        window.history.go(1);
        return;
      }
      setDirty(false);
      setPath(window.location.pathname);
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", popState);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", popState);
    };
  }, []);

  return <NavContext.Provider value={{ path, go, dirty, setDirty }}>{children}</NavContext.Provider>;
}

function LoginPage({ onLogin }: { onLogin: (user: CurrentUser) => void }) {
  const [identifier, setIdentifier] = useState("admin");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setNotice(null);
    try {
      await apiJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, username: identifier, phone: identifier, password })
      });
      const payload = await apiJson<unknown>("/api/auth/me");
      onLogin(normalizeMe(payload));
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <div className="sky-orb orb-one" />
      <div className="sky-orb orb-two" />
      <section className="login-copy">
        <div className="brand-pill"><CloudSun size={18} /> 云端共修 · 用心同行</div>
        <h1>让每一次共修<br /><span>清晰、安心、有回响</span></h1>
        <p>统一管理班级、学员、课次和三项考勤，在同一个地方看见大家的学习进度。</p>
        <div className="feature-row">
          <span><Check size={15} /> 多班级管理</span>
          <span><Check size={15} /> 三指标统计</span>
          <span><Check size={15} /> 手机便捷登记</span>
        </div>
      </section>
      <section className="login-card">
        <div className="login-logo"><BookOpenCheck size={29} /></div>
        <div>
          <span className="eyebrow">WELCOME BACK</span>
          <h2>登录班级共修管理系统</h2>
          <p>管理员使用账号；辅导员和班长可使用手机号或分配的拼音账号登录。</p>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label>
            账号或手机号
            <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="admin 或 13800138000" autoComplete="username" required />
          </label>
          <label>
            密码
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="请输入密码" autoComplete="current-password" required />
          </label>
          <Notice notice={notice} />
          <button className="primary large full" disabled={loading}>
            {loading ? <><LoaderCircle className="spin" size={18} /> 登录中</> : <>登录 <span aria-hidden>→</span></>}
          </button>
        </form>
        <p className="login-help">首次收到临时密码后，登录即会引导您设置新密码。</p>
      </section>
    </main>
  );
}

function ChangePasswordPage({ user, onDone, onLogout }: { user: CurrentUser; onDone: () => void; onLogout: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword.length < 8) return setNotice({ tone: "error", text: "新密码至少需要 8 位" });
    if (newPassword !== confirmPassword) return setNotice({ tone: "error", text: "两次输入的新密码不一致" });
    setLoading(true);
    try {
      await apiJson("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      setNotice({ tone: "success", text: "密码已更新" });
      onDone();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page single">
      <section className="login-card password-card">
        <div className="login-logo"><ShieldCheck size={29} /></div>
        <div>
          <span className="eyebrow">首次登录 · {user.displayName}</span>
          <h2>先设置一个新密码</h2>
          <p>临时密码只使用一次。更新后即可进入您负责的班级。</p>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label>临时密码<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label>
          <label>新密码<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required /></label>
          <label>再次输入新密码<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required /></label>
          <Notice notice={notice} />
          <button className="primary large full" disabled={loading}>{loading ? "保存中..." : "保存新密码并进入"}</button>
          <button type="button" className="text-button" onClick={onLogout}>退出登录</button>
        </form>
      </section>
    </main>
  );
}

type ShellProps = {
  user: CurrentUser;
  classes: ClassSummary[];
  currentClass: ClassSummary | null;
  onSelectClass: (id: number) => void;
  onLogout: () => void;
  children: ReactNode;
};

function AppShell({ user, classes, currentClass, onSelectClass, onLogout, children }: ShellProps) {
  const { path, go } = useNavigation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const manager = user.isAdmin || currentClass?.permission === "counselor";
  const navItems = [
    { path: "/overview", label: "班级总览", icon: LayoutDashboard, needsClass: true },
    { path: "/attendance", label: "考勤登记", icon: ClipboardCheck, needsClass: true },
    { path: "/students", label: "学员名单", icon: Users, needsClass: true, manager: true },
    { path: "/groups", label: "小组管理", icon: GraduationCap, needsClass: true, manager: true },
    { path: "/lessons", label: "课表安排", icon: CalendarDays, needsClass: true, manager: true },
    { path: "/reports", label: "完成统计", icon: BarChart3, needsClass: true },
    { path: "/settings", label: "班级设置", icon: Settings, needsClass: true, manager: true },
    { path: "/classes", label: "全部班级", icon: BookOpenCheck, needsClass: false },
    { path: "/profile", label: "我的资料", icon: UserRound, needsClass: false }
  ].filter((item) => !item.manager || manager);

  const closeMobileMenu = useCallback((restoreFocus = true) => {
    setMobileOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
  }, []);

  function navigate(next: string) {
    if (go(next)) closeMobileMenu();
  }

  useEffect(() => {
    if (!mobileOpen) return;
    const frame = window.requestAnimationFrame(() => mobileCloseButtonRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobileMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("keydown", onKey); };
  }, [closeMobileMenu, mobileOpen]);

  return (
    <div className="app-shell">
      <button className={`mobile-scrim ${mobileOpen ? "show" : ""}`} aria-label="关闭菜单" tabIndex={mobileOpen ? 0 : -1} onClick={() => closeMobileMenu()} />
      <aside id="main-navigation" className={`sidebar ${mobileOpen ? "open" : ""}`} aria-label="主导航">
        <div className="sidebar-brand">
          <div className="brand-icon"><BookOpenCheck size={23} /></div>
          <div><strong>班级共修</strong><span>管理系统</span></div>
          <button ref={mobileCloseButtonRef} className="mobile-close icon-button" onClick={() => closeMobileMenu()} aria-label="关闭菜单"><X size={20} /></button>
        </div>
        <nav className="main-nav">
          <span className="nav-caption">班级空间</span>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = path === item.path || (item.path !== "/overview" && path.startsWith(`${item.path}/`));
            return (
              <button key={item.path} className={`nav-item ${active ? "active" : ""}`} onClick={() => navigate(item.path)} disabled={item.needsClass && !currentClass}>
                <Icon size={18} /><span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="avatar">{user.displayName.slice(0, 1)}</div>
          <div className="user-meta"><strong>{user.displayName}</strong><span>{user.isAdmin ? "系统管理员" : currentClass?.permission === "counselor" ? "辅导员" : "班长"}</span></div>
          <button className="icon-button dark" onClick={onLogout} title="退出登录"><LogOut size={18} /></button>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <button ref={mobileMenuButtonRef} className="mobile-menu icon-button" onClick={() => setMobileOpen(true)} aria-label="打开菜单" aria-expanded={mobileOpen} aria-controls="main-navigation"><Menu size={21} /></button>
          <div className="class-switcher-wrap">
            <span>当前班级</span>
            {classes.length > 0 ? (
              <div className="select-shell">
                <select value={currentClass?.id ?? ""} onChange={(event) => onSelectClass(Number(event.target.value))} aria-label="切换班级">
                  {classes.filter((item) => !item.archived || item.id === currentClass?.id).map((item) => <option key={item.id} value={item.id}>{item.name}{item.archived ? "（已停用）" : ""}</option>)}
                </select>
                <ChevronDown size={15} />
              </div>
            ) : <strong>还没有班级</strong>}
          </div>
          <div className="topbar-right">
            {currentClass && <span className={`role-badge ${currentClass.permission ?? (user.isAdmin ? "admin" : "")}`}>{user.isAdmin ? "管理员" : currentClass.permission === "counselor" ? "辅导员" : "班长"}</span>}
            <div className="top-avatar">{user.displayName.slice(0, 1)}</div>
          </div>
        </header>
        {children}
      </section>
    </div>
  );
}

function ProfilePage({ user, onUpdated }: { user: CurrentUser; onUpdated: (user: CurrentUser) => Promise<void> }) {
  const [name, setName] = useState(user.name ?? (user.dharmaName ? "" : user.displayName));
  const [dharmaName, setDharmaName] = useState(user.dharmaName ?? "");
  const [phone, setPhone] = useState(user.phone ?? "");
  const [username, setUsername] = useState(user.username ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setName(user.name ?? (user.dharmaName ? "" : user.displayName));
    setDharmaName(user.dharmaName ?? "");
    setPhone(user.phone ?? "");
    setUsername(user.username ?? "");
  }, [user]);

  async function save(event: FormEvent) {
    event.preventDefault(); setLoading(true); setNotice(null);
    try {
      await apiJson("/api/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), dharmaName: dharmaName.trim() || null, phone: phone.trim(), username: user.isAdmin ? undefined : username.trim(), currentPassword })
      });
      const payload = await apiJson<unknown>("/api/auth/me");
      const nextUser = normalizeMe(payload);
      await onUpdated(nextUser);
      setCurrentPassword("");
      setNotice({ tone: "success", text: nextUser.isAdmin ? "管理员资料已更新，登录账号仍为 admin" : `个人资料已更新；下次请使用账号 ${nextUser.username} 登录` });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  return <main className="page">
    <PageHeader eyebrow="MY PROFILE" title="我的资料" description="维护姓名、法名和联系电话；登录安全信息会同步更新。" />
    <Notice notice={notice} onClose={() => setNotice(null)} />
    <div className="settings-grid">
      <form className="panel form-stack" onSubmit={save}>
        <div className="panel-head"><div><h2>个人信息</h2><p>{user.isAdmin ? "管理员登录账号固定保留，不会随联系电话改变。" : "手机号可留空，登录账号独立保存。"}</p></div><UserRound size={20} /></div>
        <label>姓名（选填）<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        {!user.isAdmin && <label>法名（姓名与法名至少一项）<input value={dharmaName} onChange={(event) => setDharmaName(event.target.value)} /></label>}
        <label>联系电话（选填）<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" placeholder="未写区号时默认 +86" /></label>
        {!user.isAdmin && <label>登录账号<input value={username} onChange={(event) => setUsername(event.target.value)} autoCapitalize="none" required /><small>可使用拼音；修改后法名再变化也不会自动改变此账号。</small></label>}
        <label>当前密码（修改手机号或登录账号时必填）<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" placeholder="登录信息不变时可以留空" /></label>
        <button className="primary align-start" disabled={loading}><Save size={17} /> {loading ? "保存中..." : "保存我的资料"}</button>
      </form>
      <section className="panel form-stack">
        <div className="panel-head"><div><h2>账号安全</h2><p>手机号全系统唯一，防止人员资料和登录账号混淆。</p></div><ShieldCheck size={20} /></div>
        <dl className="profile-facts"><div><dt>登录账号</dt><dd>{user.isAdmin ? "admin" : user.username || "—"}</dd></div><div><dt>当前身份</dt><dd>{user.isAdmin ? "系统管理员" : user.canCounsel ? "辅导员（可兼任班长）" : "班长"}</dd></div></dl>
        <div className="permission-note"><strong>账号与资料分开</strong><span>{user.isAdmin ? "联系电话会更新，但仍使用 admin 登录。" : "法名变化不会自动改变登录账号；修改登录账号必须输入当前密码。"}</span></div>
      </section>
    </div>
  </main>;
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

function ClassHub({ user, classes, onRefresh, onSelect }: { user: CurrentUser; classes: ClassSummary[]; onRefresh: () => Promise<void>; onSelect: (id: number) => void }) {
  const { go } = useNavigation();
  const [counselors, setCounselors] = useState<Counselor[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showCounselor, setShowCounselor] = useState(false);
  const [showCounselorManager, setShowCounselorManager] = useState(false);
  const [editingCounselor, setEditingCounselor] = useState<Counselor | null>(null);
  const [name, setName] = useState("");
  const [meetingTime, setMeetingTime] = useState("");
  const [groupCount, setGroupCount] = useState(3);
  const [counselorId, setCounselorId] = useState("");
  const [cadenceMode, setCadenceMode] = useState<CadenceMode>("same_week");
  const [notice, setNotice] = useState<NoticeState>(null);
  const [counselorNotice, setCounselorNotice] = useState<NoticeState>(null);
  const [classFilter, setClassFilter] = useState<"all" | "normal" | "stopped">("all");
  const [loading, setLoading] = useState(false);

  const loadCounselors = useCallback(async () => {
    if (!user.isAdmin) return;
    try {
      const data = await apiJson<unknown>("/api/admin/counselors");
      setCounselors(asList<Record<string, unknown>>(data, "counselors", "items").map((raw) => ({
        id: Number(raw.id ?? raw.accountId), personId: raw.personId == null ? undefined : Number(raw.personId),
        displayName: String(raw.displayName ?? raw.name ?? ""), name: raw.name == null ? null : String(raw.name),
        dharmaName: raw.dharmaName == null ? null : String(raw.dharmaName),
        phone: raw.phone == null ? null : String(raw.phone), username: raw.username == null ? null : String(raw.username),
        active: raw.active == null ? true : Boolean(raw.active),
        accountActive: raw.accountActive == null ? undefined : Boolean(raw.accountActive),
        activeClassCount: Number(raw.activeClassCount ?? 0), archivedClassCount: Number(raw.archivedClassCount ?? 0),
        monitorClassCount: Number(raw.monitorClassCount ?? 0), deletable: Boolean(raw.deletable)
      })));
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    }
  }, [user.isAdmin]);

  useEffect(() => { void loadCounselors(); }, [loadCounselors]);
  useEffect(() => {
    if (showCreate && user.isAdmin && !counselorId && counselors.length) setCounselorId(String(counselors[0].id));
  }, [showCreate, counselors, counselorId, user.isAdmin]);

  async function createClass(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    if (user.isAdmin && !counselorId) return setNotice({ tone: "error", text: "管理员创建班级时必须选择辅导员" });
    setLoading(true);
    try {
      const result = await apiJson<Record<string, unknown>>("/api/classes", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), meetingTime: meetingTime.trim(), groupCount, cadenceMode, ...(user.isAdmin ? { counselorId: Number(counselorId) } : {}) })
      });
      await onRefresh();
      setShowCreate(false);
      setName("");
      setMeetingTime("");
      setNotice({ tone: "success", text: "班级已创建，默认小组也准备好了" });
      const id = Number(result.id ?? result.classId ?? (result.class as Record<string, unknown> | undefined)?.id);
      if (id) onSelect(id);
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally { setLoading(false); }
  }

  async function createCounselor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoading(true);
    try {
      const result = await apiJson<Record<string, unknown>>("/api/admin/counselors", {
        method: "POST",
        body: JSON.stringify({ name: form.get("name"), dharmaName: form.get("dharmaName"), phone: form.get("phone"), username: form.get("username") })
      });
      const temporaryPassword = String(result.temporaryPassword ?? (result.account as Record<string, unknown> | undefined)?.temporaryPassword ?? "");
      setShowCounselor(false);
      const loginIdentifier = String(result.loginIdentifier ?? result.username ?? "");
      setNotice({ tone: "success", text: temporaryPassword ? `辅导员账号已创建：${loginIdentifier}，临时密码：${temporaryPassword}` : "辅导员账号已创建" });
      await loadCounselors();
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  async function toggleCounselor(counselor: Counselor) {
    const nextActive = counselor.active === false;
    const action = nextActive ? "恢复" : "停用";
    if (!window.confirm(`确定${action}辅导员“${counselor.displayName}”吗？`)) return;
    setLoading(true); setCounselorNotice(null);
    try {
      await apiJson(`/api/admin/counselors/${counselor.id}`, {
        method: "PATCH", body: JSON.stringify({ active: nextActive })
      });
      await Promise.all([loadCounselors(), onRefresh()]);
      setCounselorNotice({ tone: "success", text: `${counselor.displayName} 已${action}` });
    } catch (error) { setCounselorNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  async function deleteCounselor(counselor: Counselor) {
    if (!window.confirm(`确定永久删除未使用的辅导员账号“${counselor.displayName}”吗？此操作不能撤销。`)) return;
    setLoading(true); setCounselorNotice(null);
    try {
      await apiJson(`/api/admin/counselors/${counselor.id}`, { method: "DELETE" });
      await loadCounselors();
      setCounselorNotice({ tone: "success", text: `${counselor.displayName} 的未使用账号已永久删除` });
    } catch (error) { setCounselorNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  async function setClassStopped(item: ClassSummary, stopped: boolean) {
    const action = stopped ? "停用" : "恢复";
    if (!window.confirm(`确定${action}班级“${item.name}”吗？${stopped ? "班长将立即停止访问，历史数据会保留。" : "班级将恢复日常使用。"}`)) return;
    setLoading(true);
    try {
      await apiJson(`/api/classes/${item.id}`, { method: "PATCH", body: JSON.stringify({ archived: stopped }) });
      await onRefresh();
      setNotice({ tone: "success", text: `${item.name} 已${action}` });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  async function deleteClass(item: ClassSummary) {
    if (!window.confirm(`确定永久删除空班级“${item.name}”吗？此操作不能撤销。`)) return;
    setLoading(true);
    try {
      await apiJson(`/api/classes/${item.id}`, { method: "DELETE" });
      await onRefresh();
      setNotice({ tone: "success", text: `${item.name} 已永久删除` });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  function enterClass(id: number) {
    onSelect(id);
    go("/overview");
  }

  const visibleClasses = classes.filter((item) => classFilter === "all" || (classFilter === "normal" ? !item.archived : item.archived));

  return (
    <main className="page">
      <PageHeader eyebrow="CLASS SPACES" title="全部班级" description="创建、切换并管理您有权限访问的班级。" actions={<>
        {user.isAdmin && <button className="secondary" onClick={() => setShowCounselor(true)}><UserPlus size={17} /> 新建辅导员</button>}
        {user.isAdmin && <button className="secondary" onClick={() => { setCounselorNotice(null); setShowCounselorManager(true); }}><UserCog size={17} /> 管理辅导员</button>}
        {(user.isAdmin || user.canCounsel) && <button className="primary" onClick={() => setShowCreate(true)}><Plus size={17} /> 新建班级</button>}
      </>} />
      <Notice notice={notice} onClose={() => setNotice(null)} />
      <section className="class-filter-bar"><div><button className={classFilter === "all" ? "active" : ""} onClick={() => setClassFilter("all")}>全部 <span>{classes.length}</span></button><button className={classFilter === "normal" ? "active" : ""} onClick={() => setClassFilter("normal")}>正常 <span>{classes.filter((item) => !item.archived).length}</span></button><button className={classFilter === "stopped" ? "active" : ""} onClick={() => setClassFilter("stopped")}>已停用 <span>{classes.filter((item) => item.archived).length}</span></button></div></section>
      {visibleClasses.length === 0 ? (
        <EmptyState
          title={classes.length ? "当前筛选没有班级" : "还没有班级"}
          detail={classes.length ? "请切换其他状态查看。" : (user.isAdmin || user.canCounsel) ? "创建第一个班级后，就可以导入名单并生成课表。" : "您目前没有可访问的班级，请联系管理员或辅导员。"}
          action={!classes.length && (user.isAdmin || user.canCounsel) ? <button className="primary" onClick={() => setShowCreate(true)}><Plus size={17} /> 创建班级</button> : undefined}
        />
      ) : (
        <section className="class-card-grid">
          {visibleClasses.map((item) => (
            <article className={`class-card ${item.archived ? "stopped" : ""}`} key={item.id}>
              <div className="class-card-illustration"><CloudSun size={30} /><span className={`class-status ${item.archived ? "stopped" : "normal"}`}>{item.archived ? "已停用" : "正常"}</span></div>
              <div className="class-card-body">
                <div className="card-title-row"><h2>{item.name}</h2><span className="soft-badge">{item.permission === "monitor" ? "班长" : item.permission === "counselor" ? "辅导员" : "管理员"}</span></div>
                <p>辅导员：{item.counselorName || "待设置"}</p>
                {item.meetingTime && <p>共修时间：{item.meetingTime}</p>}
                <div className="class-facts"><span><Users size={15} /> {item.studentCount ?? 0} 位在班学员</span><span><UserCog size={15} /> 班长：{item.monitorName || "未设置"}</span></div>
                <button className="primary full" onClick={() => enterClass(item.id)}>进入班级 <span aria-hidden>→</span></button>
                {(user.isAdmin || item.permission === "counselor") && <div className="class-card-actions"><button className="secondary" onClick={() => void setClassStopped(item, !item.archived)} disabled={loading}>{item.archived ? "恢复班级" : "停用班级"}</button>{user.isAdmin && item.deletable && <button className="ghost danger" onClick={() => void deleteClass(item)} disabled={loading}>永久删除</button>}</div>}
              </div>
            </article>
          ))}
        </section>
      )}

      {showCreate && <Modal title="创建新班级" subtitle="创建后会自动生成默认小组，课表可稍后安排。" onClose={() => setShowCreate(false)}>
        <form className="form-stack" onSubmit={createClass}>
          <label>班级名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：菩提 2026 春季班" autoFocus required /></label>
          <label>固定共修时间（选填）<input value={meetingTime} onChange={(event) => setMeetingTime(event.target.value)} placeholder="例如：每周二 19:00–21:00" /></label>
          <div className="form-grid two">
            <label>小组数量<select value={groupCount} onChange={(event) => setGroupCount(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count} 个小组</option>)}</select></label>
            <label>学习安排<select value={cadenceMode} onChange={(event) => setCadenceMode(event.target.value as CadenceMode)}><option value="same_week">同周完成（默认）</option><option value="parallel_two_week">平行两周</option></select></label>
          </div>
          {user.isAdmin && <label>负责辅导员<select value={counselorId} onChange={(event) => setCounselorId(event.target.value)} required><option value="">请选择辅导员</option>{counselors.filter((item) => item.active !== false).map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.phone || item.username}</option>)}</select></label>}
          <div className="modal-actions"><button type="button" className="ghost" onClick={() => setShowCreate(false)}>取消</button><button className="primary" disabled={loading}>{loading ? "创建中..." : "创建班级"}</button></div>
        </form>
      </Modal>}
      {showCounselor && <Modal title="新建辅导员账号" subtitle="系统会生成一次性临时密码，首次登录必须修改。" onClose={() => setShowCounselor(false)}>
        <form className="form-stack" onSubmit={createCounselor}>
          <div className="form-grid two"><label>姓名（选填）<input name="name" placeholder="俗名" /></label><label>法名（至少填写一项）<input name="dharmaName" placeholder="例如：明觉" /></label></div>
          <label>手机号（选填）<input name="phone" inputMode="tel" placeholder="未填区号时默认 +86" /></label>
          <label>登录账号（选填）<input name="username" autoCapitalize="none" placeholder="留空时优先用手机号，否则按姓名或法名生成拼音" /><small>账号创建后不会随法名变化；如有重名，系统会自动添加数字。</small></label>
          <div className="modal-actions"><button type="button" className="ghost" onClick={() => setShowCounselor(false)}>取消</button><button className="primary" disabled={loading}>{loading ? "创建中..." : "创建并生成密码"}</button></div>
        </form>
      </Modal>}
      {showCounselorManager && <Modal title="辅导员账号管理" subtitle="先转交未归档班级，再停用辅导员；有历史记录的账号不会被物理删除。" onClose={() => setShowCounselorManager(false)} wide>
        <div className="form-stack">
          <Notice notice={counselorNotice} onClose={() => setCounselorNotice(null)} />
          {counselors.length === 0 ? <EmptyState title="还没有辅导员账号" detail="请先创建辅导员。" /> : <><div className="table-wrap counselor-table desktop-table"><table><thead><tr><th>辅导员</th><th>负责班级</th><th>其他身份</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{counselors.map((counselor) => <tr key={counselor.id}>
            <td><div className="person-cell"><div className="mini-avatar">{counselor.displayName.slice(0, 1)}</div><span><strong>{counselor.displayName}</strong><small>{counselor.phone || "无手机号"} · {counselor.username}</small></span></div></td>
            <td><strong>{counselor.activeClassCount ?? 0}</strong> 个进行中<small className="cell-note">{counselor.archivedClassCount ? `${counselor.archivedClassCount} 个已归档` : "无已归档班级"}</small></td>
            <td>{counselor.monitorClassCount ? <span className="soft-badge">兼任班长</span> : "—"}</td>
            <td><span className={`state-dot ${counselor.active === false ? "inactive" : ""}`}>{counselor.active === false ? "已停用" : "正常"}</span></td>
            <td><div className="row-actions">
              <button className="secondary compact" onClick={() => setEditingCounselor(counselor)} disabled={loading}>编辑资料</button>
              <button className="secondary compact" onClick={() => void toggleCounselor(counselor)} disabled={loading || (counselor.active !== false && Boolean(counselor.activeClassCount))} title={counselor.active !== false && counselor.activeClassCount ? "请先在班级设置中转交其负责的班级" : undefined}>{counselor.active === false ? "恢复" : "停用"}</button>
              {counselor.deletable && <button className="text-danger" onClick={() => void deleteCounselor(counselor)} disabled={loading}>永久删除</button>}
            </div></td>
          </tr>)}</tbody></table></div><div className="mobile-card-list">{counselors.map((counselor) => <article className="student-card" key={counselor.id}>
            <div className="person-cell"><div className="mini-avatar large">{counselor.displayName.slice(0, 1)}</div><span><strong>{counselor.displayName}</strong><small>{counselor.phone || "无手机号"} · {counselor.username}</small></span><span className={`state-dot ${counselor.active === false ? "inactive" : ""}`}>{counselor.active === false ? "已停用" : "正常"}</span></div>
            <dl><div><dt>负责班级</dt><dd>{counselor.activeClassCount ?? 0} 个进行中{counselor.archivedClassCount ? ` · ${counselor.archivedClassCount} 个已归档` : ""}</dd></div><div><dt>其他身份</dt><dd>{counselor.monitorClassCount ? "兼任班长" : "—"}</dd></div></dl>
            <div className="card-actions"><button className="secondary" onClick={() => setEditingCounselor(counselor)} disabled={loading}>编辑资料</button><button className="secondary" onClick={() => void toggleCounselor(counselor)} disabled={loading || (counselor.active !== false && Boolean(counselor.activeClassCount))} title={counselor.active !== false && counselor.activeClassCount ? "请先转交其负责的班级" : undefined}>{counselor.active === false ? "恢复" : "停用"}</button>{counselor.deletable && <button className="ghost danger" onClick={() => void deleteCounselor(counselor)} disabled={loading}>永久删除</button>}</div>
          </article>)}</div></>}
          <div className="permission-note"><strong>为什么有些账号不能删除？</strong><span>只要账号已经关联班级、学员、班长或考勤历史，就只能停用，以保证历史记录仍能显示正确的操作人。</span></div>
          <div className="modal-actions"><button type="button" className="primary" onClick={() => setShowCounselorManager(false)}>完成</button></div>
        </div>
      </Modal>}
      {editingCounselor && <CounselorEditor counselor={editingCounselor} onClose={() => setEditingCounselor(null)} onSaved={async () => {
        await Promise.all([loadCounselors(), onRefresh()]);
        setEditingCounselor(null);
        setCounselorNotice({ tone: "success", text: "辅导员资料已更新" });
      }} />}
    </main>
  );
}

function CounselorEditor({ counselor, onClose, onSaved }: { counselor: Counselor; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(counselor.name ?? "");
  const [dharmaName, setDharmaName] = useState(counselor.dharmaName ?? "");
  const [phone, setPhone] = useState(counselor.phone ?? "");
  const [username, setUsername] = useState(counselor.username ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault(); setLoading(true); setNotice(null);
    try {
      await apiJson(`/api/admin/counselors/${counselor.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), dharmaName: dharmaName.trim() || null, phone: phone.trim(), username: username.trim(), currentPassword })
      });
      await onSaved();
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  return <Modal title="编辑辅导员资料" subtitle="手机号可以留空；登录账号独立保存。" onClose={onClose}>
    <form className="form-stack" onSubmit={save}>
      <label>姓名（选填）<input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
      <label>法名（姓名与法名至少一项）<input value={dharmaName} onChange={(event) => setDharmaName(event.target.value)} /></label>
      <label>手机号（选填）<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" /></label>
      <label>登录账号<input value={username} onChange={(event) => setUsername(event.target.value)} autoCapitalize="none" required /></label>
      <label>管理员当前密码（修改手机号或登录账号时必填）<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" placeholder="登录信息不变时可以留空" /></label>
      <Notice notice={notice} />
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={loading}>{loading ? "保存中..." : "保存资料"}</button></div>
    </form>
  </Modal>;
}

function metricFromRaw(value: unknown): MetricSummary {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const applicable = Number(raw.applicable ?? raw.recorded ?? raw.denominator ?? raw.filled ?? raw.total ?? 0);
  const completed = Number(raw.completed ?? raw.numerator ?? raw.effective ?? 0);
  const rateRaw = raw.rate ?? raw.completionRate;
  return {
    completed,
    applicable,
    pending: Number(raw.pending ?? raw.unfilled ?? 0),
    rate: rateRaw == null ? (applicable ? completed / applicable : null) : Number(rateRaw)
  };
}

function metricsFromRaw(value: unknown): Record<Metric, MetricSummary> {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    outline: metricFromRaw(raw.outline ?? raw.outlineSummary),
    group_study: metricFromRaw(raw.group_study ?? raw.groupStudy ?? raw.groupStudySummary),
    class_study: metricFromRaw(raw.class_study ?? raw.classStudy ?? raw.classStudySummary)
  };
}

function reportFromRaw(payload: unknown, range: ReportRange): ReportPayload {
  const root = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const raw = ((root.report ?? root.data ?? root) || {}) as Record<string, unknown>;
  const classSummary = metricsFromRaw(raw.classSummary ?? raw.summary ?? raw.metrics);
  const groupSummaries = asList<Record<string, unknown>>(raw.groupSummaries ?? raw.groups ?? [], "groupSummaries", "groups").map((item) => ({
    groupId: Number(item.groupId ?? item.id),
    groupName: String(item.groupName ?? item.name ?? ""),
    metrics: metricsFromRaw(item.metrics ?? item.summary ?? item)
  }));
  const personalStats = asList<Record<string, unknown>>(raw.personalStats ?? raw.students ?? [], "personalStats", "students").map((item) => ({
    studentId: Number(item.studentId ?? item.id),
    name: String(item.name ?? ""),
    dharmaName: item.dharmaName == null ? null : String(item.dharmaName),
    groupName: String(item.groupName ?? ""),
    metrics: metricsFromRaw(item.metrics ?? item.summary ?? item)
  }));
  const attention = asList<Record<string, unknown>>(raw.attention ?? raw.riskStudents ?? [], "attention", "riskStudents").map((item) => ({
    studentId: Number(item.studentId ?? item.id),
    name: String(item.name ?? ""),
    groupName: String(item.groupName ?? ""),
    reasons: Array.isArray(item.reasons) ? item.reasons.map(String) : [String(item.reason ?? "近期班修需要关注")]
  }));
  const filtersRaw = (raw.filters && typeof raw.filters === "object" ? raw.filters : {}) as Record<string, unknown>;
  return {
    range,
    rangeLabel: raw.rangeLabel == null ? RANGE_LABELS[range] : String(raw.rangeLabel),
    filters: filtersRaw.from && filtersRaw.to ? { from: dateOnly(filtersRaw.from), to: dateOnly(filtersRaw.to) } : undefined,
    classSummary,
    groupSummaries,
    personalStats,
    attention,
    lessons: asList<Record<string, unknown>>(raw.lessons ?? [], "lessons", "items").map(lessonFromRaw)
  };
}

function MetricCard({ metric, summary, compact = false }: { metric: Metric; summary: MetricSummary; compact?: boolean }) {
  const icon = metric === "outline" ? <ListChecks size={19} /> : metric === "group_study" ? <Users size={19} /> : <BookOpenCheck size={19} />;
  return (
    <div className={`metric-card metric-${metric} ${compact ? "compact" : ""}`}>
      <div className="metric-card-head"><span className="metric-icon">{icon}</span><span>{METRIC_LABELS[metric]}</span></div>
      <strong>{formatRate(summary)}</strong>
      <div className="progress-track"><i style={{ width: `${summary.rate == null ? 0 : Math.min(100, summary.rate)}%` }} /></div>
      <small>{summary.completed}/{summary.applicable} 已完成 · {summary.pending} 待登记</small>
    </div>
  );
}

function OverviewPage({ currentClass }: { currentClass: ClassSummary }) {
  const { go } = useNavigation();
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<NoticeState>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const [reportData, lessonsData, studentsData] = await Promise.all([
        apiJson<unknown>(`/api/classes/${currentClass.id}/reports?range=recent`),
        apiJson<unknown>(`/api/classes/${currentClass.id}/lessons`),
        apiJson<unknown>(`/api/classes/${currentClass.id}/students`)
      ]);
      setReport(reportFromRaw(reportData, "recent"));
      setLessons(asList<Record<string, unknown>>(lessonsData, "lessons", "items").map(lessonFromRaw));
      setStudents(asList<Record<string, unknown>>(studentsData, "students", "items").map(studentFromRaw));
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally { setLoading(false); }
  }, [currentClass.id]);

  useEffect(() => { void load(); }, [load]);
  const currentLesson = lessons.find((item) => item.status === "current") ?? lessons.find((item) => !item.started) ?? lessons.at(-1);
  const activeStudents = students.filter((item) => item.active !== false);

  if (loading) return <main className="page"><Loading text="正在汇总班级数据..." /></main>;
  return (
    <main className="page">
      <PageHeader eyebrow="TODAY AT A GLANCE" title={`${currentClass.name}，欢迎回来`} description="这里是当前课次的完成情况与需要关注的事项。" actions={<button className="ghost" onClick={() => void load()}><RefreshCw size={16} /> 刷新</button>} />
      <Notice notice={notice} />
      <section className="hero-card">
        <div className="hero-copy">
          <span className="soft-badge blue">{currentLesson ? `第 ${currentLesson.lessonNumber} 课` : "尚未排课"}</span>
          <h2>{currentLesson?.title || "准备好后，从生成课表开始"}</h2>
          {currentLesson ? <p>班修截止：{currentLesson.classStudyDueDate || "待设置"} · {currentLesson.cadenceMode === "same_week" ? "同周完成" : "平行两周"}</p> : <p>{currentClass.sourceProgress ? `原表进度：${currentClass.sourceProgress}。` : "创建课表后，班长就可以按课次登记三项考勤。"}{currentClass.meetingTime ? ` 共修时间：${currentClass.meetingTime}。` : ""}</p>}
          <div className="hero-actions"><button className="primary" onClick={() => go("/attendance")} disabled={!currentLesson}><ClipboardCheck size={17} /> 去登记考勤</button><button className="glass-button" onClick={() => go("/lessons")}><CalendarDays size={17} /> 查看课表</button></div>
        </div>
        <div className="hero-art"><CloudSun size={68} /><span>{activeStudents.length}</span><small>在册学员</small></div>
      </section>
      <section>
        <div className="section-title"><div><h2>最近完成率</h2><p>三项指标独立统计，未填写不进入完成率分母。</p></div><button className="text-button" onClick={() => go("/reports")}>查看完整报表 →</button></div>
        <div className="metric-grid">
          {(["outline", "group_study", "class_study"] as Metric[]).map((metric) => <MetricCard key={metric} metric={metric} summary={report?.classSummary[metric] ?? metricFromRaw(null)} />)}
        </div>
      </section>
      <div className="content-grid two-thirds">
        <section className="panel">
          <div className="panel-head"><div><h2>小组进度</h2><p>快速发现还需要补登记的小组</p></div></div>
          {report?.groupSummaries.length ? <div className="group-progress-list">{report.groupSummaries.map((group) => (
            <div className="group-progress-row" key={group.groupId}>
              <strong>{group.groupName}</strong>
              {(["outline", "group_study", "class_study"] as Metric[]).map((metric) => <span key={metric}><small>{METRIC_LABELS[metric]}</small><b>{formatRate(group.metrics[metric])}</b></span>)}
            </div>
          ))}</div> : <EmptyState title="暂无统计" detail="完成第一笔考勤登记后，小组进度会显示在这里。" />}
        </section>
        <section className="panel attention-panel">
          <div className="panel-head"><div><h2>需要关注</h2><p>仅根据班修情况提示</p></div><AlertTriangle size={19} /></div>
          {report?.attention.length ? <div className="attention-list">{report.attention.slice(0, 5).map((item) => <div key={item.studentId}><div className="mini-avatar">{item.name.slice(0, 1)}</div><span><strong>{item.name}</strong><small>{item.groupName} · {item.reasons.join("；")}</small></span></div>)}</div> : <div className="all-good"><Check size={22} /><strong>目前没有预警</strong><span>大家的班修节奏很稳定</span></div>}
        </section>
      </div>
    </main>
  );
}

function StudentEditor({ classId, student, groups, isAdmin, onClose, onSaved }: { classId: number; student: Student | null; groups: Group[]; isAdmin: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(student?.legalName ?? student?.name ?? "");
  const [dharmaName, setDharmaName] = useState(student?.dharmaName ?? "");
  const [phone, setPhone] = useState(student?.phone ?? "");
  const [groupId, setGroupId] = useState(String(student?.groupId ?? groups[0]?.id ?? ""));
  const [note, setNote] = useState(student?.note ?? "");
  const [status, setStatus] = useState<EnrollmentStatus>(student?.status ?? "normal");
  const [identities, setIdentities] = useState<EnrollmentRole[]>(student?.identities?.filter((role) => !["monitor", "student"].includes(role)) ?? []);
  const [currentPassword, setCurrentPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true);
    try {
      await apiJson(`/api/classes/${classId}/students${student ? `/${student.id}` : ""}`, {
        method: student ? "PATCH" : "POST",
        body: JSON.stringify({ name: name.trim(), dharmaName: dharmaName.trim() || null, phone: phone.trim(), groupId: Number(groupId), note: note.trim() || null, status, identities, currentPassword })
      });
      await onSaved(); onClose();
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  return <Modal title={student ? "编辑学员" : "新增学员"} subtitle="新增和转组从下一课起生效，历史课次不会改变。" onClose={onClose}>
    <form className="form-stack" onSubmit={submit}>
      <div className="form-grid two"><label>姓名（选填）<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label><label>法名（姓名与法名至少一项）<input value={dharmaName} onChange={(e) => setDharmaName(e.target.value)} /></label></div>
      <label>手机号（选填）<input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="可暂不填写" /><small>普通学员可以留空；手机号填写后仍需保持全系统唯一。</small></label>
      {isAdmin && student && <label>管理员当前密码（修改登录手机号时必填）<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" placeholder="普通学员或手机号不变时可以留空" /><small>如果该学员同时是班长或辅导员，修改手机号会同步改变其登录账号。</small></label>}
      <label>所在小组<select value={groupId} onChange={(e) => setGroupId(e.target.value)} required>{groups.filter((g) => g.active !== false).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
      <label>学员状态<select value={status} onChange={(e) => setStatus(e.target.value as EnrollmentStatus)}><option value="normal">正常（参与完成率统计）</option><option value="leave">休学（暂不统计）</option><option value="withdrawn">退学（不再统计）</option></select><small>状态从下一课起生效，已开始课次和历史完成率不会改变。</small></label>
      <fieldset className="identity-field"><legend>班级身份（可多选）</legend><div className="checkbox-grid">{EDITABLE_ROLE_OPTIONS.map((option) => <label key={option.value}><input type="checkbox" checked={identities.includes(option.value)} onChange={(event) => setIdentities((current) => event.target.checked ? [...current, option.value] : current.filter((role) => role !== option.value))} /><span>{option.label}</span></label>)}</div><small>“学员”默认显示；“班长”与班级设置中的任命自动同步。每组只能设置一名组长。</small></fieldset>
      <label>备注（选填）<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="仅管理员和辅导员可见" /></label>
      <Notice notice={notice} />
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={loading}>{loading ? "保存中..." : "保存"}</button></div>
    </form>
  </Modal>;
}

function ImportStudents({ classId, onClose, onCommitted }: { classId: number; onClose: () => void; onCommitted: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  async function previewFile() {
    if (!file) return;
    setLoading(true); setNotice(null);
    const form = new FormData(); form.append("file", file);
    try {
      const raw = await apiJson<Record<string, unknown>>(`/api/classes/${classId}/import/preview`, { method: "POST", body: form });
      const source = ((raw.preview ?? raw.data ?? raw) || {}) as Record<string, unknown>;
      const rows = asList<Record<string, unknown>>(source.rows ?? source.students ?? [], "rows", "students").map((item, index) => ({
        rowNumber: Number(item.rowNumber ?? item.sourceRow ?? index + 2), name: String(item.name ?? ""),
        dharmaName: item.dharmaName == null ? null : String(item.dharmaName), phone: String(item.phone ?? ""),
        groupName: String(item.groupName ?? item.group ?? ""), note: item.note == null ? null : String(item.note),
        status: (item.status ?? "normal") as EnrollmentStatus,
        identities: Array.isArray(item.identities) ? item.identities.map(String) as EnrollmentRole[] : [],
        action: (item.action ?? "create") as ImportPreview["rows"][number]["action"], message: item.message == null ? undefined : String(item.message)
      }));
      setPreview({ token: source.token == null ? undefined : String(source.token), rows, summary: source.summary as ImportPreview["summary"] });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  async function commit() {
    if (!preview) return;
    setLoading(true);
    try {
      await apiJson(`/api/classes/${classId}/import/commit`, { method: "POST", body: JSON.stringify({ token: preview.token, rows: preview.rows }) });
      await onCommitted(); onClose();
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  const conflicts = preview?.rows.filter((row) => row.action === "conflict").length ?? 0;
  return <Modal title="从 Excel 导入学员" subtitle="模板列：姓名、法名、电话（可空）、小组、状态、身份、备注。提交前可先核对变化。" onClose={onClose} wide>
    <div className="form-stack">
      {!preview ? <>
        <div className="template-download"><div><strong>还没有模板？</strong><span>模板包含状态和可多选身份；班长仍需在班级设置中任命。</span></div><a className="secondary button" href={`/api/classes/${classId}/import/template.xlsx`} download><Download size={16} /> 下载模板</a></div>
        <label className="upload-zone">
          <input type="file" accept=".xlsx,.xls" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          <FileSpreadsheet size={34} />
          <strong>{file ? file.name : "选择 Excel 文件"}</strong>
          <span>支持 .xlsx / .xls，第一行需为字段名</span>
        </label>
        <Notice notice={notice} />
        <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button type="button" className="primary" onClick={() => void previewFile()} disabled={!file || loading}>{loading ? "解析中..." : "预览导入"}</button></div>
      </> : <>
        <div className="import-summary"><span className="create">新增 {preview.rows.filter((r) => r.action === "create").length}</span><span className="update">更新 {preview.rows.filter((r) => r.action === "update").length}</span><span>重复 / 不变 {preview.rows.filter((r) => r.action === "skip").length}</span><span className="conflict">冲突 {conflicts}</span></div>
        <div className="table-wrap compact-table"><table><thead><tr><th>行</th><th>姓名</th><th>电话</th><th>小组</th><th>状态</th><th>身份</th><th>处理</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.rowNumber} className={row.action === "conflict" ? "row-error" : ""}><td>{row.rowNumber}</td><td>{row.name}</td><td>{row.phone || "未填写"}</td><td>{row.groupName}</td><td>{ENROLLMENT_STATUS_LABELS[row.status]}</td><td>{row.identities.length ? row.identities.map((role) => ENROLLMENT_ROLE_LABELS[role]).join("、") : "学员"}</td><td><span className={`action-badge ${row.action}`}>{row.action === "create" ? "新增" : row.action === "update" ? "更新" : row.action === "skip" ? "跳过" : "冲突"}</span>{row.message && <small className="cell-note">{row.message}</small>}</td></tr>)}</tbody></table></div>
        <Notice notice={notice} />
        <div className="modal-actions split"><button type="button" className="ghost" onClick={() => setPreview(null)}>重新选择</button><span>{conflicts ? "请先修正文件中的冲突项" : "确认后将一次性写入名单"}</span><button type="button" className="primary" onClick={() => void commit()} disabled={conflicts > 0 || loading}>{loading ? "导入中..." : "确认导入"}</button></div>
      </>}
    </div>
  </Modal>;
}

function StudentsPage({ currentClass }: { currentClass: ClassSummary }) {
  const [students, setStudents] = useState<Student[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | EnrollmentStatus>("all");
  const [editing, setEditing] = useState<Student | "new" | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [studentData, groupData] = await Promise.all([
        apiJson<unknown>(`/api/classes/${currentClass.id}/students`),
        apiJson<unknown>(`/api/classes/${currentClass.id}/groups`)
      ]);
      setStudents(asList<Record<string, unknown>>(studentData, "students", "items").map(studentFromRaw));
      setGroups(asList<Record<string, unknown>>(groupData, "groups", "items").map(groupFromRaw));
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }, [currentClass.id]);
  useEffect(() => { void load(); }, [load]);

  const filtered = students.filter((student) => {
    if (groupFilter !== "all" && String(student.groupId) !== groupFilter) return false;
    if (statusFilter !== "all" && student.status !== statusFilter) return false;
    const keyword = search.trim().toLowerCase();
    return !keyword || [student.name, student.dharmaName, student.phone].some((value) => value?.toLowerCase().includes(keyword));
  });

  return <main className="page">
    <PageHeader eyebrow="ROSTER" title="学员名单" description="管理资料、状态和班级身份；只有正常状态参与完成率统计。" actions={<><button className="secondary" onClick={() => setImporting(true)}><Upload size={17} /> Excel 导入</button><button className="primary" onClick={() => setEditing("new")}><UserPlus size={17} /> 新增学员</button></>} />
    <Notice notice={notice} onClose={() => setNotice(null)} />
    <section className="panel">
      <div className="filter-bar"><label className="search-field"><span>搜索学员</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="姓名、法名或电话" /></label><label><span>小组</span><select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}><option value="all">全部小组</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label><label><span>状态</span><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "all" | EnrollmentStatus)}><option value="all">全部状态</option><option value="normal">正常</option><option value="leave">休学</option><option value="withdrawn">退学</option></select></label><div className="filter-count">共 <strong>{filtered.length}</strong> 人</div></div>
      {loading ? <Loading /> : filtered.length === 0 ? <EmptyState title="没有匹配的学员" detail="尝试调整筛选，或新增一位学员。" /> : <>
        <div className="table-wrap desktop-table"><table><thead><tr><th>学员</th><th>手机号</th><th>小组</th><th>身份</th><th>备注</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{filtered.map((student) => <tr key={student.id}><td><div className="person-cell"><div className="mini-avatar">{student.name.slice(0, 1)}</div><span><strong>{student.name}</strong><small>{student.dharmaName || "未填写法名"}</small></span></div></td><td>{student.phone || "—"}</td><td><span className="soft-badge">{student.groupName || groups.find((g) => g.id === student.groupId)?.name || "待分组"}</span></td><td><div className="identity-badges">{student.identities?.map((role) => <span key={role}>{ENROLLMENT_ROLE_LABELS[role]}</span>)}</div></td><td className="note-cell">{student.note || "—"}</td><td><span className={`student-status ${student.status ?? "normal"}`}>{ENROLLMENT_STATUS_LABELS[student.status ?? "normal"]}</span></td><td><button className="icon-button" title="编辑" onClick={() => setEditing(student)}><Pencil size={16} /></button></td></tr>)}</tbody></table></div>
        <div className="mobile-card-list">{filtered.map((student) => <article className="student-card" key={student.id}><div className="person-cell"><div className="mini-avatar large">{student.name.slice(0, 1)}</div><span><strong>{student.name}</strong><small>{student.dharmaName || "未填写法名"}</small></span><span className={`student-status ${student.status ?? "normal"}`}>{ENROLLMENT_STATUS_LABELS[student.status ?? "normal"]}</span></div><div className="identity-badges">{student.identities?.map((role) => <span key={role}>{ENROLLMENT_ROLE_LABELS[role]}</span>)}</div><dl><div><dt>小组</dt><dd>{student.groupName || groups.find((g) => g.id === student.groupId)?.name || "待分组"}</dd></div><div><dt>电话</dt><dd>{student.phone || "—"}</dd></div><div><dt>备注</dt><dd>{student.note || "—"}</dd></div></dl><div className="card-actions"><button className="secondary" onClick={() => setEditing(student)}><Pencil size={15} /> 编辑状态与资料</button></div></article>)}</div>
      </>}
    </section>
    {editing && <StudentEditor classId={currentClass.id} student={editing === "new" ? null : editing} groups={groups} isAdmin={currentClass.permission === "admin"} onClose={() => setEditing(null)} onSaved={load} />}
    {importing && <ImportStudents classId={currentClass.id} onClose={() => setImporting(false)} onCommitted={load} />}
  </main>;
}

function GroupsPage({ currentClass, onClassRefresh }: { currentClass: ClassSummary; onClassRefresh: () => Promise<void> }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [desiredCount, setDesiredCount] = useState(3);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [groupData, studentData] = await Promise.all([
        apiJson<unknown>(`/api/classes/${currentClass.id}/groups`),
        apiJson<unknown>(`/api/classes/${currentClass.id}/students`)
      ]);
      const nextGroups = asList<Record<string, unknown>>(groupData, "groups", "items").map(groupFromRaw).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      setGroups(nextGroups);
      setDesiredCount(nextGroups.filter((g) => g.active !== false).length || 1);
      setStudents(asList<Record<string, unknown>>(studentData, "students", "items").map(studentFromRaw));
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }, [currentClass.id]);
  useEffect(() => { void load(); }, [load]);

  async function saveName(group: Group) {
    if (!editingName.trim()) return;
    try {
      await apiJson(`/api/classes/${currentClass.id}/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ name: editingName.trim() }) });
      setEditingId(null); setNotice({ tone: "success", text: "小组名称已修改" }); await load();
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
  }

  async function changeCount() {
    const activeGroups = groups.filter((g) => g.active !== false);
    if (desiredCount === activeGroups.length) return;
    if (desiredCount < activeGroups.length) {
      const removed = activeGroups.slice(desiredCount);
      const occupied = removed.filter((group) => students.some((s) => s.status !== "withdrawn" && s.groupId === group.id));
      if (occupied.length) {
        setNotice({ tone: "error", text: `请先把 ${occupied.map((g) => g.name).join("、")} 的学员转入保留小组，再减少组数` });
        return;
      }
      if (!window.confirm(`将停用最后 ${activeGroups.length - desiredCount} 个小组，历史数据仍会保留。确定继续吗？`)) return;
    }
    try {
      await apiJson(`/api/classes/${currentClass.id}`, { method: "PATCH", body: JSON.stringify({ groupCount: desiredCount }) });
      setNotice({ tone: "success", text: `小组数量已调整为 ${desiredCount} 组` });
      await Promise.all([load(), onClassRefresh()]);
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
  }

  return <main className="page">
    <PageHeader eyebrow="GROUPS" title="小组管理" description="班级可设置 1–5 个小组；改名不会影响历史统计。" />
    <Notice notice={notice} onClose={() => setNotice(null)} />
    <section className="panel group-count-panel">
      <div><span className="panel-icon"><GraduationCap size={21} /></span><div><h2>小组数量</h2><p>减少小组前，请先在学员名单中完成转组。</p></div></div>
      <div className="inline-control"><select value={desiredCount} onChange={(e) => setDesiredCount(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count} 个小组</option>)}</select><button className="primary" onClick={() => void changeCount()} disabled={loading || desiredCount === groups.filter((g) => g.active !== false).length}>应用</button></div>
    </section>
    {loading ? <Loading /> : <section className="group-card-grid">{groups.filter((group) => group.active !== false).map((group, index) => {
      const members = students.filter((student) => student.status !== "withdrawn" && student.groupId === group.id);
      return <article className="group-card" key={group.id}>
        <div className={`group-number color-${index % 5}`}>{index + 1}</div>
        <div className="group-title-edit">
          {editingId === group.id ? <><input value={editingName} onChange={(e) => setEditingName(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && void saveName(group)} /><button className="icon-button primary-icon" onClick={() => void saveName(group)}><Check size={16} /></button><button className="icon-button" onClick={() => setEditingId(null)}><X size={16} /></button></> : <><h2>{group.name}</h2><button className="icon-button" onClick={() => { setEditingId(group.id); setEditingName(group.name); }}><Pencil size={15} /></button></>}
        </div>
        <p>{members.length} 位在册学员</p>
        <div className="member-chips">{members.slice(0, 8).map((member) => <span key={member.id}>{member.name}</span>)}{members.length > 8 && <span>+{members.length - 8}</span>}{members.length === 0 && <small>这个小组还没有学员</small>}</div>
      </article>;
    })}</section>}
    <section className="info-strip"><Sparkles size={19} /><div><strong>历史归属会被保留</strong><span>已开始的课次使用当时的名单和组别快照。转组、停用或减少小组都不会反向改变历史完成率。</span></div></section>
  </main>;
}

function LessonEditor({ classId, lesson, onClose, onSaved }: { classId: number; lesson: Lesson; onClose: () => void; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState(lesson.title);
  const [lessonType, setLessonType] = useState(lesson.lessonType);
  const [classStudyDueDate, setClassDate] = useState(lesson.classStudyDueDate);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true);
    try {
      await apiJson(`/api/classes/${classId}/lessons/${lesson.id}`, { method: "PATCH", body: JSON.stringify({ title, lessonType, classStudyDueDate }) });
      await onSaved(); onClose();
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }
  return <Modal title={`编辑第 ${lesson.lessonNumber} 个课次`} subtitle="这里只修改现有课次；修改日期会让本课及后续未开始的安排整体顺延。" onClose={onClose}>
    <form className="form-stack" onSubmit={submit}>
      <label>课次名称<input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
      <label>课次类型<select value={lessonType} onChange={(e) => setLessonType(e.target.value as Lesson["lessonType"])}><option value="regular">普通课</option><option value="review">复习课（导图/提纲自动不需要）</option></select></label>
      <div className="auto-date-preview"><span><small>当前导图/提纲日期</small>{lesson.lessonType === "review" ? "不需要" : lesson.outlineDueDate}</span><span><small>当前组修日期</small>{lesson.groupStudyDueDate}</span></div>
      <label>班修 / 整课截止日<input type="date" lang="zh-CN" value={classStudyDueDate} onChange={(e) => setClassDate(e.target.value)} required /><small>已选择：{classStudyDueDate || "未选择"}（YYYY-MM-DD）。导图/提纲与组修日期会自动计算。</small></label>
      <Notice notice={notice} />
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={loading}>{loading ? "保存中..." : "保存修改并顺延"}</button></div>
    </form>
  </Modal>;
}

type CourseSeriesOption = { key: string; displayName: string; syncedAt?: string | null; items: Array<{ position: number; title: string; lessonType: string }> };

function InsertLesson({ classId, lessons, seriesKey, onClose, onSaved }: {
  classId: number;
  lessons: Lesson[];
  seriesKey?: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const futureLessons = lessons.filter((lesson) => !lesson.started);
  const [beforeLessonId, setBeforeLessonId] = useState(String(futureLessons[0]?.id ?? ""));
  const target = futureLessons.find((lesson) => String(lesson.id) === beforeLessonId) ?? futureLessons[0];
  const [catalog, setCatalog] = useState<CourseSeriesOption[]>([]);
  const [coursePosition, setCoursePosition] = useState("");
  const [title, setTitle] = useState("");
  const [lessonType, setLessonType] = useState<Lesson["lessonType"]>("regular");
  const [classStudyDueDate, setClassStudyDueDate] = useState(target?.classStudyDueDate ?? "");
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void apiJson<unknown>("/api/course-catalog").then((data) => {
      setCatalog(asList<Record<string, unknown>>(data, "series", "items").map((entry) => ({
        key: String(entry.key), displayName: String(entry.displayName), syncedAt: entry.syncedAt == null ? null : String(entry.syncedAt),
        items: asList<Record<string, unknown>>(entry.items, "items").map((item) => ({ position: Number(item.position), title: String(item.title), lessonType: String(item.lessonType) }))
      })));
    }).catch((error) => setNotice({ tone: "error", text: errorText(error) }));
  }, []);

  const series = catalog.find((entry) => entry.key === seriesKey);
  function chooseCatalogItem(value: string) {
    setCoursePosition(value);
    if (!value) return;
    const item = series?.items.find((entry) => String(entry.position) === value);
    if (item) {
      setTitle(item.title);
      setLessonType(item.lessonType as Lesson["lessonType"]);
    }
  }
  function chooseTarget(value: string) {
    setBeforeLessonId(value);
    const nextTarget = futureLessons.find((lesson) => String(lesson.id) === value);
    if (nextTarget) setClassStudyDueDate(nextTarget.classStudyDueDate);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    setLoading(true); setNotice(null);
    try {
      await apiJson(`/api/classes/${classId}/lessons/insert`, {
        method: "POST",
        body: JSON.stringify({
          beforeLessonId: target.id,
          title,
          lessonType,
          classStudyDueDate,
          coursePosition: coursePosition ? Number(coursePosition) : null
        })
      });
      await onSaved(); onClose();
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  return <Modal title="插入课次" subtitle="新增一个真正的课次，原插入位置及后续安排会整体后移。" onClose={onClose}>
    {!target ? <EmptyState title="没有可插入的位置" detail="所有课次都已开始，不能在历史课表中插入。" /> : <form className="form-stack" onSubmit={submit}>
      <label>插入位置<select value={beforeLessonId} onChange={(event) => chooseTarget(event.target.value)}>{futureLessons.map((lesson) => <option key={lesson.id} value={lesson.id}>第 {lesson.lessonNumber} 个课次之前 · {lesson.title}</option>)}</select><small>插入后，新课成为第 {target.lessonNumber} 个课次，原第 {target.lessonNumber} 个及后续课次依次后移。</small></label>
      {series && <label>从“{series.displayName}”课程目录选择（选填）<select value={coursePosition} onChange={(event) => chooseCatalogItem(event.target.value)}><option value="">自定义课次</option>{series.items.map((item) => <option key={item.position} value={item.position}>{item.title}</option>)}</select></label>}
      <label>课次名称<input value={title} onChange={(event) => { setTitle(event.target.value); setCoursePosition(""); }} required /></label>
      <label>课次类型<select value={lessonType} onChange={(event) => { setLessonType(event.target.value as Lesson["lessonType"]); setCoursePosition(""); }}><option value="regular">普通课</option><option value="review">复习课（导图/提纲自动不需要）</option></select></label>
      <label>班修 / 整课截止日<input type="date" lang="zh-CN" value={classStudyDueDate} onChange={(event) => setClassStudyDueDate(event.target.value)} required /><small>已选择：{classStudyDueDate || "未选择"}（YYYY-MM-DD）。固定的放假/暂停周仍会保留。</small></label>
      <Notice notice={notice} />
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={loading || !title.trim()}>{loading ? "插入中..." : "插入课次并顺延"}</button></div>
    </form>}
  </Modal>;
}

function RebuildFutureSchedule({ classId, lessons, currentClass, canSync, onClose, onSaved }: {
  classId: number;
  lessons: Lesson[];
  currentClass: ClassSummary;
  canSync: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const futureLessons = lessons.filter((lesson) => !lesson.started);
  const preservedCount = lessons.length - futureLessons.length;
  const [firstDueDate, setFirstDueDate] = useState(futureLessons[0]?.classStudyDueDate ?? "");
  const [count, setCount] = useState(futureLessons.length || 24);
  const [cadenceMode, setCadenceMode] = useState<CadenceMode>(currentClass.cadenceMode ?? "same_week");
  const [series, setSeries] = useState<CourseSeriesOption[]>([]);
  const [seriesKey, setSeriesKey] = useState(currentClass.courseSeriesKey ?? "wisdom_life");
  const [startPosition, setStartPosition] = useState(futureLessons[0]?.coursePosition ?? ((currentClass.courseStartPosition ?? 1) + preservedCount));
  const [round, setRound] = useState(currentClass.courseRound ?? 1);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(false);
  const loadCatalog = useCallback(async () => {
    const data = await apiJson<unknown>("/api/course-catalog");
    const options = asList<Record<string, unknown>>(data, "series", "items").map((entry) => ({
      key: String(entry.key), displayName: String(entry.displayName), syncedAt: entry.syncedAt == null ? null : String(entry.syncedAt),
      items: asList<Record<string, unknown>>(entry.items, "items").map((item) => ({ position: Number(item.position), title: String(item.title), lessonType: String(item.lessonType) }))
    }));
    setSeries(options);
    if (options.length) setSeriesKey((current) => options.some((entry) => entry.key === current) ? current : options[0].key);
  }, []);
  useEffect(() => { void loadCatalog().catch((error) => setNotice({ tone: "error", text: errorText(error) })); }, [loadCatalog]);
  async function syncCatalog() {
    setLoading(true); setNotice(null);
    try {
      const result = await apiJson<{ seriesCount: number; itemCount: number }>("/api/admin/course-catalog/sync", { method: "POST" });
      await loadCatalog();
      setNotice({ tone: "success", text: `官方课程目录已更新：${result.seriesCount} 个体系，${result.itemCount} 个课次。` });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!futureLessons.length) return;
    if (!window.confirm(`将保留 ${preservedCount} 个已开始课次，替换 ${futureLessons.length} 个未来课次，并生成 ${count} 个新课次。确定继续吗？`)) return;
    setLoading(true); setNotice(null);
    try {
      await apiJson(`/api/classes/${classId}/schedule/rebuild-future`, {
        method: "POST",
        body: JSON.stringify({ firstClassStudyDueDate: firstDueDate, count, cadenceMode, seriesKey, startPosition, round })
      });
      await onSaved(); onClose();
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }
  const selectedSeries = series.find((entry) => entry.key === seriesKey);

  return <Modal title="重新生成未来课表" subtitle="历史课次和已有考勤不会被改动，只替换尚未开始的安排。" onClose={onClose}>
    {!futureLessons.length ? <EmptyState title="没有可重新生成的课次" detail="当前课表中的课次都已开始；请使用追加课次功能。" /> : <form className="form-stack" onSubmit={submit}>
      <div className="callout"><strong>变更预览</strong><span>保留 {preservedCount} 个已开始课次 · 替换 {futureLessons.length} 个未来课次 · 新生成 {count} 个课次</span></div>
      <div className="form-grid two"><label>课程体系<select value={seriesKey} onChange={(event) => { setSeriesKey(event.target.value); setStartPosition(1); }}>{series.map((entry) => <option value={entry.key} key={entry.key}>{entry.displayName}</option>)}</select></label><label>第几遍<input type="number" min={1} max={20} value={round} onChange={(event) => setRound(Number(event.target.value))} /></label></div>
      <label>从哪一课开始<select value={startPosition} onChange={(event) => setStartPosition(Number(event.target.value))}>{selectedSeries?.items.map((item) => <option key={item.position} value={item.position}>{item.title}</option>)}</select></label>
      {canSync && <div className="template-download"><div><strong>需要采用最新课程时</strong><span>先刷新目录，再选择新的课程起点。</span></div><button type="button" className="secondary" onClick={() => void syncCatalog()} disabled={loading}><RefreshCw size={16} /> 刷新目录</button></div>}
      <label>第一个新课次班修 / 整课截止日<input type="date" lang="zh-CN" value={firstDueDate} onChange={(event) => setFirstDueDate(event.target.value)} required /><small>已选择：{firstDueDate || "未选择"}（YYYY-MM-DD）。原有放假/暂停周继续保留。</small></label>
      <div className="form-grid two"><label>生成课数<input type="number" min={1} max={100} value={count} onChange={(event) => setCount(Number(event.target.value))} required /></label><label>学习模式<select value={cadenceMode} onChange={(event) => setCadenceMode(event.target.value as CadenceMode)}><option value="same_week">同周完成</option><option value="parallel_two_week">平行两周</option></select></label></div>
      <Notice notice={notice} />
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={loading}>{loading ? "重新生成中..." : "重新生成未来课表"}</button></div>
    </form>}
  </Modal>;
}

function GenerateSchedule({ classId, defaultMode, hasLessons, canSync, defaultSeriesKey, defaultRound, defaultStartPosition, sourceProgress, onClose, onSaved }: { classId: number; defaultMode: CadenceMode; hasLessons: boolean; canSync: boolean; defaultSeriesKey?: string | null; defaultRound?: number; defaultStartPosition?: number; sourceProgress?: string | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [firstDueDate, setFirstDueDate] = useState("");
  const [count, setCount] = useState(hasLessons ? 24 : 50);
  const [cadenceMode, setCadenceMode] = useState<CadenceMode>(defaultMode);
  const [series, setSeries] = useState<CourseSeriesOption[]>([]);
  const [seriesKey, setSeriesKey] = useState(defaultSeriesKey ?? "wisdom_life");
  const [startPosition, setStartPosition] = useState(defaultStartPosition ?? 1);
  const [round, setRound] = useState(defaultRound ?? 1);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(false);
  const loadCatalog = useCallback(async () => {
    const data = await apiJson<unknown>("/api/course-catalog");
    const options = asList<Record<string, unknown>>(data, "series", "items").map((entry) => ({
      key: String(entry.key), displayName: String(entry.displayName), syncedAt: entry.syncedAt == null ? null : String(entry.syncedAt),
      items: asList<Record<string, unknown>>(entry.items, "items").map((item) => ({ position: Number(item.position), title: String(item.title), lessonType: String(item.lessonType) }))
    }));
    setSeries(options);
    if (options.length) setSeriesKey((current) => options.some((entry) => entry.key === current) ? current : options[0].key);
  }, []);
  useEffect(() => { if (!hasLessons) void loadCatalog().catch((error) => setNotice({ tone: "error", text: errorText(error) })); }, [hasLessons, loadCatalog]);

  async function syncCatalog() {
    setLoading(true); setNotice(null);
    try {
      const result = await apiJson<{ seriesCount: number; itemCount: number }>("/api/admin/course-catalog/sync", { method: "POST" });
      await loadCatalog();
      setNotice({ tone: "success", text: `官方课程目录已更新：${result.seriesCount} 个体系，${result.itemCount} 个课次。` });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true);
    try {
      await apiJson(hasLessons ? `/api/classes/${classId}/lessons/append` : `/api/classes/${classId}/schedule/generate`, { method: "POST", body: JSON.stringify({ firstClassStudyDueDate: firstDueDate, count, cadenceMode, seriesKey, startPosition, round }) });
      await onSaved(); onClose();
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }
  const selectedSeries = series.find((entry) => entry.key === seriesKey);
  return <Modal title={hasLessons ? "追加课次" : "生成学习课表"} subtitle={hasLessons ? "从现有最后一个课次继续，自动接着当前课程体系排期。" : "选择课程体系、遍数和起始课；复习课会自动识别。"} onClose={onClose}>
    <form className="form-stack" onSubmit={submit}>
      {!hasLessons && <><div className="form-grid two"><label>课程体系<select value={seriesKey} onChange={(event) => { setSeriesKey(event.target.value); setStartPosition(1); }}>{series.map((entry) => <option value={entry.key} key={entry.key}>{entry.displayName}</option>)}</select></label><label>第几遍<input type="number" min={1} max={20} value={round} onChange={(event) => setRound(Number(event.target.value))} /></label></div>
      {sourceProgress && <div className="callout"><strong>原表课程进度</strong><span>{sourceProgress}</span></div>}
      <label>从哪一课开始<select value={startPosition} onChange={(event) => setStartPosition(Number(event.target.value))}>{selectedSeries?.items.map((item) => <option key={item.position} value={item.position}>{item.title}</option>)}</select><small>起点之前的课不会生成，也不会进入完成率统计。</small></label>
      {canSync && <div className="template-download"><div><strong>官方课程目录快照</strong><span>只在手工刷新时读取官网，日常排课使用本地快照。</span></div><button type="button" className="secondary" onClick={() => void syncCatalog()} disabled={loading}><RefreshCw size={16} /> 刷新目录</button></div>}</>}
      {!hasLessons && <label>第一课班修 / 整课截止日<input type="date" lang="zh-CN" value={firstDueDate} onChange={(e) => setFirstDueDate(e.target.value)} required /><small>已选择：{firstDueDate || "未选择"}（YYYY-MM-DD）</small></label>}
      <div className="form-grid two"><label>{hasLessons ? "追加课数" : "预排课数"}<input type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.target.value))} required /></label><label>学习模式<select value={cadenceMode} onChange={(e) => setCadenceMode(e.target.value as CadenceMode)} disabled={hasLessons}><option value="same_week">同周完成</option><option value="parallel_two_week">平行两周</option></select>{hasLessons && <small>如需改变学习模式，请先在班级设置中修改。</small>}</label></div>
      <div className="callout"><strong>{cadenceMode === "same_week" ? "每周一课" : "每两周一课"}</strong><span>{cadenceMode === "same_week" ? "导图/提纲、组修、班修在同一周完成。" : "第一周完成导图/提纲和组修，第二周完成班修。"}</span></div>
      <Notice notice={notice} />
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={loading}>{loading ? "生成中..." : `生成 ${count} 课`}</button></div>
    </form>
  </Modal>;
}

function AddBreak({ classId, onClose, onSaved }: { classId: number; onClose: () => void; onSaved: () => Promise<void> }) {
  const [date, setDate] = useState("");
  const [title, setTitle] = useState("放假 / 暂停");
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true);
    try {
      await apiJson(`/api/classes/${classId}/breaks`, { method: "POST", body: JSON.stringify({ date, title, reason: title }) });
      await onSaved(); onClose();
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }
  return <Modal title="插入放假 / 暂停周" subtitle="该周不考勤、不统计，后续未开始课次会整体顺延一周。" onClose={onClose}>
    <form className="form-stack" onSubmit={submit}><label>暂停周日期<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label><label>说明<input value={title} onChange={(e) => setTitle(e.target.value)} required /></label><Notice notice={notice} /><div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={loading}>{loading ? "插入中..." : "插入并顺延"}</button></div></form>
  </Modal>;
}

function LessonsPage({ currentClass, isAdmin, onClassRefresh }: { currentClass: ClassSummary; isAdmin: boolean; onClassRefresh: () => Promise<void> }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [breaks, setBreaks] = useState<Array<{ id: number; date: string; title: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showRebuild, setShowRebuild] = useState(false);
  const [showInsert, setShowInsert] = useState(false);
  const [showBreak, setShowBreak] = useState(false);
  const [editing, setEditing] = useState<Lesson | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [lessonData, breakData] = await Promise.all([
        apiJson<unknown>(`/api/classes/${currentClass.id}/lessons`),
        apiJson<unknown>(`/api/classes/${currentClass.id}/breaks`).catch(() => ({ breaks: [] }))
      ]);
      setLessons(asList<Record<string, unknown>>(lessonData, "lessons", "items").map(lessonFromRaw));
      setBreaks(asList<Record<string, unknown>>(breakData, "breaks", "items").map((item) => ({ id: Number(item.id), date: dateOnly(item.date), title: String(item.title ?? item.reason ?? "放假 / 暂停") })));
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }, [currentClass.id]);
  useEffect(() => { void load(); }, [load]);
  const reloadScheduleAndClass = useCallback(async () => { await Promise.all([load(), onClassRefresh()]); }, [load, onClassRefresh]);

  const timeline = useMemo(() => [
    ...lessons.map((lesson) => ({ type: "lesson" as const, date: lesson.classStudyDueDate, lesson })),
    ...breaks.map((item) => ({ type: "break" as const, date: item.date, breakItem: item }))
  ].sort((a, b) => a.date.localeCompare(b.date)), [lessons, breaks]);

  return <main className="page">
    <PageHeader eyebrow="SCHEDULE" title="课表安排" description="编辑、插入、追加或重新生成未来课次；已开始的历史安排不会被覆盖。" actions={<>{lessons.length > 0 && <><button className="secondary" onClick={() => setShowBreak(true)}><CloudSun size={17} /> 放假 / 暂停周</button><button className="secondary" onClick={() => setShowInsert(true)} disabled={!lessons.some((lesson) => !lesson.started)}><Plus size={17} /> 插入课次</button><button className="secondary" onClick={() => setShowRebuild(true)} disabled={!lessons.some((lesson) => !lesson.started)}><RefreshCw size={17} /> 重新生成未来课表</button></>}<button className="primary" onClick={() => setShowGenerate(true)}><CalendarDays size={17} /> {lessons.length ? "追加课次" : "生成课表"}</button></>} />
    <Notice notice={notice} onClose={() => setNotice(null)} />
    {loading ? <Loading text="正在读取课表..." /> : timeline.length === 0 ? <EmptyState icon={<CalendarDays size={28} />} title="还没有课表" detail="请选择课程体系、起始课和第一课截止日，再生成学习课表。" action={<button className="primary" onClick={() => setShowGenerate(true)}>生成课表</button>} /> : <section className="panel schedule-panel">
      <div className="schedule-legend"><span><i className="dot current" /> 当前 / 近期</span><span><i className="dot future" /> 未开始</span><span><i className="dot review" /> 复习课</span><span><i className="dot break" /> 暂停周</span></div>
      <div className="schedule-list">{timeline.map((entry) => entry.type === "break" ? <article className="schedule-break" key={`break-${entry.breakItem.id}`}><div className="timeline-node"><CloudSun size={17} /></div><div><strong>{entry.breakItem.title}</strong><span>{entry.breakItem.date} · 本周不考勤，后续课表已顺延</span></div></article> : <article className={`schedule-row ${entry.lesson.status ?? (entry.lesson.started ? "finished" : "future")}`} key={entry.lesson.id}><div className="timeline-node">{entry.lesson.lessonNumber}</div><div className="schedule-main"><div><strong>{entry.lesson.title}</strong><span className={`lesson-type ${entry.lesson.lessonType}`}>{entry.lesson.lessonType === "review" ? "复习课" : "普通课"}</span></div><small>第 {entry.lesson.lessonNumber} 个课次 · {entry.lesson.cadenceMode === "same_week" ? "同周完成" : "平行两周"}</small></div><div className="lesson-dates"><span><small>导图/提纲</small>{entry.lesson.lessonType === "review" ? "不需要" : entry.lesson.outlineDueDate}</span><span><small>组修</small>{entry.lesson.groupStudyDueDate}</span><span><small>班修</small>{entry.lesson.classStudyDueDate}</span></div><button className="icon-button" aria-label={entry.lesson.started ? `第 ${entry.lesson.lessonNumber} 个课次已开始，不可编辑` : `编辑第 ${entry.lesson.lessonNumber} 个课次`} onClick={() => setEditing(entry.lesson)} disabled={entry.lesson.started} title={entry.lesson.started ? "已开始课次不可改期" : "编辑现有课次"}><Pencil size={16} /></button></article>)}</div>
    </section>}
    {showGenerate && <GenerateSchedule classId={currentClass.id} defaultMode={currentClass.cadenceMode ?? "same_week"} hasLessons={lessons.length > 0} canSync={isAdmin} defaultSeriesKey={currentClass.courseSeriesKey} defaultRound={currentClass.courseRound} defaultStartPosition={currentClass.courseStartPosition} sourceProgress={currentClass.sourceProgress} onClose={() => setShowGenerate(false)} onSaved={reloadScheduleAndClass} />}
    {showRebuild && <RebuildFutureSchedule classId={currentClass.id} lessons={lessons} currentClass={currentClass} canSync={isAdmin} onClose={() => setShowRebuild(false)} onSaved={reloadScheduleAndClass} />}
    {showInsert && <InsertLesson classId={currentClass.id} lessons={lessons} seriesKey={currentClass.courseSeriesKey} onClose={() => setShowInsert(false)} onSaved={reloadScheduleAndClass} />}
    {showBreak && <AddBreak classId={currentClass.id} onClose={() => setShowBreak(false)} onSaved={load} />}
    {editing && <LessonEditor classId={currentClass.id} lesson={editing} onClose={() => setEditing(null)} onSaved={load} />}
  </main>;
}

function SettingsPage({ user, currentClass, onRefresh }: { user: CurrentUser; currentClass: ClassSummary; onRefresh: () => Promise<void> }) {
  const { go } = useNavigation();
  const [name, setName] = useState(currentClass.name);
  const [meetingTime, setMeetingTime] = useState(currentClass.meetingTime ?? "");
  const [sourceProgress, setSourceProgress] = useState(currentClass.sourceProgress ?? "");
  const [cadenceMode, setCadenceMode] = useState<CadenceMode>(currentClass.cadenceMode ?? "same_week");
  const [counselorId, setCounselorId] = useState(String(currentClass.counselorId ?? ""));
  const [monitorId, setMonitorId] = useState(String(currentClass.monitorId ?? ""));
  const [monitorUsername, setMonitorUsername] = useState("");
  const [students, setStudents] = useState<Student[]>([]);
  const [counselors, setCounselors] = useState<Counselor[]>([]);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setName(currentClass.name); setMeetingTime(currentClass.meetingTime ?? ""); setSourceProgress(currentClass.sourceProgress ?? ""); setCadenceMode(currentClass.cadenceMode ?? "same_week"); setCounselorId(String(currentClass.counselorId ?? "")); setMonitorId(String(currentClass.monitorId ?? ""));
    void Promise.all([
      apiJson<unknown>(`/api/classes/${currentClass.id}/students`).then((data) => setStudents(asList<Record<string, unknown>>(data, "students", "items").map(studentFromRaw))),
      user.isAdmin ? apiJson<unknown>("/api/admin/counselors").then((data) => setCounselors(asList<Record<string, unknown>>(data, "counselors", "items").map((raw) => ({ id: Number(raw.id ?? raw.accountId), displayName: String(raw.displayName ?? raw.name), phone: raw.phone == null ? null : String(raw.phone), username: raw.username == null ? null : String(raw.username), active: raw.active == null ? true : Boolean(raw.active) })))) : Promise.resolve()
    ]).catch((error) => setNotice({ tone: "error", text: errorText(error) }));
  }, [currentClass, user.isAdmin]);

  async function saveClass(event: FormEvent) {
    event.preventDefault(); setLoading(true);
    try {
      await apiJson(`/api/classes/${currentClass.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim(), meetingTime: meetingTime.trim(), sourceProgress: sourceProgress.trim(), cadenceMode, ...(user.isAdmin ? { counselorId: Number(counselorId) } : {}) }) });
      await onRefresh(); setNotice({ tone: "success", text: "班级设置已保存；学习模式从下一课起生效" });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  async function assignMonitor() {
    setLoading(true);
    try {
      const result = await apiJson<Record<string, unknown>>(`/api/classes/${currentClass.id}/monitor`, { method: "PUT", body: JSON.stringify({ studentId: monitorId ? Number(monitorId) : null, username: monitorUsername.trim() || undefined }) });
      const temporaryPassword = String(result.temporaryPassword ?? (result.account as Record<string, unknown> | undefined)?.temporaryPassword ?? "");
      const loginIdentifier = String(result.loginIdentifier ?? result.username ?? "");
      await onRefresh();
      setNotice({ tone: "success", text: temporaryPassword ? `班长已设置：登录账号 ${loginIdentifier}，临时密码 ${temporaryPassword}` : monitorId ? `班长已设置，登录账号 ${loginIdentifier}，新权限立即生效` : "班长已取消" });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  async function cancelMonitor() {
    if (!window.confirm(`确定取消“${currentClass.monitorName || "当前班长"}”的班长权限吗？取消后会立即停止访问本班。`)) return;
    setLoading(true);
    try {
      await apiJson(`/api/classes/${currentClass.id}/monitor`, { method: "DELETE" });
      setMonitorId("");
      await onRefresh();
      setNotice({ tone: "success", text: "班长权限已取消，原班长已立即停止访问本班" });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  async function resetMonitorPassword() {
    if (!window.confirm(`确定为“${currentClass.monitorName || "当前班长"}”生成新的临时密码吗？`)) return;
    setLoading(true);
    try {
      const result = await apiJson<{ temporaryPassword: string }>(`/api/classes/${currentClass.id}/monitor/reset-password`, { method: "POST" });
      setNotice({ tone: "success", text: `班长临时密码已重置：${result.temporaryPassword}；首次登录必须修改。` });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  async function toggleClassStatus() {
    const restoring = Boolean(currentClass.archived);
    if (!window.confirm(restoring ? `确定恢复“${currentClass.name}”吗？` : `确定停用“${currentClass.name}”吗？班长将停止访问，历史数据仍会保留。`)) return;
    setLoading(true);
    try {
      await apiJson(`/api/classes/${currentClass.id}`, { method: "PATCH", body: JSON.stringify({ archived: !restoring }) });
      await onRefresh();
      if (!restoring) go("/classes");
      else setNotice({ tone: "success", text: "班级已恢复正常使用" });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }

  return <main className="page">
    <PageHeader eyebrow="CLASS SETTINGS" title="班级设置" description="修改班级名称、下一课学习模式和负责人。" />
    <Notice notice={notice} onClose={() => setNotice(null)} />
    <div className="settings-grid">
      <form className="panel form-stack" onSubmit={saveClass}>
        <div className="panel-head"><div><h2>基本信息</h2><p>名称修改后会立即显示在所有人的班级切换器中。</p></div><Settings size={20} /></div>
        <label>班级名称<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>固定共修时间（选填）<input value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} placeholder="例如：每周二 19:00–21:00" /></label>
        <label>导入课程进度备注（选填）<input value={sourceProgress} onChange={(e) => setSourceProgress(e.target.value)} placeholder="用于提醒辅导员选择准确起始课" /></label>
        <label>下一课起的学习模式<select value={cadenceMode} onChange={(e) => setCadenceMode(e.target.value as CadenceMode)}><option value="same_week">同周完成（默认）</option><option value="parallel_two_week">平行两周</option></select></label>
        {user.isAdmin && <label>班级辅导员<select value={counselorId} onChange={(e) => setCounselorId(e.target.value)} required><option value="">请选择辅导员</option>{counselors.filter((c) => c.active !== false).map((c) => <option key={c.id} value={c.id}>{c.displayName} · {c.phone || c.username}</option>)}</select><small>更换后，原辅导员立即失去本班权限。</small></label>}
        <button className="primary align-start" disabled={loading}><Save size={17} /> 保存基本设置</button>
      </form>
      <section className="panel form-stack">
        <div className="panel-head"><div><h2>班长账号</h2><p>必须从当前在册学员中选择，每班最多一位班长。</p></div><UserCog size={20} /></div>
        <label>选择班长<select value={monitorId} onChange={(e) => { setMonitorId(e.target.value); setMonitorUsername(""); }}><option value="">暂不设置班长</option>{students.filter((s) => s.active !== false).map((s) => <option key={s.id} value={s.id}>{s.name || s.dharmaName}{s.name && s.dharmaName ? `（${s.dharmaName}）` : ""} · {s.groupName}{s.phone ? "" : " · 无手机号"}</option>)}</select><small>正常学员均可担任班长；没有手机号时系统会生成拼音账号和临时密码。</small></label>
        {monitorId && !students.find((item) => item.id === Number(monitorId))?.phone && <label>班长登录账号（选填）<input value={monitorUsername} onChange={(event) => setMonitorUsername(event.target.value)} autoCapitalize="none" placeholder="留空则根据姓名或法名自动生成" /><small>可以先填写希望使用的拼音账号；重名时系统会提示修改。</small></label>}
        <div className="row-actions align-start"><button type="button" className="primary" onClick={() => void assignMonitor()} disabled={loading}><ShieldCheck size={17} /> 应用班长设置</button>{currentClass.monitorId && <button type="button" className="secondary" onClick={() => void resetMonitorPassword()} disabled={loading}>重置班长密码</button>}{currentClass.monitorId && <button type="button" className="ghost danger" onClick={() => void cancelMonitor()} disabled={loading}>取消班长权限</button>}</div>
        <div className="permission-note"><strong>班长可以做什么？</strong><span>登记本班三项考勤，查看本班统计；不能查看手机号和备注，也不能维护名单或课表。</span></div>
      </section>
    </div>
    <section className={`panel danger-zone ${currentClass.archived ? "restore-zone" : ""}`}><div><h2>{currentClass.archived ? "恢复班级" : "停用班级"}</h2><p>{currentClass.archived ? "恢复后可继续维护名册、课表和考勤。" : "停用不会删除历史记录；管理员和辅导员仍可查看，班长立即停止访问。"}</p></div><button className={currentClass.archived ? "secondary" : "ghost danger"} onClick={() => void toggleClassStatus()} disabled={loading}><Archive size={17} /> {currentClass.archived ? "恢复正常使用" : "停用这个班级"}</button></section>
  </main>;
}

function normalizeOutline(value: unknown): OutlineStatus | null {
  if (value == null || value === "") return null;
  const map: Record<string, OutlineStatus> = { yes: "yes", no: "no", not_required: "not_required", not_needed: "not_required", 是: "yes", 否: "no", 不需要: "not_required" };
  return map[String(value)] ?? null;
}

function normalizeGroupStudy(value: unknown): GroupStudyStatus | null {
  if (value == null || value === "") return null;
  const map: Record<string, GroupStudyStatus> = { present: "present", absent: "absent", 出勤: "present", 缺勤: "absent" };
  return map[String(value)] ?? null;
}

function normalizeClassStudy(value: unknown): ClassStudyStatus | null {
  if (value == null || value === "") return null;
  const map: Record<string, ClassStudyStatus> = { onsite: "onsite", online: "online", makeup: "makeup", share: "share", sharing: "share", absent: "absent", 现场: "onsite", 网络: "online", 补课: "makeup", 分享: "share", 缺勤: "absent" };
  return map[String(value)] ?? null;
}

function attendanceRowFromRaw(raw: Record<string, unknown>, review: boolean): AttendanceRow {
  return {
    studentId: Number(raw.studentId ?? raw.id ?? raw.enrollmentId),
    name: String(raw.name ?? raw.studentName ?? ""),
    dharmaName: raw.dharmaName == null ? null : String(raw.dharmaName),
    groupId: Number(raw.groupId ?? 0),
    groupName: String(raw.groupName ?? ""),
    outline: review ? "not_required" : normalizeOutline(raw.outline ?? raw.outlineStatus),
    groupStudy: normalizeGroupStudy(raw.groupStudy ?? raw.groupStudyStatus),
    classStudy: normalizeClassStudy(raw.classStudy ?? raw.classStudyStatus),
    updatedAt: raw.updatedAt == null ? null : String(raw.updatedAt),
    updatedBy: raw.updatedBy == null ? null : String(raw.updatedBy)
  };
}

function SegmentedSelect<T extends string>({ value, options, onChange, disabled, ariaLabel }: { value: T | null; options: Array<{ value: T; label: string }>; onChange: (value: T | null) => void; disabled?: boolean; ariaLabel: string }) {
  return <div className="segmented" aria-label={ariaLabel}>{options.map((option) => <button type="button" key={option.value} className={`${value === option.value ? "selected" : ""} option-${option.value}`} onClick={() => onChange(value === option.value ? null : option.value)} disabled={disabled}>{option.label}</button>)}</div>;
}

function AttendancePage({ currentClass, user }: { currentClass: ClassSummary; user: CurrentUser }) {
  const { dirty, setDirty } = useNavigation();
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [lessonId, setLessonId] = useState<number | null>(null);
  const [payload, setPayload] = useState<AttendancePayload | null>(null);
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [baselineRows, setBaselineRows] = useState<AttendanceRow[]>([]);
  const [groupFilter, setGroupFilter] = useState("all");
  const [batchOutline, setBatchOutline] = useState<OutlineStatus | "">("");
  const [batchGroup, setBatchGroup] = useState<GroupStudyStatus | "">("");
  const [batchClass, setBatchClass] = useState<ClassStudyStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);

  useEffect(() => () => setDirty(false), [setDirty]);
  useEffect(() => {
    setLoading(true);
    apiJson<unknown>(`/api/classes/${currentClass.id}/lessons`).then((data) => {
      const next = asList<Record<string, unknown>>(data, "lessons", "items").map(lessonFromRaw);
      setLessons(next);
      const current = next.find((item) => item.status === "current") ?? [...next].reverse().find((item) => item.status === "finished") ?? next.find((item) => item.status === "future") ?? next.at(-1);
      setLessonId(current?.id ?? null);
    }).catch((error) => setNotice({ tone: "error", text: errorText(error) })).finally(() => setLoading(false));
  }, [currentClass.id]);

  const loadAttendance = useCallback(async (targetId: number) => {
    setLoading(true); setNotice(null);
    try {
      const data = await apiJson<Record<string, unknown>>(`/api/classes/${currentClass.id}/attendance/${targetId}`);
      const lessonRaw = ((data.lesson ?? {}) || {}) as Record<string, unknown>;
      const lesson = Object.keys(lessonRaw).length ? lessonFromRaw(lessonRaw) : lessons.find((item) => item.id === targetId)!;
      const rawRows = asList<Record<string, unknown>>(data.records ?? data.rows ?? data, "records", "rows");
      const normalizedRows = rawRows.map((row) => attendanceRowFromRaw(row, lesson?.lessonType === "review"));
      setRows(normalizedRows);
      setBaselineRows(normalizedRows);
      setPayload({
        lesson,
        rows: normalizedRows,
        canEdit: data.canEdit == null ? true : Boolean(data.canEdit),
        lockedForMonitor: Boolean(data.lockedForMonitor ?? lesson?.lockedForMonitor),
        openMetrics: data.openMetrics as Record<Metric, boolean> | undefined
      });
      setDirty(false);
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }, [currentClass.id, lessons, setDirty]);

  useEffect(() => { if (lessonId) void loadAttendance(lessonId); else { setPayload(null); setRows([]); } }, [lessonId, loadAttendance]);

  const groups = useMemo(() => Array.from(new Map(rows.map((row) => [row.groupId, row.groupName])).entries()).map(([id, name]) => ({ id, name })), [rows]);
  const visibleRows = rows.filter((row) => groupFilter === "all" || String(row.groupId) === groupFilter);
  const editable = Boolean(payload?.canEdit) && !(payload?.lockedForMonitor && !user.isAdmin && currentClass.permission === "monitor");
  const metricEditable = (metric: Metric) => editable && (user.isAdmin || currentClass.permission === "counselor" || payload?.openMetrics?.[metric] !== false);
  const changeSummary = useMemo(() => {
    const baseline = new Map(baselineRows.map((row) => [row.studentId, row]));
    let people = 0; let fields = 0;
    rows.forEach((row) => {
      const original = baseline.get(row.studentId);
      const changed = !original ? 3 : Number(row.outline !== original.outline) + Number(row.groupStudy !== original.groupStudy) + Number(row.classStudy !== original.classStudy);
      if (changed) { people += 1; fields += changed; }
    });
    return { people, fields };
  }, [baselineRows, rows]);

  function updateRow(studentId: number, field: "outline" | "groupStudy" | "classStudy", value: OutlineStatus | GroupStudyStatus | ClassStudyStatus | null) {
    setRows((current) => current.map((row) => row.studentId === studentId ? { ...row, [field]: value } : row));
    setDirty(true);
  }

  function applyBatch() {
    if (!batchOutline && !batchGroup && !batchClass) return setNotice({ tone: "info", text: "请至少选择一项批量状态" });
    const targetIds = new Set(visibleRows.map((row) => row.studentId));
    const nextRows = rows.map((row) => targetIds.has(row.studentId) ? {
      ...row,
      ...(batchOutline && payload?.lesson.lessonType !== "review" && metricEditable("outline") ? { outline: batchOutline } : {}),
      ...(batchGroup && metricEditable("group_study") ? { groupStudy: batchGroup } : {}),
      ...(batchClass && metricEditable("class_study") ? { classStudy: batchClass } : {})
    } : row);
    const changed = nextRows.some((row, index) => row.outline !== rows[index].outline || row.groupStudy !== rows[index].groupStudy || row.classStudy !== rows[index].classStudy);
    setRows(nextRows);
    if (!changed) return setNotice({ tone: "info", text: "当前范围已经是所选状态，没有产生新修改" });
    setDirty(true);
    setNotice({ tone: "info", text: `已批量应用到 ${targetIds.size} 人，请核对个别情况后保存` });
  }

  async function save() {
    if (!lessonId) return;
    if (!window.confirm(`确认保存本次考勤修改吗？\n将影响 ${changeSummary.people} 位学员、${changeSummary.fields} 项记录。`)) return;
    setSaving(true); setNotice(null);
    try {
      await apiJson(`/api/classes/${currentClass.id}/attendance/${lessonId}`, {
        method: "PUT",
        body: JSON.stringify({ records: rows.map((row) => ({
          studentId: row.studentId,
          ...(metricEditable("outline") ? { outlineStatus: row.outline } : {}),
          ...(metricEditable("group_study") ? { groupStudyStatus: row.groupStudy } : {}),
          ...(metricEditable("class_study") ? { classStudyStatus: row.classStudy } : {})
        })) })
      });
      setDirty(false);
      await loadAttendance(lessonId);
      setBatchOutline(""); setBatchGroup(""); setBatchClass("");
      setNotice({ tone: "success", text: "考勤已保存，并记录了本次修改人和时间" });
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setSaving(false); }
  }

  function changeLesson(nextId: number) {
    if (dirty && !window.confirm("当前课次还有未保存的修改，确定切换课次吗？")) return;
    setDirty(false); setLessonId(nextId);
  }

  const pendingCounts = rows.reduce((acc, row) => ({
    outline: acc.outline + (row.outline == null ? 1 : 0), group: acc.group + (row.groupStudy == null ? 1 : 0), classStudy: acc.classStudy + (row.classStudy == null ? 1 : 0)
  }), { outline: 0, group: 0, classStudy: 0 });

  return <main className="page attendance-page">
    <PageHeader eyebrow="ATTENDANCE" title="考勤登记" description="先批量填写全班或当前小组，再逐位调整例外情况。" actions={lessons.length ? <label className="lesson-picker"><span>选择课次</span><select value={lessonId ?? ""} onChange={(e) => changeLesson(Number(e.target.value))}>{lessons.map((lesson) => <option key={lesson.id} value={lesson.id}>第 {lesson.lessonNumber} 课 · {lesson.title} · {lesson.classStudyDueDate}</option>)}</select></label> : undefined} />
    <Notice notice={notice} onClose={() => setNotice(null)} />
    {loading ? <Loading text="正在准备本课名单..." /> : !payload ? <EmptyState icon={<ClipboardCheck size={28} />} title="还没有可登记的课次" detail="请先生成课表，然后回到这里登记考勤。" /> : <>
      <section className="lesson-summary-bar">
        <div><span className="soft-badge blue">第 {payload.lesson.lessonNumber} 课</span><div><h2>{payload.lesson.title}</h2><p>{payload.lesson.lessonType === "review" ? "复习课 · 导图/提纲自动标记为不需要" : "普通课"} · 班修截止 {payload.lesson.classStudyDueDate}</p></div></div>
        <div className="pending-pills"><span>导图待填 <b>{pendingCounts.outline}</b></span><span>组修待填 <b>{pendingCounts.group}</b></span><span>班修待填 <b>{pendingCounts.classStudy}</b></span></div>
      </section>
      {!editable && <div className="notice info"><AlertTriangle size={17} /><span>{payload.lockedForMonitor ? "本课已超过班修截止日 14 天，班长登记已锁定；请联系辅导员补改。" : "您没有编辑本课考勤的权限。"}</span></div>}
      <section className="panel batch-panel">
        <div className="panel-head"><div><h2>批量填写</h2><p>作用范围：{groupFilter === "all" ? `全班 ${visibleRows.length} 人` : `${groups.find((g) => String(g.id) === groupFilter)?.name} ${visibleRows.length} 人`}</p></div><span className="step-chip">第 1 步</span></div>
        <div className="batch-grid">
          <label>范围<select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}><option value="all">全班</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
          <label>导图/提纲<select value={batchOutline} onChange={(e) => setBatchOutline(e.target.value as OutlineStatus | "")} disabled={payload.lesson.lessonType === "review" || !metricEditable("outline")}><option value="">保持不变</option>{OUTLINE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}{payload.lesson.lessonType === "review" && <option value="not_required">不需要</option>}</select></label>
          <label>组修<select value={batchGroup} onChange={(e) => setBatchGroup(e.target.value as GroupStudyStatus | "")} disabled={!metricEditable("group_study")}><option value="">保持不变</option>{GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
          <label>班修<select value={batchClass} onChange={(e) => setBatchClass(e.target.value as ClassStudyStatus | "")} disabled={!metricEditable("class_study")}><option value="">保持不变</option>{CLASS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
          <button className="secondary" onClick={applyBatch} disabled={!editable}>应用到 {visibleRows.length} 人</button>
        </div>
      </section>
      <section className="panel attendance-panel">
        <div className="panel-head"><div><h2>逐位核对</h2><p>点击已选状态可清空；未填写不会进入完成率分母。</p></div><span className="step-chip">第 2 步</span></div>
        {visibleRows.length === 0 ? <EmptyState title="该范围没有学员" detail="请选择其他小组。" /> : <>
          <div className="table-wrap desktop-table attendance-table"><table><thead><tr><th>学员</th><th>导图 / 提纲</th><th>组修</th><th>班修</th><th>最后修改</th></tr></thead><tbody>{visibleRows.map((row) => <tr key={row.studentId}><td><div className="person-cell"><div className="mini-avatar">{row.name.slice(0, 1)}</div><span><strong>{row.name}</strong><small>{row.dharmaName || row.groupName}</small></span></div></td><td>{payload.lesson.lessonType === "review" ? <span className="not-needed">不需要</span> : <SegmentedSelect value={row.outline === "not_required" ? null : row.outline} options={OUTLINE_OPTIONS} onChange={(value) => updateRow(row.studentId, "outline", value)} disabled={!metricEditable("outline")} ariaLabel={`${row.name}的导图提纲`} />}</td><td><SegmentedSelect value={row.groupStudy} options={GROUP_OPTIONS} onChange={(value) => updateRow(row.studentId, "groupStudy", value)} disabled={!metricEditable("group_study")} ariaLabel={`${row.name}的组修`} /></td><td><SegmentedSelect value={row.classStudy} options={CLASS_OPTIONS} onChange={(value) => updateRow(row.studentId, "classStudy", value)} disabled={!metricEditable("class_study")} ariaLabel={`${row.name}的班修`} /></td><td><small>{row.updatedBy ? <>{row.updatedBy}<br />{dateOnly(row.updatedAt)}</> : "尚未保存"}</small></td></tr>)}</tbody></table></div>
          <div className="mobile-card-list attendance-cards">{visibleRows.map((row) => <article className="attendance-card" key={row.studentId}><div className="person-cell"><div className="mini-avatar large">{row.name.slice(0, 1)}</div><span><strong>{row.name}</strong><small>{row.dharmaName || row.groupName}</small></span></div><div className="mobile-metric"><label>导图 / 提纲</label>{payload.lesson.lessonType === "review" ? <span className="not-needed">复习课 · 不需要</span> : <SegmentedSelect value={row.outline === "not_required" ? null : row.outline} options={OUTLINE_OPTIONS} onChange={(value) => updateRow(row.studentId, "outline", value)} disabled={!metricEditable("outline")} ariaLabel={`${row.name}的导图提纲`} />}</div><div className="mobile-metric"><label>组修</label><SegmentedSelect value={row.groupStudy} options={GROUP_OPTIONS} onChange={(value) => updateRow(row.studentId, "groupStudy", value)} disabled={!metricEditable("group_study")} ariaLabel={`${row.name}的组修`} /></div><div className="mobile-metric"><label>班修</label><SegmentedSelect value={row.classStudy} options={CLASS_OPTIONS} onChange={(value) => updateRow(row.studentId, "classStudy", value)} disabled={!metricEditable("class_study")} ariaLabel={`${row.name}的班修`} /></div></article>)}</div>
        </>}
      </section>
      <div className={`save-dock ${dirty ? "dirty" : ""}`}><span>{dirty ? <><i /> {changeSummary.people} 人 · {changeSummary.fields} 项待保存</> : <><Check size={17} /> 当前数据已保存</>}</span><button className="primary" onClick={() => void save()} disabled={!dirty || saving || !editable}><Save size={17} /> {saving ? "保存中..." : "保存本课考勤"}</button></div>
    </>}
  </main>;
}

function ReportsPage({ currentClass, canExport }: { currentClass: ClassSummary; canExport: boolean }) {
  const today = shanghaiTodayClient();
  const [presetRange, setPresetRange] = useState<PresetReportRange>("recent");
  const [historyMode, setHistoryMode] = useState<"all" | "custom">("all");
  const [customDraft, setCustomDraft] = useState({ from: today, to: today });
  const [customApplied, setCustomApplied] = useState({ from: today, to: today });
  const [datesInitialized, setDatesInitialized] = useState(false);
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [tab, setTab] = useState<"groups" | "people" | "attention">("groups");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<NoticeState>(null);
  const range: ReportRange = presetRange === "history" && historyMode === "custom" ? "custom" : presetRange;
  const load = useCallback(async () => {
    setLoading(true); setNotice(null);
    try {
      const params = new URLSearchParams({ range });
      if (range === "custom") {
        params.set("from", customApplied.from);
        params.set("to", customApplied.to);
      }
      const data = await apiJson<unknown>(`/api/classes/${currentClass.id}/reports?${params.toString()}`);
      setReport(reportFromRaw(data, range));
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { setLoading(false); }
  }, [currentClass.id, customApplied.from, customApplied.to, range]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setPresetRange("recent");
    setHistoryMode("all");
    setCustomDraft({ from: today, to: today });
    setCustomApplied({ from: today, to: today });
    setDatesInitialized(false);
  }, [currentClass.id, today]);
  useEffect(() => {
    if (datesInitialized || !report?.lessons) return;
    const dueDates = report.lessons.flatMap((lesson) => [lesson.outlineDueDate, lesson.groupStudyDueDate, lesson.classStudyDueDate]).filter(Boolean);
    const dates = { from: dueDates.sort()[0] ?? today, to: today };
    setCustomDraft(dates);
    setCustomApplied(dates);
    setDatesInitialized(true);
  }, [datesInitialized, report?.lessons, today]);

  function applyCustomRange() {
    if (!customDraft.from || !customDraft.to) return setNotice({ tone: "error", text: "请选择开始和结束日期" });
    if (customDraft.from > customDraft.to) return setNotice({ tone: "error", text: "开始日期不能晚于结束日期" });
    if (customDraft.to > today) return setNotice({ tone: "error", text: "结束日期不能晚于今天" });
    setNotice(null);
    setCustomApplied(customDraft);
  }

  const exportDates = range === "custom" ? customApplied : undefined;

  return <main className="page">
    <PageHeader eyebrow="REPORTS" title="完成统计" description="导图/提纲、组修和班修独立计算，不生成混合总分。" actions={canExport ? <div className="export-actions"><a className="secondary button" href={exportUrl(currentClass.id, "xlsx", range, exportDates)}><Download size={16} /> Excel</a><a className="ghost button" href={exportUrl(currentClass.id, "csv", range, exportDates)}><Download size={16} /> CSV</a></div> : undefined} />
    <div className="range-tabs" role="tablist" aria-label="统计范围">{PRESET_REPORT_RANGES.map((item) => <button key={item} role="tab" aria-selected={presetRange === item} className={presetRange === item ? "active" : ""} onClick={() => setPresetRange(item)}>{RANGE_LABELS[item]}</button>)}</div>
    {presetRange === "history" && <section className="history-range-panel" aria-label="历史统计范围">
      <div className="history-mode" role="group" aria-label="历史范围模式">
        <button className={historyMode === "all" ? "active" : ""} onClick={() => setHistoryMode("all")}>完整历史</button>
        <button className={historyMode === "custom" ? "active" : ""} onClick={() => setHistoryMode("custom")}>自定义时间段</button>
      </div>
      {historyMode === "custom" && <div className="custom-date-controls">
        <label>开始日期<input type="date" value={customDraft.from} max={today} onChange={(event) => setCustomDraft((current) => ({ ...current, from: event.target.value }))} /></label>
        <span aria-hidden="true">至</span>
        <label>结束日期<input type="date" value={customDraft.to} max={today} onChange={(event) => setCustomDraft((current) => ({ ...current, to: event.target.value }))} /></label>
        <button className="primary" onClick={applyCustomRange} disabled={loading}>查询</button>
      </div>}
      {historyMode === "custom" && (customDraft.from !== customApplied.from || customDraft.to !== customApplied.to) && <small>日期尚未查询；当前统计和导出仍使用 {customApplied.from} 至 {customApplied.to}。</small>}
    </section>}
    <Notice notice={notice} />
    {loading ? <Loading text="正在计算完成率..." /> : report && <>
      <section><div className="section-title"><div><h2>全班三项完成率</h2><p>按全班适用人次汇总，不对个人百分比取平均。</p></div><span className="data-range">{report.rangeLabel ?? RANGE_LABELS[range]}</span></div><div className="metric-grid">{(["outline", "group_study", "class_study"] as Metric[]).map((metric) => <MetricCard key={metric} metric={metric} summary={report.classSummary[metric]} />)}</div></section>
      <section className="panel report-detail">
        <div className="subtabs"><button className={tab === "groups" ? "active" : ""} onClick={() => setTab("groups")}>小组汇总</button><button className={tab === "people" ? "active" : ""} onClick={() => setTab("people")}>个人统计</button><button className={tab === "attention" ? "active" : ""} onClick={() => setTab("attention")}>当前需关注 <span>{report.attention.length}</span></button></div>
        {tab === "groups" && (report.groupSummaries.length ? <><div className="table-wrap desktop-table"><table><thead><tr><th>小组</th>{(["outline", "group_study", "class_study"] as Metric[]).map((m) => <th key={m}>{METRIC_LABELS[m]}</th>)}<th>待登记</th></tr></thead><tbody>{report.groupSummaries.map((group) => <tr key={group.groupId}><td><strong>{group.groupName}</strong></td>{(["outline", "group_study", "class_study"] as Metric[]).map((m) => <td key={m}><div className="rate-cell"><strong>{formatRate(group.metrics[m])}</strong><span>{group.metrics[m].completed}/{group.metrics[m].applicable}</span></div></td>)}<td>{Object.values(group.metrics).reduce((sum, item) => sum + item.pending, 0)}</td></tr>)}</tbody></table></div><div className="mobile-card-list">{report.groupSummaries.map((group) => <article className="report-card" key={group.groupId}><h3>{group.groupName}</h3>{(["outline", "group_study", "class_study"] as Metric[]).map((m) => <div key={m}><span>{METRIC_LABELS[m]}</span><strong>{formatRate(group.metrics[m])}</strong><small>{group.metrics[m].completed}/{group.metrics[m].applicable}</small></div>)}</article>)}</div></> : <EmptyState title="暂无小组统计" detail="当前时间范围内还没有已到期的登记数据。" />)}
        {tab === "people" && (report.personalStats.length ? <><div className="table-wrap desktop-table"><table><thead><tr><th>学员</th><th>小组</th>{(["outline", "group_study", "class_study"] as Metric[]).map((m) => <th key={m}>{METRIC_LABELS[m]}</th>)}<th>待登记</th></tr></thead><tbody>{report.personalStats.map((person) => <tr key={person.studentId}><td><div className="person-cell"><div className="mini-avatar">{person.name.slice(0, 1)}</div><span><strong>{person.name}</strong><small>{person.dharmaName || ""}</small></span></div></td><td>{person.groupName}</td>{(["outline", "group_study", "class_study"] as Metric[]).map((m) => <td key={m}><strong>{formatRate(person.metrics[m])}</strong></td>)}<td>{Object.values(person.metrics).reduce((sum, item) => sum + item.pending, 0)}</td></tr>)}</tbody></table></div><div className="mobile-card-list">{report.personalStats.map((person) => <article className="report-card person-report" key={person.studentId}><div className="person-cell"><div className="mini-avatar">{person.name.slice(0, 1)}</div><span><strong>{person.name}</strong><small>{person.groupName}</small></span></div>{(["outline", "group_study", "class_study"] as Metric[]).map((m) => <div key={m}><span>{METRIC_LABELS[m]}</span><strong>{formatRate(person.metrics[m])}</strong></div>)}</article>)}</div></> : <EmptyState title="暂无个人统计" detail="当前范围内没有适用数据。" />)}
        {tab === "attention" && (report.attention.length ? <div className="risk-grid">{report.attention.map((person) => <article className="risk-card" key={person.studentId}><div className="risk-icon"><AlertTriangle size={20} /></div><div><h3>{person.name}</h3><span>{person.groupName}</span><ul>{person.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div></article>)}</div> : <EmptyState icon={<Check size={28} />} title="当前没有需关注学员" detail="最近班修记录没有触发连续三次或三个月五次规则。" />)}
      </section>
      <div className="info-strip"><BarChart3 size={19} /><div><strong>统计说明</strong><span>“不需要”和未到期阶段不计入分母；未填写单独计为待登记。分母为零时显示“不适用”。</span></div></div>
    </>}
  </main>;
}

function AppContent() {
  const { path, go, dirty, setDirty } = useNavigation();
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [classId, setClassId] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem("class-study.current-class"));
    return stored || null;
  });

  const loadClasses = useCallback(async (activeUser?: CurrentUser | null) => {
    const identity = activeUser === undefined ? user : activeUser;
    if (!identity) return;
    try {
      const data = await apiJson<unknown>("/api/classes");
      const accessMap = new Map(identity.classAccesses.map((item) => [item.classId, item]));
      const next = asList<Record<string, unknown>>(data, "classes", "items").map((raw) => {
        const parsed = classFromRaw(raw);
        const access = accessMap.get(parsed.id);
        return { ...parsed, permission: identity.isAdmin ? "admin" : access?.permission ?? parsed.permission, name: parsed.name || access?.className || "未命名班级" };
      });
      setClasses(next);
      setClassId((current) => {
        if (current && next.some((item) => item.id === current)) return current;
        return next.find((item) => !item.archived)?.id ?? next[0]?.id ?? null;
      });
    } catch (error) {
      if ((error as Error & { status?: number }).status === 401) setUser(null);
      else throw error;
    }
  }, [user]);

  useEffect(() => {
    apiJson<unknown>("/api/auth/me").then((payload) => {
      const me = normalizeMe(payload);
      setUser(me);
      if (me.mustChangePassword) {
        go("/change-password");
        return undefined;
      }
      return loadClasses(me);
    }).catch(() => setUser(null));
    // Initial bootstrap only. loadClasses receives the resolved identity directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (classId) localStorage.setItem("class-study.current-class", String(classId));
    else localStorage.removeItem("class-study.current-class");
  }, [classId]);

  const currentClass = classes.find((item) => item.id === classId) ?? null;
  const manager = Boolean(user?.isAdmin || currentClass?.permission === "counselor");

  function selectClass(nextId: number) {
    if (nextId === classId) return;
    if (dirty && !window.confirm("当前考勤还有未保存的修改，确定切换班级吗？")) return;
    setDirty(false); setClassId(nextId);
  }

  async function logout() {
    if (dirty && !window.confirm("当前考勤还有未保存的修改，确定退出吗？")) return;
    try { await apiJson("/api/auth/logout", { method: "POST" }); } catch { /* Session is cleared locally even if the request fails. */ }
    setDirty(false); setUser(null); setClasses([]); setClassId(null);
    window.history.replaceState({}, "", "/login");
  }

  function onLogin(nextUser: CurrentUser) {
    setUser(nextUser);
    if (nextUser.mustChangePassword) go("/change-password");
    else void loadClasses(nextUser).then(() => go("/overview"));
  }

  async function updateCurrentUser(nextUser: CurrentUser) {
    setUser(nextUser);
    await loadClasses(nextUser);
  }

  if (user === undefined) return <div className="boot"><div className="boot-logo"><BookOpenCheck size={27} /></div><LoaderCircle className="spin" size={22} /><span>正在进入班级空间...</span></div>;
  if (!user) return <LoginPage onLogin={onLogin} />;
  if (user.mustChangePassword || path === "/change-password") return <ChangePasswordPage user={user} onDone={() => {
    const updated = { ...user, mustChangePassword: false };
    setUser(updated);
    void loadClasses(updated).then(() => go("/classes"));
  }} onLogout={() => void logout()} />;

  let content: ReactNode;
  if (path === "/profile") content = <ProfilePage user={user} onUpdated={updateCurrentUser} />;
  else if (path === "/classes" || (!currentClass && path !== "/classes")) content = <ClassHub user={user} classes={classes} onRefresh={() => loadClasses()} onSelect={selectClass} />;
  else if (path === "/overview" || path === "/" || path === "/login") content = <OverviewPage currentClass={currentClass!} />;
  else if (path === "/attendance") content = <AttendancePage currentClass={currentClass!} user={user} />;
  else if (path === "/reports") content = <ReportsPage currentClass={currentClass!} canExport={manager} />;
  else if (path === "/students" && manager) content = <StudentsPage currentClass={currentClass!} />;
  else if (path === "/groups" && manager) content = <GroupsPage currentClass={currentClass!} onClassRefresh={() => loadClasses()} />;
  else if (path === "/lessons" && manager) content = <LessonsPage currentClass={currentClass!} isAdmin={user.isAdmin} onClassRefresh={() => loadClasses()} />;
  else if (path === "/settings" && manager) content = <SettingsPage user={user} currentClass={currentClass!} onRefresh={() => loadClasses()} />;
  else content = <OverviewPage currentClass={currentClass!} />;

  return <AppShell user={user} classes={classes} currentClass={currentClass} onSelectClass={selectClass} onLogout={() => void logout()}>{content}</AppShell>;
}

export default function App() {
  return <AppNavigation><AppContent /></AppNavigation>;
}

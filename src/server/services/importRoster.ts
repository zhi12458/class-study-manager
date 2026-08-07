import ExcelJS from "exceljs";
import type { DatabaseSync } from "node:sqlite";
import { normalizePhone } from "../../shared/phone.js";
import type { EnrollmentRole, EnrollmentStatus } from "../../shared/types.js";

export interface ImportRow {
  rowNumber: number;
  name: string;
  dharmaName: string | null;
  phone: string;
  groupName: string;
  note: string | null;
  status: EnrollmentStatus;
  identities: EnrollmentRole[];
  action: "create" | "update" | "skip" | "conflict";
  message?: string;
}

const HEADER_ALIASES: Record<string, string[]> = {
  name: ["姓名", "名字"],
  dharmaName: ["法名"],
  phone: ["电话", "手机号", "手机"],
  groupName: ["小组", "组别", "组"],
  note: ["备注", "备注信息"],
  status: ["状态", "学员状态"],
  identities: ["身份", "学员身份", "班级身份"]
};

const STATUS_NAMES: Record<string, EnrollmentStatus> = {
  normal: "normal", 正常: "normal", leave: "leave", 休学: "leave", withdrawn: "withdrawn", 退学: "withdrawn"
};
const ROLE_NAMES: Record<string, EnrollmentRole> = {
  group_leader: "group_leader", 组长: "group_leader", charity: "charity", 慈善: "charity",
  dharma_light: "dharma_light", 传灯: "dharma_light", communications: "communications", 文宣: "communications"
};

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && value && "text" in value) return String((value as { text: unknown }).text).trim();
  return String(value).trim();
}

function findColumn(headers: string[], aliases: string[]): number {
  return headers.findIndex((header) => aliases.includes(header));
}

function optionalText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}

function statusValue(value: unknown): EnrollmentStatus {
  const raw = text(value) || "正常";
  const status = STATUS_NAMES[raw];
  if (!status) throw new Error(`状态“${raw}”无效`);
  return status;
}

function identityValues(value: unknown): EnrollmentRole[] {
  const raw = text(value);
  if (!raw || raw === "学员") return [];
  const labels = raw.split(/[、,，/\s]+/).filter(Boolean).filter((label) => label !== "学员");
  if (labels.includes("班长")) throw new Error("班长身份请在班级设置中任命，不能通过 Excel 导入");
  const roles = labels.map((label) => ROLE_NAMES[label]);
  const invalidIndex = roles.findIndex((role) => !role);
  if (invalidIndex >= 0) throw new Error(`身份“${labels[invalidIndex]}”无效`);
  return [...new Set(roles)];
}

export function classifyRosterRows(
  db: DatabaseSync,
  classId: number,
  inputRows: Array<Partial<ImportRow> & { name?: unknown; phone?: unknown; groupName?: unknown }>
): ImportRow[] {
  const groups = new Set(
    (db.prepare("select name from groups where class_id = ? and active = 1").all(classId) as Array<{ name: string }>)
      .map((group) => group.name.trim())
  );
  const seen = new Map<string, string>();
  const groupLeaders = new Map<string, string>();

  return inputRows.map((input, index) => {
    const rowNumber = Number(input.rowNumber) || index + 2;
    const name = text(input.name);
    const dharmaName = optionalText(input.dharmaName);
    const groupName = text(input.groupName);
    const note = optionalText(input.note);
    let status: EnrollmentStatus = "normal";
    let identities: EnrollmentRole[] = [];
    const rawPhone = text(input.phone);
    let phone = rawPhone;
    let action: ImportRow["action"] = "create";
    let message: string | undefined;

    try { status = statusValue(input.status); } catch (error) {
      action = "conflict"; message = error instanceof Error ? error.message : "状态无效";
    }
    try { identities = identityValues(input.identities); } catch (error) {
      action = "conflict"; message = error instanceof Error ? error.message : "身份无效";
    }

    try { phone = normalizePhone(rawPhone); } catch (error) {
      action = "conflict";
      message = error instanceof Error ? error.message : "电话无效";
    }
    if (!name) { action = "conflict"; message = "姓名必填"; }
    if (!groups.has(groupName)) { action = "conflict"; message = `找不到小组“${groupName}”`; }

    const signature = JSON.stringify({ name, dharmaName, phone, groupName, note, status, identities: [...identities].sort() });
    if (action !== "conflict") {
      const previous = seen.get(phone);
      if (previous !== undefined) {
        action = previous === signature ? "skip" : "conflict";
        message = previous === signature ? "文件中的重复行，提交时会跳过" : "文件中同一手机号的数据不一致";
      } else {
        seen.set(phone, signature);
      }
    }

    if (action !== "conflict" && identities.includes("group_leader")) {
      const previousLeader = groupLeaders.get(groupName);
      if (previousLeader && previousLeader !== phone) {
        action = "conflict"; message = `文件中“${groupName}”设置了多名组长`;
      } else {
        groupLeaders.set(groupName, phone);
        const occupied = db.prepare(
          `select p.phone from enrollment_roles er
            join enrollments e on e.id = er.enrollment_id
            join persons p on p.id = e.person_id
            join group_assignments ga on ga.enrollment_id = e.id and ga.effective_to_sequence is null
            join groups g on g.id = ga.group_id
            join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
           where e.class_id = ? and g.name = ? and er.role = 'group_leader'
             and es.status != 'withdrawn' limit 1`
        ).get(classId, groupName) as { phone: string } | undefined;
        if (occupied && occupied.phone !== phone) {
          action = "conflict"; message = `“${groupName}”已有其他组长`;
        }
      }
    }

    if (action === "create") {
      const person = db.prepare(
        "select id, name, dharma_name as dharmaName from persons where phone = ?"
      ).get(phone) as { id: number; name: string; dharmaName: string | null } | undefined;
      if (person) {
        const otherEnrollment = db.prepare(
          `select c.name from enrollments e
            join classes c on c.id = e.class_id
            join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
            where e.person_id = ? and e.class_id != ? and es.status != 'withdrawn' and c.archived = 0 limit 1`
        ).get(person.id, classId) as { name: string } | undefined;
        const enrollment = db.prepare(
          `select e.id, e.note, g.name as groupName, es.status,
                  (select group_concat(er.role) from enrollment_roles er where er.enrollment_id = e.id) as roleCsv
             from enrollments e
             left join group_assignments ga on ga.enrollment_id = e.id and ga.effective_to_sequence is null
             left join groups g on g.id = ga.group_id
             join enrollment_status_history es on es.enrollment_id = e.id and es.effective_to_sequence is null
            where e.class_id = ? and e.person_id = ?`
        ).get(classId, person.id) as { id: number; note: string | null; groupName: string | null; status: EnrollmentStatus; roleCsv: string | null } | undefined;
        if (otherEnrollment) {
          action = "conflict";
          message = `已作为学员加入“${otherEnrollment.name}”`;
        } else if (enrollment) {
          const existingRoles = enrollment.roleCsv ? enrollment.roleCsv.split(",").sort() : [];
          const unchanged = person.name === name && (person.dharmaName ?? null) === dharmaName &&
            (enrollment.note ?? null) === note && enrollment.groupName === groupName && enrollment.status === status &&
            JSON.stringify(existingRoles) === JSON.stringify([...identities].sort());
          action = unchanged ? "skip" : "update";
          if (unchanged) message = "与本班现有资料相同，提交时会跳过";
        }
      }
    }

    return { rowNumber, name, dharmaName, phone, groupName, note, status, identities, action, message };
  });
}

export async function parseRosterWorkbook(db: DatabaseSync, classId: number, buffer: Buffer): Promise<ImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Excel 中没有工作表");
  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(text);
  const columns = Object.fromEntries(
    Object.entries(HEADER_ALIASES).map(([key, aliases]) => [key, findColumn(headers, aliases) + 1])
  ) as Record<keyof typeof HEADER_ALIASES, number>;
  if (!columns.name || !columns.phone || !columns.groupName) throw new Error("模板必须包含姓名、电话和小组列");

  const rows: Array<Partial<ImportRow> & { name: string; phone: string; groupName: string }> = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const name = text(row.getCell(columns.name).value);
    const rawPhone = text(row.getCell(columns.phone).value);
    const groupName = text(row.getCell(columns.groupName).value);
    if (!name && !rawPhone && !groupName) continue;
    const cell = (column: number) => column > 0 ? row.getCell(column).value : null;
    rows.push({
      rowNumber, name, dharmaName: optionalText(cell(columns.dharmaName)),
      phone: rawPhone, groupName, note: optionalText(cell(columns.note)),
      status: cell(columns.status) as unknown as EnrollmentStatus,
      identities: cell(columns.identities) as unknown as EnrollmentRole[]
    });
  }
  return classifyRosterRows(db, classId, rows);
}

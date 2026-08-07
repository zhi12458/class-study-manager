import ExcelJS from "exceljs";
import type { DatabaseSync } from "node:sqlite";
import { normalizePhone } from "../../shared/phone.js";

export interface ImportRow {
  rowNumber: number;
  name: string;
  dharmaName: string | null;
  phone: string;
  groupName: string;
  note: string | null;
  action: "create" | "update" | "skip" | "conflict";
  message?: string;
}

const HEADER_ALIASES: Record<string, string[]> = {
  name: ["姓名", "名字"],
  dharmaName: ["法名"],
  phone: ["电话", "手机号", "手机"],
  groupName: ["小组", "组别", "组"],
  note: ["备注", "备注信息"]
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

  return inputRows.map((input, index) => {
    const rowNumber = Number(input.rowNumber) || index + 2;
    const name = text(input.name);
    const dharmaName = optionalText(input.dharmaName);
    const groupName = text(input.groupName);
    const note = optionalText(input.note);
    const rawPhone = text(input.phone);
    let phone = rawPhone;
    let action: ImportRow["action"] = "create";
    let message: string | undefined;

    try { phone = normalizePhone(rawPhone); } catch (error) {
      action = "conflict";
      message = error instanceof Error ? error.message : "电话无效";
    }
    if (!name) { action = "conflict"; message = "姓名必填"; }
    if (!groups.has(groupName)) { action = "conflict"; message = `找不到小组“${groupName}”`; }

    const signature = JSON.stringify({ name, dharmaName, phone, groupName, note });
    if (action !== "conflict") {
      const previous = seen.get(phone);
      if (previous !== undefined) {
        action = previous === signature ? "skip" : "conflict";
        message = previous === signature ? "文件中的重复行，提交时会跳过" : "文件中同一手机号的数据不一致";
      } else {
        seen.set(phone, signature);
      }
    }

    if (action === "create") {
      const person = db.prepare(
        "select id, name, dharma_name as dharmaName from persons where phone = ?"
      ).get(phone) as { id: number; name: string; dharmaName: string | null } | undefined;
      if (person) {
        const otherEnrollment = db.prepare(
          `select c.name from enrollments e join classes c on c.id = e.class_id
            where e.person_id = ? and e.class_id != ? and e.inactive_from_sequence is null and c.archived = 0 limit 1`
        ).get(person.id, classId) as { name: string } | undefined;
        const enrollment = db.prepare(
          `select e.id, e.note, e.inactive_from_sequence as inactiveFromSequence, g.name as groupName
             from enrollments e
             left join group_assignments ga on ga.enrollment_id = e.id and ga.effective_to_sequence is null
             left join groups g on g.id = ga.group_id
            where e.class_id = ? and e.person_id = ?`
        ).get(classId, person.id) as { id: number; note: string | null; inactiveFromSequence: number | null; groupName: string | null } | undefined;
        if (otherEnrollment) {
          action = "conflict";
          message = `已作为学员加入“${otherEnrollment.name}”`;
        } else if (enrollment?.inactiveFromSequence != null) {
          action = "conflict";
          message = "该学员已在本班停用，请使用手工管理处理";
        } else if (enrollment) {
          const unchanged = person.name === name && (person.dharmaName ?? null) === dharmaName &&
            (enrollment.note ?? null) === note && enrollment.groupName === groupName;
          action = unchanged ? "skip" : "update";
          if (unchanged) message = "与本班现有资料相同，提交时会跳过";
        }
      }
    }

    return { rowNumber, name, dharmaName, phone, groupName, note, action, message };
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
      phone: rawPhone, groupName, note: optionalText(cell(columns.note))
    });
  }
  return classifyRosterRows(db, classId, rows);
}

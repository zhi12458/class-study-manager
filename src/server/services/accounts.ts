import type { DatabaseSync } from "node:sqlite";
import { pinyin } from "pinyin-pro";

const USERNAME_PATTERN = /^[a-z][a-z0-9._-]{2,31}$/;

export function personDisplayName(name: unknown, dharmaName: unknown): string {
  return String(name ?? "").trim() || String(dharmaName ?? "").trim();
}

export function assertPersonName(name: unknown, dharmaName: unknown): { name: string; dharmaName: string | null; displayName: string } {
  const legalName = String(name ?? "").trim();
  const dharma = String(dharmaName ?? "").trim() || null;
  const displayName = personDisplayName(legalName, dharma);
  if (!displayName) throw new Error("姓名、法名至少填写一项");
  return { name: legalName, dharmaName: dharma, displayName };
}

export function normalizeCustomUsername(value: unknown): string {
  const username = String(value ?? "").trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error("登录账号须为3至32位小写字母、数字、点、下划线或短横线，并以字母开头");
  }
  if (username === "admin" || username.startsWith("admin-")) throw new Error("该登录账号不可使用");
  return username;
}

function pinyinBase(value: string): string {
  const result = pinyin(value, { toneType: "none", type: "array" })
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const prefixed = /^[a-z]/.test(result) ? result : `user${result}`;
  return (prefixed || "user").slice(0, 28);
}

export function suggestUniqueUsername(db: DatabaseSync, value: string): string {
  const base = pinyinBase(value);
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base.slice(0, 32 - String(suffix + 1).length)}${suffix + 1}`;
    if (!db.prepare("select 1 from users where username = ?").get(candidate)) return candidate;
  }
  throw new Error("无法生成可用登录账号，请手工填写");
}

export function assertUsernameAvailable(db: DatabaseSync, username: string, userId?: number | null): void {
  const existing = db.prepare("select id from users where username = ?").get(username) as { id: number } | undefined;
  if (existing && existing.id !== userId) throw new Error("该登录账号已被使用");
}

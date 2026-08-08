import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AuthUser, ClassAccess } from "../shared/types.js";

const SESSION_DAYS = 7;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createPasswordHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function generateTemporaryPassword(): string {
  return `${randomBytes(6).toString("base64url")}a8!`;
}

export function createSession(db: DatabaseSync, userId: number): string {
  db.prepare("delete from sessions_auth where julianday(expires_at) <= julianday('now')").run();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare("insert into sessions_auth (token_hash, user_id, expires_at) values (?, ?, ?)").run(
    sha256(token),
    userId,
    expiresAt
  );
  return token;
}

export function deleteSession(db: DatabaseSync, token?: string): void {
  if (token) db.prepare("delete from sessions_auth where token_hash = ?").run(sha256(token));
}

export function loadSessionUser(db: DatabaseSync, token?: string): AuthUser | null {
  if (!token) return null;
  const row = db.prepare(
    `select u.id, u.person_id as personId, u.display_name as displayName, p.name,
            p.dharma_name as dharmaName, coalesce(p.phone, u.contact_phone) as phone,
            u.username, u.is_admin as isAdmin, u.can_counsel as canCounsel,
            u.must_change_password as mustChangePassword
       from sessions_auth s
       join users u on u.id = s.user_id
       left join persons p on p.id = u.person_id
      where s.token_hash = ? and julianday(s.expires_at) > julianday('now') and u.active = 1`
  ).get(sha256(token)) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    personId: row.personId == null ? null : Number(row.personId),
    displayName: String(row.displayName),
    name: row.name == null ? null : String(row.name),
    dharmaName: row.dharmaName == null ? null : String(row.dharmaName),
    phone: row.phone == null ? null : String(row.phone),
    username: String(row.username),
    isAdmin: Boolean(row.isAdmin),
    canCounsel: Boolean(row.canCounsel),
    mustChangePassword: Boolean(row.mustChangePassword)
  };
}

export function listClassAccesses(db: DatabaseSync, user: AuthUser): ClassAccess[] {
  if (user.isAdmin) {
    return (db.prepare(
      `select id as classId, name as className, archived from classes order by archived, id desc`
    ).all() as Array<Record<string, unknown>>).map((row) => ({
      classId: Number(row.classId), className: String(row.className), permission: "counselor", archived: Boolean(row.archived)
    }));
  }
  const rows = db.prepare(
    `select c.id as classId, c.name as className, c.archived,
            case when ? = 1 and c.counselor_user_id = ? then 'counselor' else 'monitor' end as permission
       from classes c
       left join class_monitors m on m.class_id = c.id
      where (? = 1 and c.counselor_user_id = ?) or (m.user_id = ? and c.archived = 0)
      order by c.archived, c.id desc`
  ).all(user.canCounsel ? 1 : 0, user.id, user.canCounsel ? 1 : 0, user.id, user.id) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    classId: Number(row.classId), className: String(row.className),
    permission: row.permission === "counselor" ? "counselor" : "monitor", archived: Boolean(row.archived)
  }));
}

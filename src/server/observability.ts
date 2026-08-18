import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { NextFunction, Request, Response } from "express";
import type { AuthedRequest } from "./access.js";

export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditEventInput {
  eventType: string;
  requestId?: string;
  userId?: number | null;
  classId?: number | null;
  outcome: AuditOutcome;
  httpStatus?: number | null;
  method?: string | null;
  path?: string | null;
  clientIp?: string | null;
  details?: Record<string, unknown> | null;
}

function jsonLog(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(event: string, fields: Record<string, unknown> = {}): void {
  jsonLog("info", event, fields);
}

export function logWarning(event: string, fields: Record<string, unknown> = {}): void {
  jsonLog("warn", event, fields);
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const safeError = error instanceof Error
    ? { errorName: error.name, errorMessage: error.message, errorStack: error.stack }
    : { errorMessage: String(error) };
  jsonLog("error", event, { ...fields, ...safeError });
}

function normalizeIp(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, 64);
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

export function getClientIp(req: Request): string | null {
  if (process.env.TRUST_CLOUDFLARE === "true") {
    const cloudflareIp = req.get("CF-Connecting-IP");
    if (cloudflareIp) return normalizeIp(cloudflareIp);
  }
  return normalizeIp(req.socket.remoteAddress);
}

export function identifierFingerprint(identifier: string): string {
  return createHash("sha256").update(identifier.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export function recordAuditEvent(db: DatabaseSync, input: AuditEventInput): void {
  const detailsJson = input.details && Object.keys(input.details).length > 0
    ? JSON.stringify(input.details)
    : null;
  db.prepare(
    `insert into system_audit_events
       (event_type, request_id, user_id, class_id, outcome, http_status, method, path, client_ip, details_json)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.eventType,
    input.requestId ?? null,
    input.userId ?? null,
    input.classId ?? null,
    input.outcome,
    input.httpStatus ?? null,
    input.method ?? null,
    input.path ?? null,
    input.clientIp ?? null,
    detailsJson,
  );
}

export function safelyRecordAuditEvent(db: DatabaseSync, input: AuditEventInput): void {
  try {
    recordAuditEvent(db, input);
  } catch (error) {
    logError("audit_write_failed", error, { requestId: input.requestId, eventType: input.eventType });
  }
}

function numericClassId(pathname: string): number | null {
  const match = pathname.match(/^\/api\/classes\/(\d+)(?:\/|$)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function outcomeForStatus(status: number): AuditOutcome {
  if (status < 400) return "success";
  if (status === 401 || status === 403 || status === 429) return "denied";
  return "failure";
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXPLICIT_AUDIT_PATHS = new Set(["/api/auth/login", "/api/client-errors"]);
const SENSITIVE_FIELD_NAMES = new Set([
  "password", "currentPassword", "newPassword", "temporaryPassword", "phone", "note", "records",
]);

function changedFieldNames(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>)
    .filter((key) => !SENSITIVE_FIELD_NAMES.has(key))
    .sort()
    .slice(0, 30);
}

export function requestObservability(db: DatabaseSync) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    req.requestId = requestId;
    req.clientIp = getClientIp(req);
    res.setHeader("X-Request-ID", requestId);

    res.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const pathname = req.originalUrl.split("?", 1)[0];
      const classId = numericClassId(pathname);
      const fields = {
        requestId,
        method: req.method,
        path: pathname,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
        userId: req.user?.id ?? req.auditUserId ?? null,
        classId,
        clientIp: req.clientIp,
      };
      const routineHealthCheck = pathname === "/api/health" && res.statusCode < 400;
      if (!routineHealthCheck) {
        if (res.statusCode >= 500) logError("http_request", `HTTP ${res.statusCode}`, fields);
        else if (res.statusCode >= 400) logWarning("http_request", fields);
        else logInfo("http_request", fields);
      }

      if (!MUTATING_METHODS.has(req.method) || EXPLICIT_AUDIT_PATHS.has(pathname)) return;
      safelyRecordAuditEvent(db, {
          eventType: "api_mutation",
          requestId,
          userId: req.user?.id ?? req.auditUserId,
          classId,
          outcome: outcomeForStatus(res.statusCode),
          httpStatus: res.statusCode,
          method: req.method,
          path: pathname,
          clientIp: req.clientIp,
          details: { changedFields: changedFieldNames(req.body) },
      });
    });
    next();
  };
}

export function pruneSystemAuditEvents(db: DatabaseSync): number {
  const configured = Number(process.env.AUDIT_RETENTION_DAYS ?? 180);
  const days = Number.isInteger(configured) && configured >= 30 && configured <= 3650 ? configured : 180;
  const result = db.prepare("delete from system_audit_events where created_at < datetime('now', ?)").run(`-${days} days`);
  return Number(result.changes);
}

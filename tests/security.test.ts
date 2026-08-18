import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { createApp } from "../src/server/app.js";
import { openDatabase } from "../src/server/db.js";
import { classifyHttpError } from "../src/server/httpErrors.js";
import { startTestApi } from "./support/apiHarness.js";

describe("登录与响应安全", () => {
  it("第五次失败仍返回401，第六次返回429并提供重试时间", async () => {
    const db = openDatabase(":memory:");
    const server = await startTestApi(db);
    try {
      const client = server.client();
      for (let index = 0; index < 5; index += 1) {
        const response = await client.post("/auth/login", { identifier: "admin", password: "wrong-password" });
        expect(response.status).toBe(401);
      }
      const blocked = await client.post<{ error: string }>("/auth/login", { identifier: "admin", password: "admin12345" });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error).toContain("稍后再试");
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("阈值前登录成功会清除该账号与来源的失败记录", async () => {
    const db = openDatabase(":memory:");
    const server = await startTestApi(db);
    try {
      const client = server.client();
      for (let index = 0; index < 4; index += 1) {
        expect((await client.post("/auth/login", { identifier: "admin", password: "wrong-password" })).status).toBe(401);
      }
      expect((await client.post("/auth/login", { identifier: "admin", password: "admin12345" })).status).toBe(200);
      for (let index = 0; index < 5; index += 1) {
        expect((await client.post("/auth/login", { identifier: "admin", password: "wrong-again" })).status).toBe(401);
      }
    } finally {
      await server.close();
      db.close();
    }
  });

  it("API设置安全头和禁止缓存，未知内部错误不会泄露原始消息", async () => {
    const db = openDatabase(":memory:");
    const server = await startTestApi(db);
    try {
      const health = await server.client().get("/health");
      expect(health.headers.get("cache-control")).toBe("no-store");
      expect(health.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(health.headers.get("x-content-type-options")).toBe("nosniff");
      expect(health.headers.get("x-frame-options")).toBe("DENY");
      expect(health.headers.get("referrer-policy")).toBe("no-referrer");

      const internal = classifyHttpError(new Error("database connection secret details"));
      expect(internal).toMatchObject({ status: 500, message: "服务器暂时无法处理请求", internal: true });
      expect(internal.message).not.toContain("database");
      const sqlite = Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
      expect(classifyHttpError(sqlite)).toMatchObject({ status: 500, message: "服务器暂时无法处理请求" });
    } finally {
      await server.close();
      db.close();
    }
  });

  it("HTML不缓存而带哈希的前端资源使用长期不可变缓存", async () => {
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "class-study-static-"));
    await mkdir(path.join(clientDir, "assets"));
    await writeFile(path.join(clientDir, "index.html"), "<!doctype html><title>test</title>");
    await writeFile(path.join(clientDir, "assets", "index-test123.js"), "console.log('test')");
    const db = openDatabase(":memory:");
    const app = createApp(db, { serveClient: true, clientDir });
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const html = await fetch(`http://127.0.0.1:${port}/`);
      const asset = await fetch(`http://127.0.0.1:${port}/assets/index-test123.js`);
      expect(html.headers.get("cache-control")).toBe("no-cache");
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(html.headers.get("content-security-policy")).toContain("default-src 'self'");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
      await rm(clientDir, { recursive: true, force: true });
    }
  });

  it("每个API请求有可关联编号，并持久记录登录与脱敏写操作审计", async () => {
    const db = openDatabase(":memory:");
    const server = await startTestApi(db);
    try {
      const client = server.client();
      const failed = await client.post("/auth/login", { identifier: "admin", password: "wrong-password" });
      const failedRequestId = failed.headers.get("x-request-id");
      expect(failedRequestId).toMatch(/^[0-9a-f-]{36}$/);
      const loginFailure = db.prepare(
        "select request_id as requestId, event_type as eventType, details_json as detailsJson from system_audit_events where event_type = 'login_failed'"
      ).get() as { requestId: string; eventType: string; detailsJson: string };
      expect(loginFailure.requestId).toBe(failedRequestId);
      expect(loginFailure.detailsJson).not.toContain("admin");
      expect(loginFailure.detailsJson).not.toContain("wrong-password");

      const loggedIn = await client.post("/auth/login", { identifier: "admin", password: "admin12345" });
      expect(loggedIn.status).toBe(200);
      expect(db.prepare("select count(*) as count from system_audit_events where event_type = 'login_succeeded'").get())
        .toMatchObject({ count: 1 });

      const updated = await client.patch("/auth/profile", { displayName: "日志测试管理员" });
      expect(updated.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      const mutation = db.prepare(
        "select user_id as userId, class_id as classId, path, details_json as detailsJson from system_audit_events where event_type = 'api_mutation' and path = '/api/auth/profile' order by id desc limit 1"
      ).get() as { userId: number; classId: null; path: string; detailsJson: string };
      expect(mutation).toMatchObject({ userId: 1, classId: null, path: "/api/auth/profile" });
      expect(mutation.detailsJson).toContain("displayName");
      expect(mutation.detailsJson).not.toContain("日志测试管理员");
    } finally {
      await server.close();
      db.close();
    }
  });

  it("浏览器异常会脱敏后保存，且只有管理员能读取审计列表", async () => {
    const db = openDatabase(":memory:");
    const server = await startTestApi(db);
    try {
      const anonymous = server.client();
      const reported = await anonymous.post<{ requestId: string }>("/client-errors", {
        source: "react",
        message: "手机号 13800138000 渲染失败",
        stack: "Error at /attendance?token=secret-value",
        page: "/attendance?phone=13800138000",
        assetVersion: "/assets/index-test.js",
      });
      expect(reported.status).toBe(202);
      expect(reported.body.requestId).toBe(reported.headers.get("x-request-id"));
      const stored = db.prepare(
        "select details_json as detailsJson from system_audit_events where event_type = 'client_error'"
      ).get() as { detailsJson: string };
      expect(stored.detailsJson).toContain("[已隐藏手机号]");
      expect(stored.detailsJson).not.toContain("13800138000");
      expect(stored.detailsJson).not.toContain("secret-value");

      expect((await anonymous.get("/admin/audit-events")).status).toBe(401);
      const admin = server.client();
      expect((await admin.post("/auth/login", { identifier: "admin", password: "admin12345" })).status).toBe(200);
      const list = await admin.get<{ events: Array<{ eventType: string }> }>("/admin/audit-events?limit=10");
      expect(list.status).toBe(200);
      expect(list.body.events.some((event) => event.eventType === "client_error")).toBe(true);
    } finally {
      await server.close();
      db.close();
    }
  });
});

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
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { createApiRouter } from "../../src/server/routes.js";

export interface JsonResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export interface RawResponse {
  status: number;
  body: Buffer;
  headers: Headers;
}

export class TestApiClient {
  private cookie = "";

  constructor(private readonly baseUrl: string) {}

  private rememberCookie(headers: Headers): void {
    const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? [headers.get("set-cookie")].filter((value): value is string => value !== null);
    for (const value of values) {
      const match = /(?:^|;\s*)(class_study_session=[^;]*)/.exec(value);
      if (match) this.cookie = match[1];
    }
  }

  private headers(accept: string): Headers {
    const headers = new Headers({ Accept: accept });
    if (this.cookie) headers.set("Cookie", this.cookie);
    return headers;
  }

  async json<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<JsonResponse<T>> {
    const headers = this.headers("application/json");
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.rememberCookie(response.headers);
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : {}) as T,
      headers: response.headers,
    };
  }

  async form<T = Record<string, unknown>>(path: string, body: FormData): Promise<JsonResponse<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers("application/json"),
      body,
    });
    this.rememberCookie(response.headers);
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : {}) as T,
      headers: response.headers,
    };
  }

  async raw(path: string): Promise<RawResponse> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers("*/*"),
    });
    this.rememberCookie(response.headers);
    return {
      status: response.status,
      body: Buffer.from(await response.arrayBuffer()),
      headers: response.headers,
    };
  }

  get<T = Record<string, unknown>>(path: string): Promise<JsonResponse<T>> {
    return this.json<T>("GET", path);
  }

  post<T = Record<string, unknown>>(path: string, body?: unknown): Promise<JsonResponse<T>> {
    return this.json<T>("POST", path, body);
  }

  put<T = Record<string, unknown>>(path: string, body?: unknown): Promise<JsonResponse<T>> {
    return this.json<T>("PUT", path, body);
  }

  patch<T = Record<string, unknown>>(path: string, body?: unknown): Promise<JsonResponse<T>> {
    return this.json<T>("PATCH", path, body);
  }
}

export interface TestApiServer {
  baseUrl: string;
  client(): TestApiClient;
  close(): Promise<void>;
}

export async function startTestApi(db: DatabaseSync): Promise<TestApiServer> {
  const app = express();
  app.disable("x-powered-by");
  app.use("/api", createApiRouter(db));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  return {
    baseUrl,
    client: () => new TestApiClient(baseUrl),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

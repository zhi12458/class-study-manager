import express from "express";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createApiRouter } from "./routes.js";
import { securityHeaders } from "./security.js";

export interface AppOptions {
  clientDir?: string;
  serveClient?: boolean;
}

export function createApp(db: DatabaseSync, options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  }, createApiRouter(db));

  if (options.serveClient) {
    if (!options.clientDir) throw new Error("生产静态资源目录未配置");
    app.use(express.static(options.clientDir, {
      maxAge: 0,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }));
    app.get(/.*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(options.clientDir!, "index.html"));
    });
  }

  return app;
}

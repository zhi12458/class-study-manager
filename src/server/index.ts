import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { logError, logInfo, logWarning } from "./observability.js";

const db = openDatabase();
const port = Number(process.env.PORT ?? 3000);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === "production";
const app = createApp(db, {
  serveClient: production,
  clientDir: production ? path.resolve(dirname, "../client") : undefined,
});

const server = app.listen(port, "0.0.0.0", () => {
  logInfo("server_started", { port, nodeEnv: process.env.NODE_ENV ?? "development", processId: process.pid });
});

let shuttingDown = false;
function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logWarning("server_shutdown_started", { signal, exitCode });
  const forceTimer = setTimeout(() => {
    logError("server_shutdown_timeout", new Error("Server did not close within 10 seconds"), { signal });
    process.exit(1);
  }, 10_000);
  forceTimer.unref();
  server.close(() => {
    clearTimeout(forceTimer);
    db.close();
    logInfo("server_shutdown_completed", { signal, exitCode });
    process.exit(exitCode);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logError("unhandled_rejection", reason);
});
process.on("uncaughtException", (error) => {
  logError("uncaught_exception", error);
  shutdown("uncaughtException", 1);
});

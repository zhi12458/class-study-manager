import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";

const db = openDatabase();
const port = Number(process.env.PORT ?? 3000);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === "production";
const app = createApp(db, {
  serveClient: production,
  clientDir: production ? path.resolve(dirname, "../client") : undefined,
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Class study manager listening on http://0.0.0.0:${port}`);
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

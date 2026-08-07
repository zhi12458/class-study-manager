import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.js";
import { createApiRouter } from "./routes.js";

const app = express();
const db = openDatabase();
const port = Number(process.env.PORT ?? 3000);

app.disable("x-powered-by");
app.use("/api", createApiRouter(db));

if (process.env.NODE_ENV === "production") {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const clientDir = path.resolve(dirname, "../client");
  app.use(express.static(clientDir, { maxAge: "1h" }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
}

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Class study manager listening on http://0.0.0.0:${port}`);
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { openDatabase } from "../db.js";
import { importTeaRoster, parseTeaRosterWorkbook } from "../services/teaRosterImport.js";
import { syncOfficialCourseCatalog } from "../services/courseCatalog.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourcePath = process.argv[2];
if (!sourcePath || sourcePath.startsWith("--")) {
  throw new Error("用法：node dist/server/cli/importTeaRoster.js /完整路径/喝茶考勤表单.xlsx [--preview] [--sync-catalog] [--credentials /安全路径/账号.json]");
}

const input = await readFile(sourcePath);
const preview = await parseTeaRosterWorkbook(input, path.basename(sourcePath));
const credentialsPath = argument("--credentials");
if (process.argv.includes("--preview")) {
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  process.exit(0);
}
if (!credentialsPath) {
  throw new Error("正式导入必须用 --credentials 指定一次性账号密码文件");
}

const db = openDatabase();
try {
  const catalog = process.argv.includes("--sync-catalog") ? await syncOfficialCourseCatalog(db) : null;
  const admin = db.prepare("select id from users where is_admin = 1 and active = 1 order by id limit 1").get() as
    | { id: number }
    | undefined;
  if (!admin) throw new Error("数据库没有可用管理员账号");
  let credentialsWritten = false;
  const result = await importTeaRoster(db, preview, admin.id, {
    persistCredentials: async (credentials) => {
      await writeFile(credentialsPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), credentials }, null, 2)}\n`, {
        encoding: "utf8", mode: 0o600, flag: "wx"
      });
      credentialsWritten = true;
    }
  }).catch(async (error) => {
    if (credentialsWritten) await unlink(credentialsPath).catch(() => undefined);
    throw error;
  });
  process.stdout.write(`${JSON.stringify({ catalog: catalog ? { series: catalog.length, items: catalog.reduce((sum, item) => sum + item.items.length, 0) } : null, preview: preview.summary, skipped: preview.skipped, result: { ...result, credentials: undefined }, credentialsPath: credentialsPath ?? null }, null, 2)}\n`);
} finally {
  db.close();
}

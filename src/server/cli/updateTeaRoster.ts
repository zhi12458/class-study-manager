import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { openDatabase } from "../db.js";
import {
  applyTeaRosterUpdate, parseTeaRosterUpdateWorkbook, preflightTeaRosterUpdate
} from "../services/teaRosterUpdate.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourcePath = process.argv[2];
if (!sourcePath || sourcePath.startsWith("--")) {
  throw new Error(
    "用法：node dist/server/cli/updateTeaRoster.js /完整路径/喝茶考勤表单-更新.xlsx [--preview] [--credentials /安全路径/账号.json]"
  );
}

const input = await readFile(sourcePath);
const preview = await parseTeaRosterUpdateWorkbook(input, path.basename(sourcePath));
if (process.argv.includes("--preview")) {
  const db = openDatabase();
  try {
    const admin = db.prepare("select id from users where is_admin = 1 and active = 1 order by id limit 1").get() as
      | { id: number }
      | undefined;
    if (!admin) throw new Error("数据库没有可用管理员账号");
    const databasePreflight = preflightTeaRosterUpdate(db, preview, admin.id);
    process.stdout.write(`${JSON.stringify({ ...preview, databasePreflight }, null, 2)}\n`);
  } finally {
    db.close();
  }
  process.exit(0);
}

const credentialsPath = argument("--credentials");
if (!credentialsPath) throw new Error("正式更新必须用 --credentials 指定一次性账号密码文件");

const db = openDatabase();
try {
  const admin = db.prepare("select id from users where is_admin = 1 and active = 1 order by id limit 1").get() as
    | { id: number }
    | undefined;
  if (!admin) throw new Error("数据库没有可用管理员账号");

  let credentialsWritten = false;
  const result = await applyTeaRosterUpdate(db, preview, admin.id, {
    persistCredentials: async (credentials) => {
      await writeFile(
        credentialsPath,
        `${JSON.stringify({ generatedAt: new Date().toISOString(), credentials }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" }
      );
      credentialsWritten = true;
    }
  }).catch(async (error) => {
    if (credentialsWritten) await unlink(credentialsPath).catch(() => undefined);
    throw error;
  });

  process.stdout.write(`${JSON.stringify({
    preview: preview.summary,
    result: { ...result, credentials: undefined },
    credentialsPath: result.alreadyApplied ? null : credentialsPath
  }, null, 2)}\n`);
} finally {
  db.close();
}

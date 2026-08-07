import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";
import { createClass } from "../src/server/services/classes.js";
import { courseTitlesForRange, DEFAULT_COURSE_TITLES } from "../src/shared/courseCatalog.js";

describe("旧系统课程目录", () => {
  let db: DatabaseSync | undefined;
  afterEach(() => db?.close());

  it("按旧系统顺序提供已有课程，未命名课次保留默认名称", () => {
    expect(courseTitlesForRange(1, 6)).toEqual([
      ...DEFAULT_COURSE_TITLES,
      "",
      "",
    ]);
  });

  it("生成班级课表时自动采用旧系统课程名称", () => {
    db = openDatabase(":memory:");
    const admin = db.prepare("select id from users where is_admin = 1").get() as { id: number };
    db.prepare("update users set can_counsel = 1 where id = ?").run(admin.id);
    const classId = createClass(db, {
      name: "课程目录测试班",
      counselorUserId: admin.id,
      createdBy: admin.id,
      groupCount: 3,
      cadenceMode: "same_week",
      firstDueDate: "2026-08-09",
      lessonCount: 6,
    });

    const titles = (db.prepare("select title from lessons where class_id = ? order by sequence").all(classId) as Array<{ title: string }>)
      .map((row) => row.title);
    expect(titles).toEqual([...DEFAULT_COURSE_TITLES, "第5课", "第6课"]);
  });
});

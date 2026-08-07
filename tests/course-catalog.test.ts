import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/server/db.js";
import { createClass } from "../src/server/services/classes.js";
import { coursePlanForRange, DEFAULT_COURSES } from "../src/shared/courseCatalog.js";

describe("旧系统课程目录", () => {
  let db: DatabaseSync | undefined;
  afterEach(() => db?.close());

  it("按旧版生产系统顺序提供 50 门课程并标记复习课", () => {
    expect(DEFAULT_COURSES).toHaveLength(50);
    expect(coursePlanForRange(1, 7)).toEqual({
      titles: [
        "《当代宗教信仰问题思考》",
        "《佛教与中国传统文化》",
        "《人生五大问题》",
        "《信仰与人生》",
        "《慈经》的修行",
        "《班级慈善关爱》",
        "同喜班复习课之一",
      ],
      lessonTypes: ["regular", "regular", "regular", "regular", "regular", "regular", "review"],
    });
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
      lessonCount: 24,
    });

    const lessons = db.prepare(
      "select sequence, title, lesson_type as lessonType from lessons where class_id = ? order by sequence"
    ).all(classId) as Array<{ sequence: number; title: string; lessonType: string }>;
    expect(lessons.map((lesson) => lesson.title)).toEqual(DEFAULT_COURSES.slice(0, 24).map((course) => course.title));
    expect(lessons[6].lessonType).toBe("review");
    expect(lessons[20].lessonType).toBe("review");
  });
});

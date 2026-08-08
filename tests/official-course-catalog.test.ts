import { describe, expect, it } from "vitest";
import { parseOfficialCourseTree } from "../src/server/services/courseCatalog.js";

describe("官方课程目录快照", () => {
  it("按官网层级排序，并把旧课程名转换为佛法要领", () => {
    const payload = {
      data: [
        { id: 2, name: "学士课程", children: [{ id: 201, sort: 1, contentInfoList: [{ id: 1, sort: 1, title: "第1课" }] }] },
        { id: 3, name: "修士课程", children: [
          { id: 303, name: "《菩提道次第略论》系列讲座", children: [{ id: 1, sort: 1, contentInfoList: [
            { id: 2, sort: 1, title: "《菩提道次第略论》第1课" },
            { id: 3, sort: 2, title: "《菩提道次第略论》复习课1" }
          ] }] },
          { id: 304, name: "三主要道颂", contentInfoList: [{ id: 4, title: "第1课" }] },
          { id: 309, name: "百法", contentInfoList: [{ id: 5, title: "第1课" }] },
          { id: 311, name: "辩修", contentInfoList: [{ id: 6, title: "第1课" }] }
        ] },
        { id: 4, name: "胜士课程", children: [
          { id: 402, name: "入菩萨行论", contentInfoList: [{ id: 7, title: "第1课" }] },
          { id: 403, name: "戒品", contentInfoList: [{ id: 8, title: "第1课" }] }
        ] }
      ]
    };
    const catalog = parseOfficialCourseTree(payload);
    const essentials = catalog.find((entry) => entry.key === "dharma_essentials")!;
    expect(essentials.displayName).toBe("佛法要领");
    expect(essentials.items[0].title).toBe("《佛法要领》第1课");
    expect(essentials.items[1].lessonType).toBe("review");
    expect(JSON.stringify(catalog)).not.toContain("道次第");
  });
});

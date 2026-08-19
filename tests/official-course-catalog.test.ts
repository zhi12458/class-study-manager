import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/db.js";
import { parseOfficialCourseTree, replaceCourseCatalog } from "../src/server/services/courseCatalog.js";

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
        ] },
        { id: 5, name: "智士课程", contentInfoList: [
          { id: 9, title: "晋级开示：入不二法门" }
        ], children: [
          { id: 502, name: "《辩中边论》系列讲座", contentInfoList: [
            { id: 10, sort: 2, title: "《辩中边论》第2课" },
            { id: 11, sort: 1, title: "《辩中边论》第1课" }
          ] },
          { id: 503, name: "《唯识三十论》系列讲座", contentInfoList: [{ id: 12, title: "《唯识三十论》第1课" }] },
          { id: 504, name: "《心经的人生智慧》", contentInfoList: [{ id: 13, title: "《心经的人生智慧》第1课" }] },
          { id: 505, name: "《心经的禅观》", contentInfoList: [{ id: 14, title: "《心经的禅观》第1课" }] },
          { id: 506, name: "《金刚经》系列讲座", contentInfoList: [{ id: 15, title: "《金刚经》第1课" }] },
          { id: 507, name: "《普贤行愿品的观修原理》", contentInfoList: [{ id: 16, title: "《普贤行愿品》第1课" }] },
          { id: 508, name: "《六祖坛经》系列讲座", contentInfoList: [{ id: 17, title: "《六祖坛经》第1课" }] }
        ] }
      ]
    };
    const catalog = parseOfficialCourseTree(payload);
    const essentials = catalog.find((entry) => entry.key === "dharma_essentials")!;
    expect(essentials.displayName).toBe("佛法要领");
    expect(essentials.items[0].title).toBe("《佛法要领》第1课");
    expect(essentials.items[1].lessonType).toBe("review");
    expect(JSON.stringify(catalog)).not.toContain("道次第");

    const sageCatalog = catalog.slice(-8);
    expect(sageCatalog.map((entry) => entry.displayName)).toEqual([
      "智士晋级开示", "辩中边论", "唯识三十论", "心经的人生智慧",
      "心经的禅观", "金刚经", "普贤行愿品的观修原理", "六祖坛经"
    ]);
    expect(sageCatalog[0].items.map((item) => item.title)).toEqual([
      "晋级开示：入不二法门",
      "《辩中边论》第1课",
      "《辩中边论》第2课",
      "《唯识三十论》第1课",
      "《心经的人生智慧》第1课",
      "《心经的禅观》第1课",
      "《金刚经》第1课",
      "《普贤行愿品》第1课",
      "《六祖坛经》第1课"
    ]);
    expect(sageCatalog[1].items.map((item) => item.title)).toEqual([
      "《辩中边论》第1课",
      "《辩中边论》第2课",
      "《唯识三十论》第1课",
      "《心经的人生智慧》第1课",
      "《心经的禅观》第1课",
      "《金刚经》第1课",
      "《普贤行愿品》第1课",
      "《六祖坛经》第1课"
    ]);
    expect(sageCatalog[3].items.map((item) => item.title)).toEqual([
      "《心经的人生智慧》第1课",
      "《心经的禅观》第1课",
      "《金刚经》第1课",
      "《普贤行愿品》第1课",
      "《六祖坛经》第1课"
    ]);

    const ownCourseIds = [
      [1],
      [2, 3],
      [4],
      [5],
      [6],
      [7],
      [8],
      [9],
      [11, 10],
      [12],
      [13],
      [14],
      [15],
      [16],
      [17]
    ];
    catalog.forEach((entry, index) => {
      expect(entry.items.map((item) => item.sourceId), `${entry.displayName} 应衔接所有后续课程`).toEqual(
        ownCourseIds.slice(index).flat()
      );
    });

    const db = openDatabase(":memory:");
    try {
      expect(() => replaceCourseCatalog(db, catalog)).not.toThrow();
      expect(db.prepare(
        "select count(*) as count from course_catalog_items where source_id = 17",
      ).get()).toEqual({ count: catalog.length });
      expect(db.prepare(
        "select count(*) as count from course_catalog_items where series_key = 'diamond_sutra'",
      ).get()).toEqual({ count: 3 });
    } finally {
      db.close();
    }

    const incomplete = structuredClone(payload) as unknown as {
      data: Array<{ id: number; children?: Array<{ id: number }> }>;
    };
    const sage = incomplete.data.find((node) => node.id === 5)!;
    sage.children = sage.children?.filter((node) => node.id !== 508);
    expect(() => parseOfficialCourseTree(incomplete)).toThrow("官方课程目录不完整，缺少：六祖坛经");
  });
});

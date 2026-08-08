import type { LessonType } from "./types.js";

export interface CourseCatalogEntry {
  title: string;
  lessonType: LessonType;
}

/** 旧版生产系统中已配置的完整课程顺序。 */
export const DEFAULT_COURSES: readonly CourseCatalogEntry[] = [
  { title: "《当代宗教信仰问题思考》", lessonType: "regular" },
  { title: "《佛教与中国传统文化》", lessonType: "regular" },
  { title: "《人生五大问题》", lessonType: "regular" },
  { title: "《信仰与人生》", lessonType: "regular" },
  { title: "《慈经》的修行", lessonType: "regular" },
  { title: "《班级慈善关爱》", lessonType: "regular" },
  { title: "同喜班复习课之一", lessonType: "review" },
  { title: "生命的学习方法（八步骤）", lessonType: "regular" },
  { title: "《认识人格密码，开启八三禅修》", lessonType: "regular" },
  { title: "学习使用“元日记”", lessonType: "regular" },
  { title: "《心灵创造幸福》", lessonType: "regular" },
  { title: "《生命的回归》", lessonType: "regular" },
  { title: "《佛教徒的人生态度》之一", lessonType: "regular" },
  { title: "《佛教徒的人生态度》之二", lessonType: "regular" },
  { title: "《佛教徒的人生态度》之三", lessonType: "regular" },
  { title: "《班级经营手册》", lessonType: "regular" },
  { title: "《心理学视角的佛学世界》", lessonType: "regular" },
  { title: "《茶与禅的修行》", lessonType: "regular" },
  { title: "《静茶七式》——泡好一杯茶", lessonType: "regular" },
  { title: "菩提导航攻略", lessonType: "regular" },
  { title: "同喜班复习课之二", lessonType: "review" },
  { title: "《初级慈经禅修》(慈心实践课)", lessonType: "regular" },
  { title: "《传递善意，点亮心灯》", lessonType: "regular" },
  { title: "《传承国学，为现代人安身立命》", lessonType: "regular" },
  { title: "《人工智能时代，人类何去何从》", lessonType: "regular" },
  { title: "感恩实践课", lessonType: "regular" },
  { title: "《佛教的世界观》", lessonType: "regular" },
  { title: "《佛教的财富观》", lessonType: "regular" },
  { title: "随喜实践课", lessonType: "regular" },
  { title: "《佛教的环保思想》", lessonType: "regular" },
  { title: "《从物品整理到心灵整理》", lessonType: "regular" },
  { title: "《佛法在家庭教育中的运用》", lessonType: "regular" },
  { title: "佛门礼仪", lessonType: "regular" },
  { title: "同喜班复习课之三", lessonType: "review" },
  { title: "《正念禅修十要素》", lessonType: "regular" },
  { title: "《盘坐、呼吸对禅修的意义》", lessonType: "regular" },
  { title: "《正念盘坐八式》", lessonType: "regular" },
  { title: "《正念呼吸七式》", lessonType: "regular" },
  { title: "《初级正念禅修》", lessonType: "regular" },
  { title: "同喜班复习课之四", lessonType: "review" },
  { title: "《行到水穷处，坐看云起时》", lessonType: "regular" },
  { title: "《重新估量价值，探寻人类出路》", lessonType: "regular" },
  { title: "《佛法修学次第的思考》", lessonType: "regular" },
  { title: "布施实践课", lessonType: "regular" },
  { title: "《千手千眼，大慈大悲》", lessonType: "regular" },
  { title: "欢欢喜喜义工行", lessonType: "regular" },
  { title: "理解、同情、接纳实践课", lessonType: "regular" },
  { title: "传灯实践课——如何开展一场读书会", lessonType: "regular" },
  { title: "养生实践课——正念八段锦", lessonType: "regular" },
  { title: "同喜班复习课之五", lessonType: "review" },
];

/** 新班级的“智慧人生”从官方第 1 课开始；旧课表继续保留原有顺序。 */
export const WISDOM_LIFE_COURSES: readonly CourseCatalogEntry[] = [
  { title: "第1课 《认识静心学堂》（《静心学堂学员手册》选读）", lessonType: "regular" },
  ...DEFAULT_COURSES
];

export function coursePlanForRange(startSequence: number, count: number): {
  titles: string[];
  lessonTypes: LessonType[];
} {
  const entries = Array.from({ length: count }, (_, index) => DEFAULT_COURSES[startSequence + index - 1]);
  return {
    titles: entries.map((entry) => entry?.title ?? ""),
    lessonTypes: entries.map((entry) => entry?.lessonType ?? "regular"),
  };
}

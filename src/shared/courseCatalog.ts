/**
 * 旧系统“坐看云起班”中已经填写的课程主题，按首次出现顺序去重。
 * 旧系统其余预排活动尚未填写主题，因此后续课次继续使用“第 N 课”。
 */
export const DEFAULT_COURSE_TITLES = [
  "学员手册",
  "当代宗教信仰问题的思考",
  "佛教与中国传统文化",
  "人生五大问题",
] as const;

export function courseTitlesForRange(startSequence: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    DEFAULT_COURSE_TITLES[startSequence + index - 1] ?? ""
  );
}

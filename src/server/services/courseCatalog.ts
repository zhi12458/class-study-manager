import type { DatabaseSync } from "node:sqlite";
import type { LessonType } from "../../shared/types.js";

const OFFICIAL_CATALOG_URL = "https://mindfulpeace.org/api/course/tree";

interface SourceItem { id?: number; sort?: number | null; title?: string }
interface SourceNode {
  id?: number;
  name?: string;
  sort?: number | null;
  children?: SourceNode[];
  contentInfoList?: SourceItem[];
}

export interface CatalogItem {
  position: number;
  sourceId: number | null;
  title: string;
  lessonType: LessonType;
}

export interface CatalogSeries {
  key: string;
  displayName: string;
  sourceName: string;
  items: CatalogItem[];
}

function sortedItems(items?: SourceItem[] | null): SourceItem[] {
  const order = (item: SourceItem) => {
    const lessonNumber = String(item.title ?? "").match(/第\s*(\d+)\s*课/)?.[1];
    return lessonNumber ? Number(lessonNumber) : item.sort ?? 9999;
  };
  return [...(items ?? [])].sort((a, b) => order(a) - order(b) || (a.sort ?? 9999) - (b.sort ?? 9999) || (a.id ?? 0) - (b.id ?? 0));
}

function firstLessonNumber(node: SourceNode): number {
  const numbers = [
    ...(node.contentInfoList ?? []).map((item) => Number(String(item.title ?? "").match(/第\s*(\d+)\s*课/)?.[1] ?? Infinity)),
    ...(node.children ?? []).map(firstLessonNumber)
  ];
  return Math.min(...numbers, Infinity);
}

function sortedNodes(nodes?: SourceNode[] | null): SourceNode[] {
  return [...(nodes ?? [])].sort((a, b) => {
    const lessonDifference = firstLessonNumber(a) - firstLessonNumber(b);
    if (Number.isFinite(lessonDifference) && lessonDifference !== 0) return lessonDifference;
    return (a.sort ?? 9999) - (b.sort ?? 9999) || (a.id ?? 0) - (b.id ?? 0);
  });
}

function collect(node: SourceNode): SourceItem[] {
  return [
    ...sortedItems(node.contentInfoList),
    ...sortedNodes(node.children).flatMap(collect)
  ];
}

function displayTitle(title: string): string {
  return title.replaceAll("菩提道次第略论", "佛法要领").replaceAll("道次第", "佛法要领");
}

function series(key: string, displayName: string, node: SourceNode): CatalogSeries {
  return {
    key,
    displayName,
    sourceName: displayTitle(String(node.name ?? displayName)),
    items: collect(node).map((item, index) => {
      const title = displayTitle(String(item.title ?? `第${index + 1}课`));
      return {
        position: index + 1,
        sourceId: item.id == null ? null : Number(item.id),
        title,
        lessonType: title.includes("复习课") ? "review" : "regular"
      };
    })
  };
}

export function parseOfficialCourseTree(payload: unknown): CatalogSeries[] {
  const root = payload && typeof payload === "object" ? payload as { data?: SourceNode[] } : {};
  const roots = root.data ?? [];
  const bachelor = roots.find((node) => node.id === 2);
  const practitioner = roots.find((node) => node.id === 3);
  const advanced = roots.find((node) => node.id === 4);
  if (!bachelor || !practitioner || !advanced) throw new Error("官方课程目录结构不完整");
  const practitionerChild = (id: number) => practitioner.children?.find((node) => node.id === id);
  const advancedChild = (id: number) => advanced.children?.find((node) => node.id === id);
  const definitions: Array<[string, string, SourceNode | undefined]> = [
    ["wisdom_life", "智慧人生", bachelor],
    ["dharma_essentials", "佛法要领", practitionerChild(303)],
    ["three_principal_paths", "三主要道颂", practitionerChild(304)],
    ["hundred_dharmas", "百法明门论", practitionerChild(309)],
    ["meditation_treatise", "辩中边论·辩修对治品", practitionerChild(311)],
    ["bodhisattva_way", "入菩萨行论", advancedChild(402)],
    ["bodhisattva_precepts", "瑜伽菩萨戒品", advancedChild(403)]
  ];
  return definitions.flatMap(([key, name, node]) => node ? [series(key, name, node)] : []);
}

export function replaceCourseCatalog(db: DatabaseSync, catalog: CatalogSeries[]): void {
  if (!catalog.length || catalog.some((entry) => !entry.items.length)) throw new Error("课程目录为空，未更新本地快照");
  db.exec("begin immediate");
  try {
    db.prepare("delete from course_catalog_items").run();
    db.prepare("delete from course_catalog_series").run();
    const insertSeries = db.prepare(
      "insert into course_catalog_series (key, display_name, source_name, sort_order, synced_at) values (?, ?, ?, ?, current_timestamp)"
    );
    const insertItem = db.prepare(
      "insert into course_catalog_items (series_key, position, source_id, title, lesson_type) values (?, ?, ?, ?, ?)"
    );
    catalog.forEach((entry, index) => {
      insertSeries.run(entry.key, entry.displayName, entry.sourceName, index + 1);
      entry.items.forEach((item) => insertItem.run(entry.key, item.position, item.sourceId, item.title, item.lessonType));
    });
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export async function syncOfficialCourseCatalog(db: DatabaseSync): Promise<CatalogSeries[]> {
  const response = await fetch(OFFICIAL_CATALOG_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`官方课程目录读取失败（${response.status}）`);
  const catalog = parseOfficialCourseTree(await response.json());
  replaceCourseCatalog(db, catalog);
  return catalog;
}

export function listCourseCatalog(db: DatabaseSync) {
  const rows = db.prepare(
    `select s.key, s.display_name as displayName, s.source_name as sourceName, s.synced_at as syncedAt,
            i.position, i.title, i.lesson_type as lessonType
       from course_catalog_series s
       left join course_catalog_items i on i.series_key = s.key
      order by s.sort_order, i.position`
  ).all() as Array<Record<string, unknown>>;
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = String(row.key);
    const entry = result.get(key) ?? {
      key, displayName: row.displayName, sourceName: row.sourceName, syncedAt: row.syncedAt, items: []
    };
    if (row.position != null) (entry.items as unknown[]).push({
      position: Number(row.position), title: String(row.title), lessonType: row.lessonType
    });
    result.set(key, entry);
  }
  return [...result.values()];
}

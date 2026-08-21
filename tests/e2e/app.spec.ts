import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, identifier = "admin", password = "E2eAdmin!2026"): Promise<void> {
  await page.goto("/");
  await page.getByLabel("账号或手机号").fill(identifier);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page.getByRole("heading", { name: /浏览器回归测试班/ })).toBeVisible();
}

async function navigate(page: Page, label: string): Promise<void> {
  const menu = page.getByRole("button", { name: "打开菜单" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: label, exact: true }).click();
}

async function logout(page: Page): Promise<void> {
  const menu = page.getByRole("button", { name: "打开菜单" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "退出登录" }).click();
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("页面声明禁止自动翻译以保护动态考勤界面", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("translate", "no");
  await expect(page.locator('meta[name="google"]')).toHaveAttribute("content", "notranslate");
  await navigate(page, "考勤登记");
  await expect(page.getByRole("heading", { name: "考勤登记" })).toBeVisible();
});

test("历史自定义范围驱动页面、Excel和CSV使用同一日期", async ({ page }) => {
  await navigate(page, "完成统计");
  await page.getByRole("tab", { name: "历史" }).click();
  await page.getByRole("button", { name: "自定义时间段" }).click();
  const start = page.getByLabel("开始日期");
  const end = page.getByLabel("结束日期");
  const from = await start.inputValue();
  const csv = page.getByRole("link", { name: "CSV" });
  const excel = page.getByRole("link", { name: "Excel" });
  const appliedHref = await csv.getAttribute("href");
  await end.fill(from);
  await expect(csv).toHaveAttribute("href", appliedHref!);
  await expect(page.getByText(/日期尚未查询；当前统计和导出仍使用/)).toBeVisible();
  await page.getByRole("button", { name: "查询" }).click();
  await expect(page.getByText(`${from} 至 ${from}`, { exact: true }).first()).toBeVisible();

  await expect(csv).toHaveAttribute("href", new RegExp(`range=custom.*from=${from}.*to=${from}`));
  await expect(excel).toHaveAttribute("href", new RegExp(`range=custom.*from=${from}.*to=${from}`));

  const csvDownload = page.waitForEvent("download");
  await csv.click();
  await expect((await csvDownload).suggestedFilename()).toBe(`class-study-report-${from.replaceAll("-", "")}-${from.replaceAll("-", "")}.csv`);
  const excelDownload = page.waitForEvent("download");
  await excel.click();
  await expect((await excelDownload).suggestedFilename()).toBe(`class-study-report-${from.replaceAll("-", "")}-${from.replaceAll("-", "")}.xlsx`);
});

test("弹窗限制键盘焦点并在关闭后回到触发按钮", async ({ page }) => {
  await navigate(page, "学员名单");
  const trigger = page.getByRole("button", { name: "新增学员" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "新增学员" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "保存" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("主要管理页面和考勤保存流程可操作", async ({ page }, testInfo) => {
  await navigate(page, "考勤登记");
  const lessonOptionLabels = await page.getByRole("combobox", { name: "选择课次" }).locator("option").allTextContents();
  expect(lessonOptionLabels.every((label) => !/^第\s*\d+\s*课\s*·/.test(label))).toBe(true);
  await expect(page.locator(".lesson-summary-bar .soft-badge")).toHaveCount(0);
  await expect(page.getByRole("option", { name: "补课" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "补课" })).toHaveCount(0);
  for (const metric of ["组修", "班修"]) {
    await expect(page.getByRole("combobox", { name: metric, exact: true }).locator("option")).toHaveText([
      "保持不变", "现场", "网络", "公差", "旷课", "旁听",
    ]);
  }
  const mobile = testInfo.project.name === "mobile";
  await page.getByRole("combobox", { name: "导图/提纲", exact: true }).selectOption(mobile ? "no" : "yes");
  await page.getByRole("combobox", { name: "组修", exact: true }).selectOption(mobile ? "absent" : "onsite");
  await page.getByRole("combobox", { name: "班修", exact: true }).selectOption(mobile ? "observer" : "onsite");
  await page.getByRole("button", { name: /应用到 \d+ 人/ }).click();
  const saveAttendance = page.getByRole("button", { name: "保存本课考勤" });
  await expect(saveAttendance).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  const saveResponse = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/attendance/"));
  await saveAttendance.click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.getByText("考勤已保存，并记录了本次修改人和时间")).toBeVisible();

  await page.getByRole("combobox", { name: "选择课次" }).selectOption({ index: 2 });
  await expect(page.getByText(/本课尚未开始，将于 \d{4}-\d{2}-\d{2} 开放考勤/)).toBeVisible();
  await expect(page.getByText("您没有编辑本课考勤的权限。")).toHaveCount(0);
  await expect(page.getByText("测试学员", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByLabel("测试学员的组修").filter({ visible: true }).getByRole("button", { name: "现场" })).toBeDisabled();
  await expect(saveAttendance).toBeDisabled();

  await navigate(page, "课表安排");
  await expect(page.getByText(/截止日当天仍可调整/)).toBeVisible();
  const lockedLessonEdit = page.getByRole("button", { name: "编辑第 1 个课次" });
  await expect(lockedLessonEdit).toBeEnabled();
  await expect(lockedLessonEdit).toHaveAttribute("title", /管理员可编辑/);
  const catalogPayload = {
    series: [
      { key: "wisdom_life", displayName: "智慧人生", items: [1, 2, 3, 4].map((position) => ({ position, title: `智慧人生第${position}课`, lessonType: "regular" })) },
      { key: "next_course", displayName: "下一套课程", items: [{ position: 1, title: "下一套课程第1课", lessonType: "regular" }] }
    ]
  };
  await page.route("**/api/course-catalog", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(catalogPayload) }));
  await page.route("**/api/admin/course-catalog/sync", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ seriesCount: 2, itemCount: 5 }) }));
  await page.getByRole("button", { name: "追加课次" }).click();
  const appendDialog = page.getByRole("dialog", { name: "追加课次" });
  await expect(appendDialog.getByLabel("追加哪套课程")).toBeVisible();
  await expect(appendDialog.getByLabel("从哪一课开始")).toHaveValue("4");
  await appendDialog.getByLabel("追加哪套课程").selectOption("next_course");
  await appendDialog.getByRole("button", { name: "刷新目录" }).click();
  await expect(appendDialog.getByLabel("追加哪套课程")).toHaveValue("next_course");
  await expect(appendDialog.getByLabel("从哪一课开始")).toHaveValue("1");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "重新生成可调整课表" }).click();
  const rebuildDialog = page.getByRole("dialog", { name: "重新生成可调整课表" });
  await expect(rebuildDialog).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "放假 / 暂停周" }).click();
  const addBreakDialog = page.getByRole("dialog", { name: "插入放假 / 暂停周" });
  await addBreakDialog.getByLabel("暂停周日期").fill("2099-12-01");
  await addBreakDialog.getByLabel("说明").fill("E2E暂停周");
  const addBreakResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/breaks"));
  await addBreakDialog.getByRole("button", { name: "插入并顺延" }).click();
  expect((await addBreakResponse).status()).toBe(200);
  await page.getByRole("button", { name: "修改E2E暂停周" }).click();
  const editBreakDialog = page.getByRole("dialog", { name: "修改放假 / 暂停周" });
  await editBreakDialog.getByLabel("说明").fill("E2E暂停周已修改");
  const editBreakResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/breaks/"));
  await editBreakDialog.getByRole("button", { name: "保存并重算课表" }).click();
  expect((await editBreakResponse).status()).toBe(200);
  await expect(page.getByText("E2E暂停周已修改", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  const deleteBreakResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().includes("/breaks/"));
  await page.getByRole("button", { name: "删除E2E暂停周已修改" }).click();
  expect((await deleteBreakResponse).status()).toBe(200);
  await expect(page.getByText("E2E暂停周已修改", { exact: true })).toHaveCount(0);

  await navigate(page, "学员名单");
  await expect(page.getByRole("button", { name: "Excel 导入" })).toBeVisible();
  await navigate(page, "班级设置");
  await expect(page.getByLabel("选择班长")).toBeVisible();
});

test("班长可管理未来课表但看不到其他班级管理入口", async ({ page }) => {
  await logout(page);
  await login(page, "monitor-e2e", "E2eMonitor!2026");

  await expect(page.getByRole("button", { name: "学员名单", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "小组管理", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "班级设置", exact: true })).toHaveCount(0);
  await navigate(page, "课表安排");

  await expect(page.getByRole("button", { name: "放假 / 暂停周" })).toBeVisible();
  await expect(page.getByRole("button", { name: "插入课次" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新生成可调整课表" })).toBeVisible();
  await expect(page.getByRole("button", { name: "追加课次" })).toBeVisible();

  await page.getByRole("button", { name: "编辑第 3 个课次" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑第 3 个课次" });
  await dialog.getByLabel("课次名称").fill("班长更新的未来课");
  const saveResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/lessons/"));
  await dialog.getByRole("button", { name: "保存修改并顺延" }).click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.getByText("班长更新的未来课", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "重新生成可调整课表" }).click();
  const rebuild = page.getByRole("dialog", { name: "重新生成可调整课表" });
  await expect(rebuild.getByRole("button", { name: "刷新目录" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("考勤员只能进入考勤和统计，不能打开课表、名册、设置或导出", async ({ page }) => {
  await logout(page);
  await login(page, "attendance-e2e", "E2eAttendance!2026");

  await expect(page.locator(".topbar-right .role-badge")).toHaveText("考勤员");
  for (const hidden of ["学员名单", "小组管理", "课表安排", "班级设置"]) {
    await expect(page.getByRole("button", { name: hidden, exact: true })).toHaveCount(0);
  }

  await navigate(page, "完成统计");
  await expect(page.getByRole("link", { name: "Excel" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "CSV" })).toHaveCount(0);
  await navigate(page, "考勤登记");
  await expect(page.getByRole("heading", { name: "批量填写" })).toBeVisible();

  await page.goto("/lessons");
  await expect(page.getByRole("heading", { name: /浏览器回归测试班/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "课表安排" })).toHaveCount(0);
});

test("管理员可从现有学员中启用辅导员资格", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "避免跨项目重复修改同一测试人员");
  await navigate(page, "全部班级");
  const trigger = page.getByRole("button", { name: "添加辅导员" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "添加辅导员" });
  await expect(dialog.getByRole("button", { name: "从现有学员选择" })).toHaveClass(/active/);
  await dialog.getByLabel("搜索学员").fill("善选");
  const candidate = dialog.getByText("辅导候选", { exact: true });
  await expect(candidate).toBeVisible();
  await candidate.click();
  const promoteResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/admin/counselors"));
  await dialog.getByRole("button", { name: "启用辅导员资格" }).click();
  expect((await promoteResponse).status()).toBe(200);
  await expect(page.getByText(/辅导员账号已创建：.*临时密码：/)).toBeVisible();

  await page.getByRole("button", { name: "管理辅导员" }).click();
  await expect(page.getByRole("dialog", { name: "辅导员账号管理" }).getByText("辅导候选", { exact: true }).first()).toBeVisible();
});

test("手机菜单公开正确状态并可用Escape关闭", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "仅验证手机导航");
  const menu = page.getByRole("button", { name: "打开菜单" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "关闭菜单" }).last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
});

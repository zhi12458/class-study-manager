import { expect, test, type Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("账号或手机号").fill("admin");
  await page.getByLabel("密码").fill("E2eAdmin!2026");
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page.getByRole("heading", { name: /浏览器回归测试班/ })).toBeVisible();
}

async function navigate(page: Page, label: string): Promise<void> {
  const menu = page.getByRole("button", { name: "打开菜单" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: label, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await login(page);
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
  const mobile = testInfo.project.name === "mobile";
  await page.getByRole("combobox", { name: "导图/提纲", exact: true }).selectOption(mobile ? "no" : "yes");
  await page.getByRole("combobox", { name: "组修", exact: true }).selectOption(mobile ? "absent" : "present");
  await page.getByRole("combobox", { name: "班修", exact: true }).selectOption(mobile ? "share" : "onsite");
  await page.getByRole("button", { name: /应用到 1 人/ }).click();
  const saveAttendance = page.getByRole("button", { name: "保存本课考勤" });
  await expect(saveAttendance).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  const saveResponse = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/attendance/"));
  await saveAttendance.click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.getByText("考勤已保存，并记录了本次修改人和时间")).toBeVisible();

  await navigate(page, "课表安排");
  await page.getByRole("button", { name: "重新生成未来课表" }).click();
  await expect(page.getByRole("dialog", { name: "重新生成未来课表" })).toBeVisible();
  await page.keyboard.press("Escape");

  await navigate(page, "学员名单");
  await expect(page.getByRole("button", { name: "Excel 导入" })).toBeVisible();
  await navigate(page, "班级设置");
  await expect(page.getByLabel("选择班长")).toBeVisible();
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

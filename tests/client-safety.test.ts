import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("客户端页面安全兜底", () => {
  it("禁止浏览器自动翻译修改 React 管理的页面节点", () => {
    const html = readFileSync("src/client/index.html", "utf8");
    expect(html).toContain('<html lang="zh-CN" class="notranslate" translate="no">');
    expect(html).toContain('<meta name="google" content="notranslate" />');
  });

  it("应用入口提供渲染异常提示和重新加载操作", () => {
    const entry = readFileSync("src/client/main.tsx", "utf8");
    expect(entry).toContain("class AppErrorBoundary");
    expect(entry).toContain("页面暂时无法显示");
    expect(entry).toContain("window.location.reload()");
  });
});

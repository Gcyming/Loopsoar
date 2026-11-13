/**
 * 会话搜索相关性评分：精确标题 > 前缀 > 包含 > 预览 > 多词元命中；用于侧栏会话列表搜索排序。
 */
import { describe, expect, it } from "vitest";
import { sessionMatchScore } from "../../packages/ui/src/sessionSearch.ts";

function session(title: string, preview = "") {
  return { title, preview };
}

describe("sessionMatchScore", () => {
  it("精确标题 1000 > 前缀 800 > 包含 600 > 预览 300 > 多词元 200 > 不匹配 0", () => {
    expect(sessionMatchScore(session("修复登录"), "修复登录")).toBe(1000);
    expect(sessionMatchScore(session("修复登录页"), "修复登录")).toBe(800);
    expect(sessionMatchScore(session("请修复登录页"), "修复登录")).toBe(600);
    expect(sessionMatchScore(session("别的话题", "今天修复登录"), "修复登录")).toBe(300);
    expect(sessionMatchScore(session("Loopsoar 的登录修复", ""), "loopsoar 登录")).toBe(200);
    expect(sessionMatchScore(session("无关会话", ""), "修复登录")).toBe(0);
  });

  it("大小写不敏感；空白查询返回 0", () => {
    expect(sessionMatchScore(session("Loopsoar Fix"), "loopsoar")).toBe(800);
    expect(sessionMatchScore(session("Loopsoar Fix"), "   ")).toBe(0);
  });
});

/**
 * 终端文本纯函数单测：ANSI 剥离 / 终端语义规范化 / 行数上限。
 * 终端面板的「可读性」全部依赖这三步，出 bug 的表现是乱码或内存暴涨，所以锁死边界行为。
 */
import { describe, expect, it } from "vitest";
import {
  limitLines,
  normalizeTerminalText,
  stripAnsi,
  TERMINAL_MAX_LINES,
} from "../../packages/ui/src/terminalAnsi.ts";

describe("stripAnsi：剥离控制序列", () => {
  it("去掉 SGR 颜色/加粗等 CSI 序列，保留可读文本", () => {
    expect(stripAnsi("\x1b[31m红色\x1b[0m")).toBe("红色");
    expect(stripAnsi("\x1b[1;32mOK\x1b[0m done")).toBe("OK done");
    expect(stripAnsi("a\x1b[38;5;196mb\x1b[0mc")).toBe("abc");
  });

  it("去掉光标移动 / 清屏等 CSI 序列", () => {
    expect(stripAnsi("\x1b[2J\x1b[H清屏后")).toBe("清屏后");
    expect(stripAnsi("abc\x1b[2K\x1b[1;1Hdef")).toBe("abcdef");
  });

  it("去掉 OSC（窗口标题 / 超链接），BEL 与 ST 两种结尾都支持", () => {
    expect(stripAnsi("\x1b]0;窗口标题\x07正文")).toBe("正文");
    expect(stripAnsi("\x1b]8;;https://example.com\x1b\\链接\x1b]8;;\x1b\\")).toBe("链接");
  });

  it("去掉单字符转义与字符集切换序列", () => {
    expect(stripAnsi("a\x1b7b\x1b8c")).toBe("abc"); // save/restore cursor
    expect(stripAnsi("\x1b(Babc")).toBe("abc"); // ESC ( B：切 ASCII 字符集
  });

  it("不完整序列吞到结尾，不把半个控制串漏到界面", () => {
    expect(stripAnsi("前缀\x1b[31")).toBe("前缀");
    expect(stripAnsi("前缀\x1b")).toBe("前缀");
    expect(stripAnsi("\x1b]0;没有结尾的 OSC")).toBe("");
  });

  it("普通文本原样返回；不处理 \\r/\\b（交给 normalizeTerminalText）", () => {
    expect(stripAnsi("")).toBe("");
    expect(stripAnsi("hello 世界")).toBe("hello 世界");
    expect(stripAnsi("进度 50%\r")).toBe("进度 50%\r");
  });

  it("兼容 C1 形式的 CSI（0x9B）", () => {
    expect(stripAnsi("a\u009b31mb")).toBe("ab");
  });
});

describe("normalizeTerminalText：终端语义规范化", () => {
  it("\\r\\n 统一成 \\n", () => {
    expect(normalizeTerminalText("line1\r\nline2")).toBe("line1\nline2");
    expect(normalizeTerminalText("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("单独 \\r 视为回到行首重写（进度条原地刷新）", () => {
    expect(normalizeTerminalText("下载 10%\r下载 100%")).toBe("下载 100%");
    expect(normalizeTerminalText("one\rtwo\nthree")).toBe("two\nthree");
  });

  it("退格删除行尾字符，不跨行", () => {
    expect(normalizeTerminalText("abc\b\bde")).toBe("ade");
    expect(normalizeTerminalText("x\b")).toBe("");
    expect(normalizeTerminalText("a\nb\b")).toBe("a\n"); // 退格只作用于当前行：b 被删空，a 所在行不受影响
  });

  it("退格对 emoji（代理对）整体删除，不留下半个码元", () => {
    expect(normalizeTerminalText("a😀\b")).toBe("a");
  });

  it("丢弃 BEL 等其余控制字符，保留 tab 与可读内容", () => {
    expect(normalizeTerminalText("a\x07b\tc")).toBe("ab\tc");
    expect(normalizeTerminalText("a\x00b\x1fc")).toBe("abc");
    expect(normalizeTerminalText("")).toBe("");
  });

  it("保留末尾换行（终端结尾的换行是真实行结构）", () => {
    expect(normalizeTerminalText("a\n")).toBe("a\n");
    expect(normalizeTerminalText("a\n\nb")).toBe("a\n\nb");
  });
});

describe("limitLines：行数上限", () => {
  it("未超上限时原样返回（含末尾换行细节）", () => {
    expect(limitLines("a\nb\nc", 3)).toBe("a\nb\nc");
    expect(limitLines("a\nb\nc", 10)).toBe("a\nb\nc");
    expect(limitLines("a\n", 5)).toBe("a\n");
  });

  it("超上限时只保留最后 maxLines 行", () => {
    expect(limitLines("a\nb\nc", 2)).toBe("b\nc");
    expect(limitLines("l1\nl2\nl3\nl4", 2)).toBe("l3\nl4");
  });

  it("非法上限返回空串", () => {
    expect(limitLines("a\nb", 0)).toBe("");
    expect(limitLines("a\nb", -3)).toBe("");
    expect(limitLines("a\nb", Number.NaN)).toBe("");
    expect(limitLines("", 5)).toBe("");
  });

  it("上限取整（向下）", () => {
    expect(limitLines("a\nb\nc", 2.9)).toBe("b\nc");
  });

  it("默认行数常量 2 万行", () => {
    expect(TERMINAL_MAX_LINES).toBe(20000);
  });
});

describe("组合管线：ANSI 输出 → 可读文本", () => {
  it("颜色 + 进度条 + 退格 + 限行", () => {
    const raw = "\x1b[32m编译中 1%\r\x1b[32m编译中 100%\x1b[0m\n\x1b[31m错误：x\x1b[0m\nok\bdone";
    const text = limitLines(normalizeTerminalText(stripAnsi(raw)), 2);
    // 第 1 行被 \r 重写成 100%；最后一行 ok\bdone → odone（退格删 k）；保留最后 2 行
    expect(text).toBe("错误：x\nodone");
  });
});

/**
 * T6 测试：packages/core/src/tools/classifier.ts
 * 覆盖 isSensitivePath / isProtectedSourceDir / classifyCommand
 * 数据源：packages/contracts/src/security-policy.ts
 */
import { describe, expect, it } from "vitest";
import {
  isSensitivePath,
  isProtectedSourceDir,
  classifyCommand,
} from "../../packages/core/src/tools/classifier.ts";

describe("isSensitivePath", () => {
  it("精确匹配：.env → true", () => {
    expect(isSensitivePath("/home/user/.env")).toBe(true);
  });

  it("精确匹配：AGENTS.md → true", () => {
    expect(isSensitivePath("docs/AGENTS.md")).toBe(true);
  });

  it("通配符 *.pem 匹配任意 basename", () => {
    expect(isSensitivePath("/etc/ssl/server.pem")).toBe(true);
    expect(isSensitivePath("/etc/ssl/my.key")).toBe(true); // 也匹配 *.key
  });

  it("通配符 *.key 匹配 basename 含 .key", () => {
    expect(isSensitivePath("/etc/server.key")).toBe(true);
    expect(isSensitivePath("/etc/auth_token_2024.key")).toBe(true);
  });

  it("大小写不敏感：.ENV 仍匹配 .env", () => {
    expect(isSensitivePath("/x/.ENV")).toBe(true);
  });

  it("非敏感文件 → false", () => {
    expect(isSensitivePath("/etc/passwd")).toBe(false);
  });
});

describe("isProtectedSourceDir", () => {
  it(".git 受保护 → true（目录本身）", () => {
    expect(isProtectedSourceDir("/repo/.git")).toBe(true);
    expect(isProtectedSourceDir("/repo/.git/")).toBe(true);
  });

  it("node_modules 受保护 → true（目录本身）", () => {
    expect(isProtectedSourceDir("/repo/node_modules")).toBe(true);
    expect(isProtectedSourceDir("/repo/node_modules/")).toBe(true);
  });

  it("packages/contracts/gen 精确匹配尾部 → true（路径到目录本身）", () => {
    expect(isProtectedSourceDir("/repo/packages/contracts/gen")).toBe(true);
    expect(isProtectedSourceDir("/repo/packages/contracts/gen/")).toBe(true);
  });

  it("非受保护目录 → false", () => {
    expect(isProtectedSourceDir("/repo/src/index.ts")).toBe(false);
  });

  it("路径标准化：反斜杠转正斜杠后仍匹配（目录本身）", () => {
    expect(isProtectedSourceDir("\\repo\\node_modules")).toBe(true);
    expect(isProtectedSourceDir("\\repo\\.git")).toBe(true);
  });
});

describe("classifyCommand", () => {
  it("只读命令 cat/ls/echo/pwd → readonly", () => {
    expect(classifyCommand("cat /etc/hosts")).toBe("readonly");
    expect(classifyCommand("ls -la")).toBe("readonly");
    expect(classifyCommand("echo hello")).toBe("readonly");
    expect(classifyCommand("pwd")).toBe("readonly");
  });

  it("危险规则命中 → block（如 rm -rf /）", () => {
    expect(classifyCommand("rm -rf /")).toBe("block");
  });

  it("其他命令 → confirm（默认拒绝）", () => {
    expect(classifyCommand("unknown_cmd --flag")).toBe("confirm");
  });
});

/**
 * 敏感步骤分类器矩阵：中英 / 全半角 / 归一化 / URL（只看 host+path）/ 终端命令 / 误报口径。
 * 为什么用矩阵：这是「写死确认」的唯一判据，漏一个词就是支付或删号被静默执行；
 * 同时误报会直接伤害可用性（每个点击都弹窗），因此负面用例（不该命中）和正面用例同等重要。
 */
import { describe, expect, it } from "vitest";
import {
  classifySensitiveStep,
  normalizeSensitiveText,
  SENSITIVE_CATEGORY_LABELS,
  type SensitiveStepVerdict,
} from "../../packages/core/src/sensitiveSteps.ts";

function expectSensitive(verdict: SensitiveStepVerdict, category: "login" | "payment" | "irreversible"): void {
  expect(verdict.sensitive).toBe(true);
  expect(verdict.category).toBe(category);
  expect(verdict.reason).toContain("敏感步骤：");
  expect(verdict.reason).toContain(SENSITIVE_CATEGORY_LABELS[category]);
}

function expectSafe(verdict: SensitiveStepVerdict): void {
  expect(verdict.sensitive).toBe(false);
  expect(verdict.category).toBeNull();
  expect(verdict.reason).toBeUndefined();
}

describe("归一化：全角/零宽/空白/大小写", () => {
  it("NFKC 全角转半角 + 小写 + 折叠空白", () => {
    expect(normalizeSensitiveText("  ＬＯＧＩＮ   账号 ")).toBe("login 账号");
  });

  it("零宽字符不参与匹配但被识别时剔除", () => {
    expect(normalizeSensitiveText("登\u200b录")).toBe("登录");
  });
});

describe("只分类动作型工具（只读工具永不敏感）", () => {
  it("browser_snapshot / file_read 里出现敏感词也不触发", () => {
    expectSafe(classifySensitiveStep({ toolName: "browser_snapshot", params: { text: "登录 支付 删除账户" } }));
    expectSafe(classifySensitiveStep({ toolName: "file_read", params: { path: "支付说明.md" } }));
  });

  it("工具名大小写不敏感", () => {
    expectSensitive(classifySensitiveStep({ toolName: "Browser_Click", params: { target: "登录" } }), "login");
  });

  it("提交/选择/拖拽类动作同样进入敏感分类（回归：旧名单只含 click/type/navigate/terminal）", () => {
    // Enter 可提交支付表单；下拉可选中「确认支付」；拖拽可拖动确认滑块——
    // 三者都能完成不可撤销动作，漏在 SENSITIVE_ACTION_TOOLS 外等于敏感闸对它们失明。
    expectSensitive(classifySensitiveStep({ toolName: "browser_press_key", params: { key: "Enter", text: "确认支付" } }), "payment");
    expectSensitive(classifySensitiveStep({ toolName: "browser_select", params: { target: "#pay", option: "确认支付" } }), "payment");
    expectSensitive(classifySensitiveStep({ toolName: "browser_drag", params: { to: "删除账户" } }), "irreversible");
  });

  it("普通按键/普通下拉不误报", () => {
    expectSafe(classifySensitiveStep({ toolName: "browser_press_key", params: { key: "Tab" } }));
    expectSafe(classifySensitiveStep({ toolName: "browser_select", params: { target: "#city", option: "杭州" } }));
  });
});

describe("browser_click / browser_type：登录/账号", () => {
  it("中文按钮文案", () => {
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { target: "登录" } }), "login");
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { target: "立即注册" } }), "login");
    expectSensitive(classifySensitiveStep({ toolName: "browser_type", params: { placeholder: "请输入密码" } }), "login");
  });

  it("英文与全角英文", () => {
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { target: "Sign in" } }), "login");
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { target: "Log In" } }), "login");
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { target: "Ｌｏｇｉｎ" } }), "login");
    expectSensitive(classifySensitiveStep({ toolName: "browser_type", params: { target: "#pwd", text: "passwd-123" } }), "login");
  });

  it("数组/嵌套参数同样扫描", () => {
    expectSensitive(
      classifySensitiveStep({ toolName: "browser_click", params: { label: ["账号", "登录"] } }),
      "login",
    );
  });
});

describe("browser_click / browser_type：支付/交易", () => {
  it("中文下单/支付/转账", () => {
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { target: "text=立即支付" } }), "payment");
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { text: "确认订单" } }), "payment");
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { text: "转账给好友" } }), "payment");
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { text: "立即购买" } }), "payment");
  });

  it("英文 checkout / pay / transfer", () => {
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { target: "Checkout" } }), "payment");
    expectSensitive(classifySensitiveStep({ toolName: "browser_type", params: { text: "Transfer 100 USD to Bob" } }), "payment");
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { target: "Pay now" } }), "payment");
  });
});

describe("browser_click / browser_type：不可撤销", () => {
  it("删除账户 / 注销 / 退订", () => {
    expectSensitive(
      classifySensitiveStep({ toolName: "browser_click", params: { target: "button:has-text('删除账户')" } }),
      "irreversible",
    );
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { text: "注销账号" } }), "irreversible");
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { text: "Unsubscribe" } }), "irreversible");
    expectSensitive(classifySensitiveStep({ toolName: "browser_click", params: { text: "Delete account" } }), "irreversible");
  });
});

describe("误报口径：不该命中的必须放行", () => {
  it("元素编号选择器不敏感", () => {
    expectSafe(classifySensitiveStep({ toolName: "browser_click", params: { target: '[data-loops-el="3"]' } }));
    expectSafe(classifySensitiveStep({ toolName: "browser_click", params: { target: ".btn-primary" } }));
  });

  it("拉丁子串不误报：payload / designing / 普通输入框", () => {
    expectSafe(classifySensitiveStep({ toolName: "browser_type", params: { text: "designing payload display" } }));
    expectSafe(classifySensitiveStep({ toolName: "browser_type", params: { target: "#pwd", text: "hunter2" } }));
  });

  it("「注册表」等非账号语境显式豁免", () => {
    expectSafe(classifySensitiveStep({ toolName: "browser_click", params: { text: "打开注册表编辑器" } }));
  });

  it("搜索框里输入敏感词不算（是输入内容不是账号动作）——只按目标文案判定", () => {
    expectSafe(classifySensitiveStep({ toolName: "browser_click", params: { target: "#search-submit" } }));
  });
});

describe("browser_navigate：只看 host + path（忽略 query/hash）", () => {
  it("登录路径/域名", () => {
    expectSensitive(classifySensitiveStep({ toolName: "browser_navigate", params: { url: "https://example.com/login" } }), "login");
    expectSensitive(classifySensitiveStep({ toolName: "browser_navigate", url: "https://auth.example.com/callback" }), "login");
    expectSensitive(classifySensitiveStep({ toolName: "browser_navigate", params: { url: "https://example.com/oauth/authorize" } }), "login");
  });

  it("支付路径/域名", () => {
    expectSensitive(classifySensitiveStep({ toolName: "browser_navigate", params: { url: "https://pay.example.com/checkout" } }), "payment");
    expectSensitive(classifySensitiveStep({ toolName: "browser_navigate", params: { url: "https://example.com/orders/42" } }), "payment");
    // 保守口径：文档页路径含 payment 词也确认（宁可多问一次）
    expectSensitive(classifySensitiveStep({ toolName: "browser_navigate", params: { url: "https://example.com/docs/payment-api" } }), "payment");
  });

  it("不可撤销路径", () => {
    expectSensitive(classifySensitiveStep({ toolName: "browser_navigate", params: { url: "https://example.com/unsubscribe" } }), "irreversible");
  });

  it("query 里的敏感词不触发（搜索 pay/login 不该弹窗）", () => {
    expectSafe(classifySensitiveStep({ toolName: "browser_navigate", params: { url: "https://www.bing.com/search?q=pay+now" } }));
    expectSafe(classifySensitiveStep({ toolName: "browser_navigate", params: { url: "https://www.google.com/search?q=login" } }));
    expectSafe(classifySensitiveStep({ toolName: "browser_navigate", params: { url: "https://example.com/article/about-logo" } }));
  });

  it("URL 本身不敏感时，仍检查其余文本参数", () => {
    expectSensitive(
      classifySensitiveStep({ toolName: "browser_navigate", params: { url: "https://example.com/", text: "立即支付" } }),
      "payment",
    );
  });
});

describe("terminal_run：hard_rules + 补语义", () => {
  it("递归/强制删除与永久删除", () => {
    expectSensitive(classifySensitiveStep({ toolName: "terminal_run", params: { command: "rm -rf ./dist" } }), "irreversible");
    expectSensitive(classifySensitiveStep({ toolName: "terminal_run", params: { command: "del /f important.txt" } }), "irreversible");
    expectSensitive(
      classifySensitiveStep({ toolName: "terminal_run", params: { command: "Remove-Item -Recurse -Force .\\out" } }),
      "irreversible",
    );
  });

  it("与 hard_rules 复用（格式化/关机/注册表）", () => {
    expectSensitive(classifySensitiveStep({ toolName: "terminal_run", params: { command: "format C:" } }), "irreversible");
    expectSensitive(classifySensitiveStep({ toolName: "terminal_run", params: { command: "shutdown /s /t 0" } }), "irreversible");
    expectSensitive(
      classifySensitiveStep({ toolName: "terminal_run", params: { command: "reg delete HKLM\\Software\\X" } }),
      "irreversible",
    );
  });

  it("数据删除 / 强制推送 / 磁盘写", () => {
    expectSensitive(classifySensitiveStep({ toolName: "terminal_run", params: { command: `psql -c "drop database app"` } }), "irreversible");
    expectSensitive(classifySensitiveStep({ toolName: "terminal_run", params: { command: "git push --force origin main" } }), "irreversible");
    expectSensitive(classifySensitiveStep({ toolName: "terminal_run", params: { command: "git reset --hard HEAD~3" } }), "irreversible");
    expectSensitive(classifySensitiveStep({ toolName: "terminal_run", params: { command: "dd if=/dev/zero of=/dev/sda" } }), "irreversible");
  });

  it("全角命令同样命中（NFKC）", () => {
    expectSensitive(classifySensitiveStep({ toolName: "terminal_run", params: { command: "ｒｍ -ｒｆ /" } }), "irreversible");
  });

  it("正常命令不敏感（含 rm-notes 文件名与包管理删除）", () => {
    expectSafe(classifySensitiveStep({ toolName: "terminal_run", params: { command: "ls -la" } }));
    expectSafe(classifySensitiveStep({ toolName: "terminal_run", params: { command: "npm run build" } }));
    expectSafe(classifySensitiveStep({ toolName: "terminal_run", params: { command: "cat rm-notes.txt" } }));
    expectSafe(classifySensitiveStep({ toolName: "terminal_run", params: { command: "npm rm left-pad" } }));
    expectSafe(classifySensitiveStep({ toolName: "terminal_run", params: { command: "git status" } }));
  });

  it("保守口径：echo 文本里出现危险命令也会确认（宁可多问一次）", () => {
    expectSensitive(classifySensitiveStep({ toolName: "terminal_run", params: { command: `echo "rm -rf /"` } }), "irreversible");
  });
});

describe("reason 文案：可直接展示给用户", () => {
  it("包含类别中文标签与命中细节", () => {
    const verdict = classifySensitiveStep({ toolName: "browser_click", params: { target: "确认订单" } });
    expect(verdict.reason).toBe("敏感步骤：支付/交易（命中「确认订单」）");
    const login = classifySensitiveStep({ toolName: "browser_click", params: { target: "登录" } });
    expect(login.reason).toBe("敏感步骤：登录/账号（命中「登录」）");
  });

  it("终端 hard_rules 命中时带规则序号", () => {
    const verdict = classifySensitiveStep({ toolName: "terminal_run", params: { command: "shutdown /s" } });
    expect(verdict.reason).toMatch(/敏感步骤：不可撤销操作（.*危险规则/);
  });
});

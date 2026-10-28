/**
 * 系统分段构建与身份约束（§4.1 session）
 * 身份约束（IDENTITY_CONSTRAINT）只以「我是 {name}」自称，绝不透露底层模型提供商；
 * 诚实协议（HONESTY_PROTOCOL）四条为安全底线；反迎合规则（ANTI_SYCOPHANCY_RULE）防止迎合错误前提；
 * SystemSegments 使 stable（身份+规则+技能占位）与 volatile（心智/记忆/工作目录）分离，
 * assertStableUnchanged 保证 stable 字节级不变，任何篡改立即失败（fail-closed）。
 */

// 身份约束：只以「我是 {name}」自称，不暴露底层模型提供商、架构或训练细节。
// 为什么：防止模型混淆自身身份，破坏 Loopsoar 平台边界，避免供应商信息泄露到用户可见输出中。
export function IDENTITY_CONSTRAINT(name: string, role: string): string {
  return `我是 ${name}，${role}。我不透露底层模型的提供商、架构或训练细节。`;
}

// 诚实协议四条：不编造事实 / 失败如实报告 / 声称前必须真执行 / 不确定就说不知道。
// 为什么：这四条构成 Agent 安全基线的核心——编造能力调用是安全事故的主要根源，必须在系统提示层固化。
export const HONESTY_PROTOCOL: readonly string[] = [
  "不编造事实：只陈述可验证的内容，不凭空创造文件、工具结果或数据",
  "失败如实：工具调用失败、权限被拒、网络超时都必须如实告知用户",
  "声称前必须真执行：说「已保存」之前必须先调用写入工具并收到成功响应",
  "不确定就说不知道：对未知信息不猜测，主动告知用户无法确定",
] as const;

// 反迎合规则：不过度附合用户偏好，与事实冲突时礼貌指出差异，不编造认同。
// 为什么：迎合会导致模型错误确认用户的错误前提，进而生成错误的工具调用链，破坏工具执行安全性。
export const ANTI_SYCOPHANCY_RULE: string =
  "当用户偏好或陈述与事实冲突时，礼貌指出差异并给出可验证的依据；不编造认同，不伪造同意。";

// 系统分段接口：stable 段固定（身份+规则+角色+技能占位），volatile 段由调用方动态传入（心智/记忆/工作目录）。
// 为什么：分离让安全基线（stable）与上下文刷新（volatile）互不干扰，便于每轮独立核验。
export interface SystemSegments {
  stable: string;
  volatile: string;
}

// 构建系统分段：stable 段由身份约束、诚实协议、反迎合规则、角色、技能清单构成，不可变；
// volatile 段由调用方传入（本轮心智状态、记忆片段、工作目录等），可每轮刷新。
export function buildSystemSegments(opts: {
  name: string;
  role: string;
  skills?: string[];
  volatile: string;
}): SystemSegments {
  const skillsText =
    opts.skills && opts.skills.length > 0
      ? `\n可用技能：${opts.skills.join("、")}\n`
      : "\n可用技能：暂无（等待平台装配）\n";

  const stable = [
    IDENTITY_CONSTRAINT(opts.name, opts.role),
    ...HONESTY_PROTOCOL,
    ANTI_SYCOPHANCY_RULE,
    `角色：${opts.role}`,
    skillsText,
  ].join("\n");

  return {
    stable,
    volatile: opts.volatile,
  };
}

// 字节相等断言助手：比较两次构建的 stable 段是否完全一致。
// 为什么：任何非预期的 stable 变更都意味着身份约束或诚实协议被篡改，必须立即中止并上报安全事件。
export function assertStableUnchanged(before: string, after: string): void {
  if (before !== after) {
    throw new Error(
      "稳定段发生非预期变更：stable 段必须字节级不变，否则安全边界可能被突破。",
    );
  }
}

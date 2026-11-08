/**
 * 引导总线（§4.1 steerBus，ADR-0038 由 slime steerBus 移植并精简）
 *
 * 用户/AI 在模型运行期间插入的短指令先进入每会话一条的总线，模型在**轮次边界**取走并注入对话；
 * 这样既不打断当前输出，又能让模型在下一轮看到新指令。移植自 slime core-ts/src/services/steerBus.ts，
 * 去掉了 slime 中未使用的 fromId/agentId 等冗余字段，保留 kind/fromName 以区分「用户插入」和「子代理回流」。
 *
 * 铁律：
 *   · 上限 8 条（防刷屏）、单条 ≤2000 字（防稀释注意力）；
 *   · 同一 steerId 重复 push 按覆盖处理（UI 重试/直接插入幂等，不会出现两条一样的引导）；
 *   · drain 后清空，避免同一条引导被重复注入。
 * 纯逻辑、零 node 内建依赖，可直接单测。
 */

/** 队列最多保留的引导条数（超出时拒绝新的 push，UI 保留待发卡等待下一轮）。 */
export const STEER_MAX_PENDING = 8;
/** 单条引导文本上限（超出截断）。 */
export const STEER_TEXT_MAX = 2000;

/** 引导来源：user=用户运行中输入；subagent=子代理回流（措辞不同，且不冒充用户原话）。 */
export type SteerKind = "user" | "subagent";

export interface SteerItem {
  /** 客户端生成的稳定 id（UI 待发卡与注入回执对账用）。 */
  id: string;
  /** 已 trim + 截断的引导文本。 */
  text: string;
  /** 来源，缺省按 user 处理。 */
  kind?: SteerKind;
  /** 来源名称（子代理回流时显示，如 "reviewer"）。 */
  fromName?: string;
  /** 入队时间（ms），用于 UI 排序/展示。 */
  createdAt?: number;
}

/** push 结果：ok=入队/覆盖成功；full=队列已满（未入队）；empty=文本为空（未入队）。 */
export type SteerPushResult = "ok" | "full" | "empty";

export class SteerBus {
  private items: SteerItem[] = [];

  /**
   * 推入一条引导。同 id 覆盖（保留原位置，避免重试打乱顺序）；满 8 条拒绝新的 id。
   * 返回状态供上层映射成 ChatSteerResult.reason。
   */
  push(item: SteerItem): SteerPushResult {
    const text = (item.text ?? "").trim().slice(0, STEER_TEXT_MAX);
    if (!text) return "empty";
    const existing = this.items.findIndex((it) => it.id === item.id);
    if (existing >= 0) {
      this.items[existing] = { ...this.items[existing], ...item, text };
      return "ok";
    }
    if (this.items.length >= STEER_MAX_PENDING) return "full";
    this.items.push({ ...item, text });
    return "ok";
  }

  /** 按 id 取走一条（UI 修改/撤销时确认该条尚未注入）；不存在返回 undefined。 */
  take(id: string): SteerItem | undefined {
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx < 0) return undefined;
    return this.items.splice(idx, 1)[0];
  }

  /** 取出并清空全部引导（轮次边界调用一次）。 */
  drain(): SteerItem[] {
    const result = this.items;
    this.items = [];
    return result;
  }

  /** 当前挂起引导快照（只读，监控/测试用）。 */
  list(): SteerItem[] {
    return [...this.items];
  }

  /** 当前队列长度。 */
  size(): number {
    return this.items.length;
  }
}

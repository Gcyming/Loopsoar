/**
 * 扩展贡献点接线（第三阶段 C 切片）：把已启用扩展声明的 loops / themes 接到真实注册表。
 *
 * 规则：
 *   · loop 以 ext.<extensionId>.<loopId> 注册进 LoopRegistry，runner 复用 L2 声明式实现
 *     （applyDeclarativeLoop：只追加提示词 + 收紧预算 + 工具白名单，不执行扩展代码）；
 *   · 停用/卸载扩展时**精确撤下**：先切回 builtin（若它正好是活动 loop），再 registry.remove；
 *   · 主题只做数据归一（token 白名单已在契约 schema 校验），由 UI 写 CSS 变量；
 *   · 冲突（重复 id / 撞内置 id / 注册异常）全部进 conflicts，不做静默覆盖。
 */
import { collectExtensionLoops, collectExtensionThemes, type ExtensionLoopView, type ExtensionThemeView } from "loopsoar-core/extension";
import { runToolLoop } from "loopsoar-core/tool_loop";
import type { ExtensionHost } from "./extensions.js";
import {
  applyDeclarativeLoop,
  CORE_LOOP_ID,
  contextToToolLoopOpts,
  type LoopRuntime,
} from "./loopRuntime.js";

export interface ExtensionContributionsState {
  loops: ExtensionLoopView[];
  themes: ExtensionThemeView[];
  conflicts: string[];
  /** 当前已注册进 LoopRegistry 的扩展 loop id。 */
  registeredLoopIds: string[];
}

export class ExtensionContributions {
  private registered = new Set<string>();
  private stateValue: ExtensionContributionsState = { loops: [], themes: [], conflicts: [], registeredLoopIds: [] };

  constructor(
    private readonly runtime: LoopRuntime,
    private readonly host: ExtensionHost,
    /** 同步完成后的通知（壳层用它 push loop:changed，设置页的 loop 列表即时刷新）。 */
    private readonly onSynced?: (state: ExtensionContributionsState) => void,
  ) {
    // 启停/卸载/重扫后由宿主回调：贡献点必须与 enabled 状态同步，不能残留。
    this.host.onChange = () => this.sync();
    this.host.contributions = () => this.state();
  }

  /** 与当前扩展清单同步：先撤下失效的，再注册新增的（幂等，可反复调用）。 */
  sync(): ExtensionContributionsState {
    const loopResult = collectExtensionLoops(this.host.list());
    const themeResult = collectExtensionThemes(this.host.list());
    const desired = new Set(loopResult.loops.map((loop) => loop.id));

    for (const id of [...this.registered]) {
      if (desired.has(id)) continue;
      try {
        if (this.runtime.registry.current() === id) this.runtime.registry.switchTo(CORE_LOOP_ID);
        this.runtime.registry.remove(id);
      } catch {
        // 已被手工删除 / builtin 保护：忽略
      }
      this.registered.delete(id);
    }

    for (const loop of loopResult.loops) {
      if (this.registered.has(loop.id)) continue;
      try {
        this.runtime.registry.register({
          id: loop.id,
          name: `${loop.name}（${loop.extensionName}）`,
          validate: () => [],
          runner: (ctx) =>
            runToolLoop(
              applyDeclarativeLoop(
                {
                  id: loop.id,
                  name: loop.name,
                  ...loop.config,
                },
                contextToToolLoopOpts(ctx),
              ),
            ),
        });
        this.registered.add(loop.id);
      } catch (err) {
        loopResult.conflicts.push(
          `注册 loop ${loop.id} 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.stateValue = {
      loops: loopResult.loops,
      themes: themeResult.themes,
      conflicts: [...loopResult.conflicts, ...themeResult.conflicts],
      registeredLoopIds: [...this.registered],
    };
    this.onSynced?.(this.stateValue);
    return this.stateValue;
  }

  state(): ExtensionContributionsState {
    return this.stateValue;
  }
}

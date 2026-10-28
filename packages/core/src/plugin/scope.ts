/**
 * 贡献点作用域（ADR-0011）：注册即拿句柄，卸载逆序 dispose。
 * 为什么逆序 + 幂等 + 单失败不阻断：
 *   - 逆序保证「后注册的先撤」，避免先撤基础句柄导致后续 dispose 报错；
 *   - 幂等保证重复卸载安全（插件停用/重载/崩溃恢复都会重复调用）；
 *   - 单失败不阻断保证一个坏贡献点不会拖垮整个卸载流程（错误收集后一并返回）。
 */

export interface ContributionHandle {
  label: string;
  dispose(): void;
}

export class ContributionScope {
  private handles: ContributionHandle[] = [];
  private disposed = false;

  /** 注册一个贡献点，返回同一句柄（便于调用方持有）。 */
  register<T extends ContributionHandle>(handle: T): T {
    if (this.disposed) {
      // 已整体销毁的作用域不再接受新贡献（fail-closed）
      throw new Error("ContributionScope 已销毁，拒绝新注册");
    }
    this.handles.push(handle);
    return handle;
  }

  /** 逆序销毁全部贡献点；幂等；单失败不阻断，返回错误列表。 */
  disposeAll(): string[] {
    if (this.disposed) return [];
    this.disposed = true;
    const errors: string[] = [];
    for (let i = this.handles.length - 1; i >= 0; i--) {
      const h = this.handles[i];
      try {
        h.dispose();
      } catch (err) {
        errors.push(`${h.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.handles = [];
    return errors;
  }

  /** 当前存活贡献点数（监控/测试用）。 */
  size(): number {
    return this.handles.length;
  }
}

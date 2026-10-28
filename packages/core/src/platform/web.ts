/**
 * Web 平台 stub（§4.2）
 * 只提供接口占位，不提供真实实现；所有方法抛出未实现错误
 */
import { LoopsoarNotImplementedError } from "./errors.js";
import type {
  FsAdapter,
  ProcessAdapter,
  SqliteAdapter,
  NetAdapter,
  EmbedAdapter,
  LoopsoarPlatform,
} from "./types.js";

class WebStubFsAdapter implements FsAdapter {
  async readFileUtf8(_p: string): Promise<string> {
    throw new LoopsoarNotImplementedError("web 实现将在移动端阶段提供");
  }
  async writeFileUtf8(_p: string, _data: string): Promise<void> {
    throw new LoopsoarNotImplementedError("web 实现将在移动端阶段提供");
  }
  async readDir(_p: string): Promise<string[]> {
    throw new LoopsoarNotImplementedError("web 实现将在移动端阶段提供");
  }
  async stat(_p: string): Promise<{ size: number; mtimeMs: number }> {
    throw new LoopsoarNotImplementedError("web 实现将在移动端阶段提供");
  }
  async exists(_p: string): Promise<boolean> {
    throw new LoopsoarNotImplementedError("web 实现将在移动端阶段提供");
  }
  resolve(p: string): string {
    return p;
  }
  isInside(root: string, p: string): boolean {
    return true; // 占位，实际移动端实现应使用文件系统路径解析
  }
}

class WebStubProcessAdapter implements ProcessAdapter {
  async run(_cmd: string, _args: string[], _opts: { cwd?: string; timeoutMs?: number; maxBytes?: number }): Promise<any> {
    throw new LoopsoarNotImplementedError("web 实现将在移动端阶段提供");
  }
}

class WebStubSqliteAdapter implements SqliteAdapter {
  async open(_path: string): Promise<any> {
    throw new LoopsoarNotImplementedError("web 实现将在移动端阶段提供");
  }
}

class WebStubNetAdapter implements NetAdapter {
  async fetchText(): Promise<any> {
    throw new LoopsoarNotImplementedError("web 实现将在移动端阶段提供");
  }
  async resolveIps(_host: string): Promise<string[]> {
    throw new LoopsoarNotImplementedError("web 实现将在移动端阶段提供");
  }
}

class WebStubEmbedAdapter implements EmbedAdapter {
  async embed(_texts: string[]): Promise<number[][]> {
    throw new LoopsoarNotImplementedError("web 实现将在移动端阶段提供");
  }
}

export function createWebPlatformStub(): LoopsoarPlatform {
  return {
    fs: new WebStubFsAdapter(),
    process: new WebStubProcessAdapter(),
    sqlite: new WebStubSqliteAdapter(),
    net: new WebStubNetAdapter(),
    embed: new WebStubEmbedAdapter(),
  };
}

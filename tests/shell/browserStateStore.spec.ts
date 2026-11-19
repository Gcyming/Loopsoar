/**
 * BrowserStateStore（P2-3）：内存缓存 + 合并写 / 退出前 flush。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserStateStore } from "../../packages/shell/src/main/browserStateStore.ts";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "loopsoar-browser-state-"));
  dirs.push(dir);
  return path.join(dir, "browser-state.json");
}
function state(url: string) {
  return { tabs: [{ id: "t1", url, title: "x", active: true }], activeIndex: 0 } as never;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("BrowserStateStore 合并写", () => {
  it("set 在防抖窗口内不落盘，窗口过后写一次", async () => {
    const file = tempFile();
    const store = new BrowserStateStore(file, { debounceMs: 20 });
    store.set("s1", state("https://a.example"));
    expect(existsSync(file)).toBe(false);
    await sleep(60);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).s1.tabs[0].url).toBe("https://a.example");
  });

  it("flush 立即落盘，且缓存读回一致", () => {
    const file = tempFile();
    const store = new BrowserStateStore(file, { debounceMs: 60_000 });
    store.set("s1", state("https://a.example"));
    store.flush();
    expect(JSON.parse(readFileSync(file, "utf8")).s1.tabs[0].url).toBe("https://a.example");
    expect(store.get("s1")?.tabs[0].url).toBe("https://a.example");
  });

  it("空标签集合 = 删除 key；delete 后 flush 落盘", async () => {
    const file = tempFile();
    const store = new BrowserStateStore(file, { debounceMs: 5 });
    store.set("s1", state("https://a.example"));
    store.flush();
    store.set("s1", { tabs: [], activeIndex: 0 } as never);
    store.flush();
    expect(JSON.parse(readFileSync(file, "utf8")).s1).toBeUndefined();
    store.set("s2", state("https://b.example"));
    store.delete("s2");
    store.flush();
    expect(JSON.parse(readFileSync(file, "utf8")).s2).toBeUndefined();
    expect(store.entries()).toEqual([]);
  });

  it("多次修改只保留最后一次（合并写）", async () => {
    const file = tempFile();
    const store = new BrowserStateStore(file, { debounceMs: 10 });
    store.set("s1", state("https://1.example"));
    store.set("s1", state("https://2.example"));
    store.set("s1", state("https://3.example"));
    await sleep(40);
    expect(JSON.parse(readFileSync(file, "utf8")).s1.tabs[0].url).toBe("https://3.example");
  });
});

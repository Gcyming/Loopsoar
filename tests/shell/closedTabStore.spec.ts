import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClosedTabStore } from "../../packages/shell/src/main/closedTabStore.js";

const tempFile = (): { dir: string; file: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), "closed-tabs-"));
  return { dir, file: path.join(dir, "closed-tabs.json") };
};

describe("ClosedTabStore：最近关闭落盘", () => {
  it("flush 后重新 load 能读回同样的记录（退出后不丢）", () => {
    const { dir, file } = tempFile();
    try {
      const store = new ClosedTabStore(file, 0);
      store.save([{ url: "https://a.example", title: "A", sessionId: "__user_tabs__", closedAt: 7 }]);
      store.flush();
      const reopened = new ClosedTabStore(file, 0).load();
      expect(reopened).toEqual([{ url: "https://a.example", title: "A", sessionId: "__user_tabs__", closedAt: 7 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文件不存在或内容损坏时返回空数组（不阻断启动）", () => {
    const { dir, file } = tempFile();
    try {
      expect(new ClosedTabStore(file, 0).load()).toEqual([]);
      const store = new ClosedTabStore(file, 0);
      store.save([{ url: "https://b.example", title: "B", sessionId: "s1", closedAt: 1 }]);
      store.flush();
      expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("保存的是整份列表：重开一条后磁盘上也会少一条", () => {
    const { dir, file } = tempFile();
    try {
      const store = new ClosedTabStore(file, 0);
      store.save([
        { url: "https://a.example", title: "A", sessionId: "__user_tabs__", closedAt: 1 },
        { url: "https://b.example", title: "B", sessionId: "__user_tabs__", closedAt: 2 },
      ]);
      store.flush();
      store.save([{ url: "https://b.example", title: "B", sessionId: "__user_tabs__", closedAt: 2 }]);
      store.flush();
      expect(new ClosedTabStore(file, 0).load().map((item) => item.title)).toEqual(["B"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointStore } from "../../packages/shell/src/main/checkpointStore.ts";

let root = "";
let workspace = "";
let store: CheckpointStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-cp-"));
  workspace = path.join(root, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  store = new CheckpointStore(path.join(root, "checkpoints"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

describe("CheckpointStore", () => {
  it("同回合同一文件只备份第一次写入前的状态，恢复回到回合开始前", () => {
    const abs = write("a.txt", "v1");
    const sid = "s1";
    store.begin(sid, "回合 1");
    store.capture(sid, abs, "a.txt", "v2");
    fs.writeFileSync(abs, "v2", "utf8");
    store.capture(sid, abs, "a.txt", "v3"); // 第二次不再覆盖备份
    fs.writeFileSync(abs, "v3", "utf8");
    store.end(sid);

    expect(store.list(sid).length).toBe(1);
    const result = store.restore(sid, workspace);
    expect(result.errors).toEqual([]);
    expect(result.restored).toBe(1);
    expect(fs.readFileSync(abs, "utf8")).toBe("v1");
  });

  it("本回合新建的文件恢复时删除；内容未变的覆盖不产生快照", () => {
    const existing = write("keep.txt", "same");
    const sid = "s2";
    store.begin(sid, "回合 2");
    const created = store.capture(sid, path.join(workspace, "new.txt"), "new.txt", "hello");
    store.capture(sid, existing, "keep.txt", "same");
    write("new.txt", "hello");
    store.end(sid);

    expect(created).toBe(true);
    expect(store.list(sid)[0].files.map((f) => f.rel)).toEqual(["new.txt"]);
    const result = store.restore(sid, workspace);
    expect(result.deleted).toBe(1);
    expect(fs.existsSync(path.join(workspace, "new.txt"))).toBe(false);
    expect(fs.readFileSync(existing, "utf8")).toBe("same");
  });

  it("恢复时校验路径不越界：清单里的 ../ 不会写出工作区", () => {
    const sid = "s3";
    const id = store.begin(sid, "回合 3");
    const dir = path.join(root, "checkpoints", sid, id);
    fs.mkdirSync(path.join(dir, "files"), { recursive: true });
    fs.writeFileSync(path.join(dir, "files", "f0.bak"), "evil", "utf8");
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id,
        sessionId: sid,
        label: "回合 3",
        createdAt: Date.now(),
        files: [{ rel: "../escape.txt", existed: true, backup: "f0.bak" }],
      }),
      "utf8",
    );

    const result = store.restore(sid, workspace);
    expect(result.restored).toBe(0);
    expect(result.errors.join("")).toContain("路径越界");
    expect(fs.existsSync(path.join(root, "escape.txt"))).toBe(false);
  });

  it("按会话隔离，并只保留最近 N 个非空检查点", () => {
    const sid = "s4";
    for (let i = 0; i < 25; i += 1) {
      const abs = write(`f${i}.txt`, `v${i}`);
      store.begin(sid, `回合 ${i}`);
      store.capture(sid, abs, `f${i}.txt`, `v${i}-next`);
      fs.writeFileSync(abs, `v${i}-next`, "utf8");
      store.end(sid);
    }
    const list = store.list(sid, 100);
    expect(list.length).toBe(20);
    expect(list[0].label).toBe("回合 24");
    expect(store.list("other")).toEqual([]);
  });
});

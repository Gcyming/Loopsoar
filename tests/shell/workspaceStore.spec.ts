/** 工作区存储：默认工作区、挂载/去重/切换/删除。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../../packages/shell/src/main/workspaceStore.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsoar-ws-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("WorkspaceStore", () => {
  it("首次启动用默认根创建默认工作区，并持久化", () => {
    const root = tempDir();
    const file = path.join(tempDir(), "workspaces.json");
    const store = new WorkspaceStore(file, root);
    expect(store.list()).toHaveLength(1);
    expect(store.active()?.root).toBe(fs.realpathSync.native(root));
    const again = new WorkspaceStore(file, root);
    expect(again.list()).toHaveLength(1);
    expect(again.activeId()).toBe(store.activeId());
  });

  it("挂载新文件夹、重复根复用、切换活动工作区", () => {
    const base = tempDir();
    const store = new WorkspaceStore(path.join(tempDir(), "workspaces.json"), base);
    const other = tempDir();
    const created = store.create(other, "项目 B");
    expect(created.ok).toBe(true);
    expect(store.active()?.id).toBe((created as { workspace: { id: string } }).workspace.id);
    const duplicate = store.create(other, "重复");
    expect(duplicate.ok).toBe(true);
    expect(store.list()).toHaveLength(2);
    const first = store.list().find((item) => item.root === fs.realpathSync.native(base))!;
    expect(store.select(first.id)?.id).toBe(first.id);
    expect(store.activeId()).toBe(first.id);
  });

  it("删除工作区：保留至少一个；删除非活动项不影响 active", () => {
    const store = new WorkspaceStore(path.join(tempDir(), "workspaces.json"), tempDir());
    const other = store.create(tempDir(), "B");
    const otherId = (other as { workspace: { id: string } }).workspace.id;
    const firstId = store.list().find((item) => item.id !== otherId)!.id;
    expect(store.remove(otherId)).toEqual({ ok: true });
    expect(store.activeId()).toBe(firstId);
    expect(store.remove(firstId)).toEqual({ ok: false, error: "至少保留一个工作区" });
  });
});

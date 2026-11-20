import { describe, expect, it } from "vitest";
import { parseRemoteRepo } from "../../scripts/github-api-sync.mjs";

describe("GitHub API 发布脚本：remote URL 解析", () => {
  it("解析 GitHub 直连、SSH 与 .git 后缀", () => {
    expect(parseRemoteRepo("https://github.com/Gcyming/Loopsoar.git")).toEqual({ owner: "Gcyming", repo: "Loopsoar" });
    expect(parseRemoteRepo("git@github.com:Gcyming/Loopsoar.git")).toEqual({ owner: "Gcyming", repo: "Loopsoar" });
    expect(parseRemoteRepo("https://github.com:443/Gcyming/Loopsoar")).toEqual({ owner: "Gcyming", repo: "Loopsoar" });
  });

  it("解析本机 ghproxy 包装的 URL，避免把代理主机当成 owner", () => {
    expect(parseRemoteRepo("https://ghproxy.net/https://github.com/Gcyming/Loopsoar.git")).toEqual({
      owner: "Gcyming",
      repo: "Loopsoar",
    });
  });

  it("非 GitHub remote 返回 null", () => {
    expect(parseRemoteRepo("https://gitlab.com/a/b.git")).toBeNull();
    expect(parseRemoteRepo("")).toBeNull();
  });
});

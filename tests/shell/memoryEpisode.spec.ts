/**
 * 会话删除 → episode（E-M1）：确定性摘要、空会话返回 null、provenance 正确。
 */
import { describe, expect, it } from "vitest";
import { buildSessionEpisode } from "../../packages/shell/src/main/memoryEpisode.ts";

describe("会话 episode（E-M1）", () => {
  it("摘要包含标题、用户消息与最后一条助手回复，且不超过 400 字", () => {
    const episode = buildSessionEpisode({
      sessionId: "s1",
      title: "记忆图谱设计",
      workspaceId: "ws-a",
      messages: [
        { role: "user", content: "我想把记忆页做成神经元连接的样子" },
        { role: "assistant", content: "可以，先做原点与第一分支" },
        { role: "user", content: "删除会话要压缩成游离层" },
      ],
    });
    expect(episode).not.toBeNull();
    expect(episode!.content).toContain("记忆图谱设计");
    expect(episode!.content).toContain("神经元连接");
    expect(episode!.content).toContain("游离层");
    expect(episode!.content.length).toBeLessThanOrEqual(400);
    expect(episode!.category).toBe("episode");
    expect(episode!.provenance?.sessionId).toBe("s1");
    expect(episode!.provenance?.workspaceId).toBe("ws-a");
    expect(episode!.provenance?.capturedBy).toBe("consolidation");
  });

  it("空会话不产生 episode", () => {
    expect(buildSessionEpisode({ sessionId: "s2", messages: [] })).toBeNull();
    expect(buildSessionEpisode({ sessionId: "s3", messages: [{ role: "user", content: "   " }] })).toBeNull();
  });
});

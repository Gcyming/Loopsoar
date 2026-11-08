/**
 * done 对账（m02515 截断根除的 UI 最后一道防线）：
 *   · 服务端 done 携带权威全文 finalText，UI 必须覆盖本地累积文本（chunk 丢失时不截断）；
 *   · 迟到 chunk 若已包含在正文尾部则不得重复追加；
 *   · interrupted 状态仍保留权威全文。
 */
import { describe, expect, it } from "vitest";
import { applyChunk, applyDone, applyLateChunk, parseDone, type ChatMessage } from "../../packages/ui/src/chatStreamState.ts";

function streaming(text: string, id = "a1"): ChatMessage[] {
  return applyChunk([], id, text, { tailSeq: 1, now: 1 });
}

describe("done 权威全文对账", () => {
  it("parseDone 解析 finalText", () => {
    const info = parseDone(JSON.stringify({ status: "done", finalText: "完整全文", usage: { rounds: 2 } }));
    expect(info.finalText).toBe("完整全文");
    expect(info.statusText).toBe("完成");
  });

  it("服务端全文比本地累积更长 → done 时覆盖为全文（chunk 丢失也不截断）", () => {
    const chunks = streaming("前半段");
    const full = "前半段后半段（完整全文）";
    const done = applyDone(chunks, { usage: {}, statusText: "完成", finalText: full }, { startedAt: 1, firstTokenAt: 2, now: 3 });
    expect(done[0].text).toBe(full);
    expect(done[0].status).toBe("done");
  });

  it("中断收尾同样保留权威全文", () => {
    const chunks = streaming("已生成内容");
    const done = applyDone(
      chunks,
      {
        usage: {},
        statusText: "已中断",
        finalText: "已生成内容（含续写片段）",
        interrupted: { status: "aborted", reason: "用户已停止" },
      },
      { startedAt: 1, firstTokenAt: 2, now: 3 },
    );
    expect(done[0].text).toBe("已生成内容（含续写片段）");
    expect(done[0].interrupted?.status).toBe("aborted");
  });

  it("finalText 为空时不覆盖（避免把有效文本清空）", () => {
    const chunks = streaming("有效文本");
    const done = applyDone(chunks, { usage: {}, statusText: "完成", finalText: "" }, { startedAt: 1, firstTokenAt: 2, now: 3 });
    expect(done[0].text).toBe("有效文本");
  });
});

describe("迟到 chunk 去重", () => {
  it("增量已是正文尾部 → 不重复追加", () => {
    const chunks = streaming("abcdef");
    const done = applyDone(chunks, { usage: {}, statusText: "完成", finalText: "abcdef" }, { startedAt: 1, firstTokenAt: 2, now: 3 });
    const late = applyLateChunk(done, "def", { tailSeq: 2 });
    expect(late[0].text).toBe("abcdef");
  });

  it("新尾部增量正常追加", () => {
    const chunks = streaming("abcdef");
    const done = applyDone(chunks, { usage: {}, statusText: "完成", finalText: "abcdef" }, { startedAt: 1, firstTokenAt: 2, now: 3 });
    const late = applyLateChunk(done, "ghi", { tailSeq: 3 });
    expect(late[0].text).toBe("abcdefghi");
  });
});

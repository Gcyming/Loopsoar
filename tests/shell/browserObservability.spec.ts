import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { BrowserObservability } from "../../packages/shell/src/main/browserObservability.js";

class FakeWebContents extends EventEmitter {
  id = 7;
  session: FakeSession;
  constructor(session: FakeSession) {
    super();
    this.session = session;
  }
}

class FakeSession {
  completed?: (details: any) => void;
  failed?: (details: any) => void;
  webRequest = {
    onCompleted: (fn: (details: any) => void) => { this.completed = fn; },
    onErrorOccurred: (fn: (details: any) => void) => { this.failed = fn; },
  };
}

describe("browser observability", () => {
  it("console 记录按会话过滤并截断到最近 N 条", () => {
    const obs = new BrowserObservability();
    const session = new FakeSession();
    const wc = new FakeWebContents(session);
    obs.attach("s1", "t1", wc);
    wc.emit("console-message", {}, 3, "boom", 1, "app.js");
    wc.emit("console-message", {}, 1, "info", 1, "app.js");
    const entries = obs.console("s1", 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("info");
    expect(obs.console("s2", 10)).toHaveLength(0);
  });

  it("network 用 webContentsId 反查会话，区分完成与失败", () => {
    const obs = new BrowserObservability();
    const session = new FakeSession();
    const wc = new FakeWebContents(session);
    obs.attach("s1", "t1", wc);
    session.completed?.({ webContentsId: 7, url: "https://x.test/a", method: "get", statusCode: 200, resourceType: "xhr" });
    session.failed?.({ webContentsId: 7, url: "https://x.test/b", method: "GET", error: "ERR_FAILED" });
    const entries = obs.network("s1", 10);
    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe(200);
    expect(entries[0].method).toBe("GET");
    expect(entries[1].error).toBe("ERR_FAILED");
  });

  it("未知 webContentsId 不写入任何会话", () => {
    const obs = new BrowserObservability();
    const session = new FakeSession();
    const wc = new FakeWebContents(session);
    obs.attach("s1", "t1", wc);
    session.completed?.({ webContentsId: 999, url: "https://x.test/a", statusCode: 200 });
    expect(obs.network("s1", 10)).toHaveLength(0);
  });
});

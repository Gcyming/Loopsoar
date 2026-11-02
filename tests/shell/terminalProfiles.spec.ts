/**
 * 终端配置档：探测结构 / spawn 规格解析 / 不可用降级 / 环境变量白名单。
 *
 * 为什么这些断言：配置档是「持久终端会话」与「terminal_run 一次性执行」的共同入口，
 * 结构或降级行为一旦漂移，两条执行路径都会静默失败；环境变量白名单是安全红线，必须锁死。
 * 说明：探测用例会起短命子进程问版本（几秒内结束），只在非受限会话执行。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import {
  __resetTerminalProfileCacheForTests,
  buildTerminalEnv,
  detectTerminalProfiles,
  resolveProfile,
  TERMINAL_PROFILE_KEYS,
} from "../../packages/shell/src/main/terminalProfiles.ts";

const ENV_PROBE_KEYS = ["OPENAI_API_KEY", "MY_TOKEN", "DB_PASSWORD", "APP_SECRET", "LOOPSOAR_DATA_DIR"] as const;

describe("终端配置档探测", () => {
  beforeEach(() => {
    __resetTerminalProfileCacheForTests();
  });
  afterEach(() => {
    __resetTerminalProfileCacheForTests();
  });

  it("返回六个配置档且字段结构完整", async () => {
    const profiles = await detectTerminalProfiles();
    expect(profiles.map((profile) => profile.key).sort()).toEqual([...TERMINAL_PROFILE_KEYS].sort());
    for (const profile of profiles) {
      expect(typeof profile.label).toBe("string");
      expect(profile.label.length).toBeGreaterThan(0);
      expect(typeof profile.description).toBe("string");
      expect(["shell", "interpreter", "toolchain"]).toContain(profile.kind);
      expect(typeof profile.available).toBe("boolean");
      if (profile.available) {
        // 版本探测失败允许缺失（部分精简安装/权限受限），但给了就必须是字符串
        if (profile.version !== undefined) expect(typeof profile.version).toBe("string");
      } else {
        // 不可用必须给中文安装提示：UI 的禁用项 tooltip 依赖它
        expect(profile.detail, `${profile.key} 不可用时必须带 detail 安装提示`).toBeTruthy();
      }
    }
    if (process.platform === "win32") {
      expect(profiles.find((profile) => profile.key === "cmd")?.available, "Windows 上 cmd.exe 应可用").toBe(true);
    }
  });

  it("60s 内命中缓存：两次探测结果一致且返回副本（调用方改不坏缓存）", async () => {
    const first = await detectTerminalProfiles();
    const second = await detectTerminalProfiles();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    // 修改副本不应污染缓存
    second[0]!.available = !second[0]!.available;
    const third = await detectTerminalProfiles();
    expect(third[0]!.available).toBe(first[0]!.available);
  });
});

describe("resolveProfile（同步解析 / 不可用降级）", () => {
  beforeEach(() => {
    __resetTerminalProfileCacheForTests();
  });

  it("未知配置档 → null", () => {
    expect(resolveProfile("not-a-profile")).toBeNull();
    expect(resolveProfile("")).toBeNull();
  });

  it("每个配置档都有解析结果，可用性与探测结果一致", async () => {
    const profiles = await detectTerminalProfiles();
    for (const info of profiles) {
      const resolved = resolveProfile(info.key);
      expect(resolved, `${info.key} 应能解析`).not.toBeNull();
      expect(resolved!.key).toBe(info.key);
      expect(resolved!.kind).toBe(info.kind);
      expect(resolved!.available).toBe(info.available);
      if (info.available) {
        expect(resolved!.persistent, `${info.key} 可用时应有持久模式规格`).not.toBeNull();
        const spec = resolved!.buildOneShot("echo hello");
        expect(spec, `${info.key} 可用时应能构造一次性命令`).not.toBeNull();
        expect(typeof spec!.command).toBe("string");
        expect(spec!.command.length).toBeGreaterThan(0);
        expect(Array.isArray(spec!.args)).toBe(true);
      } else {
        // fail-closed：不可用环境不允许构造任何执行规格
        expect(resolved!.persistent).toBeNull();
        expect(resolved!.buildOneShot("echo hello")).toBeNull();
        expect(resolved!.detail).toBeTruthy();
      }
    }
  });

  it("持久/一次性启动参数符合约定（仅校验本机可用项，避免依赖安装情况）", async () => {
    const available = new Set(
      (await detectTerminalProfiles()).filter((info) => info.available).map((info) => info.key),
    );

    if (available.has("cmd")) {
      const resolved = resolveProfile("cmd")!;
      expect(path.basename(resolved.persistent!.command).toLowerCase()).toBe("cmd.exe");
      expect(resolved.persistent!.args).toContain("/K");
      const oneShot = resolved.buildOneShot("echo ok")!;
      expect(oneShot.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(oneShot.args[3]).toBe("echo ok");
    }
    if (available.has("powershell")) {
      const resolved = resolveProfile("powershell")!;
      expect(resolved.persistent!.args).toContain("-Command");
      expect(resolved.persistent!.args).toContain("-NoProfile");
      expect(resolved.persistent!.args[resolved.persistent!.args.length - 1]).toBe("-");
      const oneShot = resolved.buildOneShot("Write-Output ok")!;
      expect(oneShot.args[oneShot.args.length - 1]).toBe("Write-Output ok");
    }
    if (available.has("gitbash")) {
      const resolved = resolveProfile("gitbash")!;
      expect(resolved.persistent!.args).toEqual(["--noprofile", "--norc"]);
      const oneShot = resolved.buildOneShot("echo ok")!;
      expect(oneShot.args.slice(-2)).toEqual(["-c", "echo ok"]);
    }
    if (available.has("python")) {
      const resolved = resolveProfile("python")!;
      expect(resolved.persistent!.args).toContain("-u");
      expect(resolved.persistent!.args).toContain("-i");
      const oneShot = resolved.buildOneShot("print(1)")!;
      expect(oneShot.args.slice(-2)).toEqual(["-c", "print(1)"]);
    }
    if (available.has("node")) {
      const resolved = resolveProfile("node")!;
      expect(resolved.persistent!.args).toEqual(["-i"]);
      const oneShot = resolved.buildOneShot("console.log(1)")!;
      expect(oneShot.args).toEqual(["-e", "console.log(1)"]);
    }
    if (available.has("cpp")) {
      const resolved = resolveProfile("cpp")!;
      const persistentText = [resolved.persistent!.command, ...resolved.persistent!.args].join(" ").toLowerCase();
      const oneShot = resolved.buildOneShot("cl /?")!;
      const oneShotText = [oneShot.command, ...oneShot.args].join(" ").toLowerCase();
      if (persistentText.includes("vcvars64.bat")) {
        // MSVC：一次性执行也必须先初始化工具链环境，且命令要带上
        expect(oneShotText).toContain("vcvars64.bat");
        expect(oneShotText).toContain("cl /?");
      } else {
        // MinGW：编译器目录必须进入 PATH，否则 shell 里找不到 g++/clang++
        expect(resolved.persistent!.env?.PATH).toBeTruthy();
        expect(oneShot.env?.PATH).toBeTruthy();
        expect(oneShotText).toContain("cl /?");
      }
    }
  });
});

describe("终端环境变量白名单", () => {
  const previous = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_PROBE_KEYS) {
      previous.set(key, process.env[key]);
      process.env[key] = key === "LOOPSOAR_DATA_DIR" ? "C:\\secret-data" : `secret-${key.toLowerCase()}`;
    }
  });
  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
  });

  it("保留系统必需变量，剥离密钥 / LOOPSOAR_* 变量", () => {
    const env = buildTerminalEnv();
    // 必需变量：PATH 必然存在；其余按宿主实际存在性判断
    if (process.env.PATH) expect(env.PATH).toBe(process.env.PATH);
    if (process.env.SystemRoot) expect(env.SystemRoot).toBe(process.env.SystemRoot);
    if (process.env.COMSPEC) expect(env.COMSPEC).toBe(process.env.COMSPEC);
    for (const key of ENV_PROBE_KEYS) {
      expect(env[key], `敏感/业务变量 ${key} 不应进入终端子进程`).toBeUndefined();
    }
    expect(Object.keys(env).some((name) => /API_?KEY|TOKEN|SECRET|PASSWORD|LOOPSOAR_/i.test(name))).toBe(false);
    // Python 输出统一 UTF-8（避免 GBK 控制台乱码）；宿主已有配置时保留原值
    expect(env.PYTHONIOENCODING).toBe(process.env.PYTHONIOENCODING ?? "utf-8");
  });

  it("extra 可追加工具链变量，但敏感名仍被剥离", () => {
    const env = buildTerminalEnv({
      PATH: "C:\\custom-bin",
      MINGW_TEST_FLAG: "1",
      OPENAI_API_KEY: "sk-should-not-leak",
      LOOPSOAR_DATA_DIR: "C:\\should-not-leak",
    });
    expect(env.PATH).toBe("C:\\custom-bin");
    expect(env.MINGW_TEST_FLAG).toBe("1");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.LOOPSOAR_DATA_DIR).toBeUndefined();
  });
});

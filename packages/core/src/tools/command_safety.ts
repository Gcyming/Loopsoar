/**
 * 命令安全解析（P1-2）：不靠单条正则匹配原始字符串，而是先做 shell 词法还原，
 * 再按 argv 判断递归删除、管道执行、Windows 破坏性命令等语义。
 *
 * 定位：这是 hard_rules 的补充层，不是完整 shell 解释器。
 *  · 处理引号拼接（r''m → rm）、反斜杠转义、; && || | 分段、sudo/env/timeout/xargs 包装、
 *    bash -c / cmd /c / powershell -Command 嵌套；
 *  · 解析不了的语法交给原始正则兜底，不因解析失败而放行已知危险串；
 *  · 解析失败不直接 block（避免误杀正常命令），但可疑原始模式仍会命中。
 */

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "cmd", "powershell", "pwsh"]);
const WRAPPERS = new Set(["sudo", "doas", "command", "builtin", "exec", "nohup", "time", "nice", "env", "timeout", "xargs"]);

export interface CommandSegment {
  argv: string[];
}

function basename(value: string): string {
  return value.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/i, "") ?? value.toLowerCase();
}

/** POSIX-ish 词法：去引号、还原反斜杠转义、按控制符切段；Windows 反斜杠路径会丢分隔符，根路径检测另用 raw。 */
export function parseCommandSegments(input: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let argv: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;

  const pushToken = (): void => {
    if (token.length > 0) {
      argv.push(token);
      token = "";
    }
  };
  const pushSegment = (): void => {
    pushToken();
    if (argv.length > 0) {
      segments.push({ argv });
      argv = [];
    }
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else token += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        const next = input[i + 1];
        if (next && ['$', '`', '"', "\\", "\n"].includes(next)) {
          if (next !== "\n") token += next;
          i++;
        } else {
          token += "\\";
        }
      } else {
        token += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    // 未加引号的 ${IFS}/$IFS 在 shell 里是空白分隔符；不还原它，rm${IFS}-rf${IFS}/ 就能绕过 argv 检查。
    if (ch === "$" && (input.startsWith("${IFS}", i) || (input.startsWith("$IFS", i) && !/[A-Za-z0-9_]/.test(input[i + 4] ?? "")))) {
      pushToken();
      i += input.startsWith("${IFS}", i) ? 5 : 3;
      continue;
    }
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === "\n") {
        i++;
        continue;
      }
      if (next !== undefined) {
        token += next;
        i++;
        continue;
      }
    }
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")" || ch === "`") {
      pushSegment();
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    token += ch;
  }
  pushSegment();
  return segments;
}

function unwrap(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length) {
    const head = argv[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      i++;
      continue;
    }
    const name = basename(head);
    if (!WRAPPERS.has(name)) break;
    i++;
    if (name === "sudo" || name === "doas") {
      while (i < argv.length && argv[i]!.startsWith("-")) {
        // -u/-g 等选项带一个参数；保守地只跳过选项本身和紧随的非命令值
        if (["-u", "-g", "-p", "-C"].includes(argv[i]!)) i++;
        i++;
      }
    } else if (name === "env") {
      while (i < argv.length && (argv[i]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!))) i++;
    } else if (name === "timeout") {
      i++; // duration
      while (i < argv.length && argv[i]!.startsWith("-")) i++;
    } else if (name === "nice") {
      if (argv[i] === "-n") i += 2;
      else while (i < argv.length && argv[i]!.startsWith("-")) i++;
    } else if (name === "xargs") {
      while (i < argv.length && argv[i]!.startsWith("-")) i++;
    } else if (name === "time" || name === "nohup" || name === "command" || name === "builtin" || name === "exec") {
      // 无参数包装：直接继续
    }
  }
  return argv.slice(i);
}

function isRootTarget(target: string): boolean {
  const t = target.replace(/^['"]|['"]$/g, "").trim();
  if (!t) return false;
  if (["/", "/*", "/**", "~", "~/", "$HOME", "${HOME}"].includes(t)) return true;
  if (/^~[^/]*\/?$/.test(t)) return true;
  // C: / C:\ / C:/* / C:\.（词法可能已把反斜杠吃掉，所以同时接受 C:）
  if (/^[A-Za-z]:[\\/]?\*{0,2}$/.test(t)) return true;
  return false;
}

function flagsOf(args: string[]): Set<string> {
  return new Set(args.filter((arg) => /^[-/]/.test(arg)).map((arg) => arg.toLowerCase()));
}

function hasShort(flags: Set<string>, letter: string): boolean {
  for (const flag of flags) {
    if (/^-[a-z]+$/.test(flag) && flag.slice(1).includes(letter)) return true;
  }
  return false;
}

function nestedScript(argv: string[]): string | null {
  const name = basename(argv[0] ?? "");
  if (!SHELLS.has(name)) return null;
  const flagIndex = argv.findIndex((arg, index) => index > 0 && ["-c", "/c", "-command", "-encodedcommand"].includes(arg.toLowerCase()));
  if (flagIndex < 0) return null;
  // powershell -EncodedCommand 是 base64：不解码，直接交给原始正则/保守 block
  if (argv[flagIndex]!.toLowerCase() === "-encodedcommand") return argv[flagIndex + 1] ?? null;
  return argv[flagIndex + 1] ?? null;
}

function dangerousArgv(argv: string[]): string | null {
  const cmd = unwrap(argv);
  if (cmd.length === 0) return null;
  const name = basename(cmd[0]!);
  const args = cmd.slice(1);
  const flags = flagsOf(args);

  const nested = nestedScript(cmd);
  if (nested) {
    const hit = analyzeDangerousCommand(nested);
    if (hit) return `嵌套 shell：${hit}`;
  }

  if (name === "rm") {
    const recursive = hasShort(flags, "r") || flags.has("--recursive");
    const force = hasShort(flags, "f") || flags.has("--force");
    const roots = args.filter((arg) => !arg.startsWith("-") && isRootTarget(arg));
    if (recursive && force && roots.length > 0) return `rm 递归强制删除根目录（${roots[0]}）`;
  }

  if (name === "chmod") {
    const recursive = hasShort(flags, "r") || flags.has("--recursive");
    const mode = args.find((arg) => !arg.startsWith("-"));
    const roots = args.slice(args.indexOf(mode ?? "") + 1).filter(isRootTarget);
    if (recursive && mode === "777" && roots.length > 0) return "chmod -R 777 根目录";
  }

  if (name === "rd" || name === "rmdir") {
    const recursive = flags.has("/s") || hasShort(flags, "r") || flags.has("--recursive");
    const roots = args.filter((arg) => !arg.startsWith("/") && isRootTarget(arg));
    if (recursive && roots.length > 0) return `${name} 递归删除根目录（${roots[0]}）`;
  }

  if (name === "del" || name === "erase") {
    const recursive = flags.has("/s");
    const roots = args.filter((arg) => !arg.startsWith("/") && (isRootTarget(arg) || /^[A-Za-z]:[\\/].*\*$/.test(arg)));
    if (recursive && roots.length > 0) return `${name} /s 删除根目录（${roots[0]}）`;
  }

  if (name === "remove-item") {
    const recursive = flags.has("-recurse");
    const force = flags.has("-force");
    const roots = args.filter((arg) => !arg.startsWith("-") && isRootTarget(arg));
    if (recursive && force && roots.length > 0) return "Remove-Item 递归强制删除根目录";
  }

  if (["shutdown", "reboot", "poweroff", "halt"].includes(name)) return `${name} 系统关机/重启`;
  if (name === "diskpart") return "diskpart 磁盘分区操作";
  if (name === "bcdedit") return "bcdedit 启动配置修改";
  if (name === "format" && /^[A-Za-z]:$/.test(args[0] ?? "")) return "format 格式化盘符";

  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    const global = args.includes("-g") || args.includes("--global") || args.includes("global");
    const install = ["install", "i", "add"].includes(args[0] ?? "");
    if (global && install) return `${name} 全局安装`;
  }
  if ((name === "pip" || name === "pip3") && args[0] === "install") return "pip 全局安装";

  return null;
}

function rawDanger(cmd: string): string | null {
  // 词法可能被 cmd/powershell 引号打乱，补几条原始形态（不扩 DANGEROUS_COMMAND_RE 的 10 条契约）。
  if (/\b(?:rd|rmdir)\s+\/s\s+\/q\s+[A-Za-z]:[\\/]?\*?/i.test(cmd)) return "rd/rmdir /s /q 盘符根目录";
  if (/\bdel\s+\/f\s+\/s\s+\/q\s+[A-Za-z]:[\\/]?\*?/i.test(cmd)) return "del /f /s /q 盘符根目录";
  if (/\bRemove-Item\b[^\n]*(?:-Recurse|-r)\b[^\n]*(?:-Force|-fo)\b[^\n]*[A-Za-z]:[\\/]?\*?/i.test(cmd)) {
    return "Remove-Item 递归强制删除盘符根目录";
  }
  // curl/wget 管道进 shell（允许 env/sudo 包装）：按分段检查
  const segments = parseCommandSegments(cmd).map((segment) => unwrap(segment.argv));
  let sawDownload = false;
  for (const argv of segments) {
    if (argv.length === 0) continue;
    const name = basename(argv[0]!);
    if (name === "curl" || name === "wget") {
      sawDownload = true;
      continue;
    }
    if (sawDownload && SHELLS.has(name)) return `${name === "cmd" ? "cmd" : name} 执行下载内容`;
    sawDownload = false;
  }
  return null;
}

/** 返回危险原因；null = 未命中。 */
export function analyzeDangerousCommand(cmd: string): string | null {
  if (!cmd.trim()) return null;
  const raw = rawDanger(cmd);
  if (raw) return raw;
  for (const segment of parseCommandSegments(cmd)) {
    const hit = dangerousArgv(segment.argv);
    if (hit) return hit;
  }
  return null;
}

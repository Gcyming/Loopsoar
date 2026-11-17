/**
 * 危险命令规则（§4.3 S4）
 * DANGEROUS_COMMAND_RE：10 条正则（来源 slime 安全审计）
 * analyzeDangerousCommand：词法/argv 语义层，补正则可绕过的变形（P1-2）
 */
import { analyzeDangerousCommand } from "./command_safety.js";

export const DANGEROUS_COMMAND_RE = [
  // 1. rm -rf /（只命中根/家目录，不误杀 /tmp 等绝对路径；变形由语义层补）
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/(?:\s|$|\*)|~(?:\s|$|\/)|(?:\$HOME|\$\{HOME\})(?:\s|$|\/))/i,
  // 2. dd (磁盘覆盖)
  /\bdd\b/i,
  // 3. mkfs (格式化文件系统)
  /\bmkfs\b/i,
  // 4. curl | bash / wget | bash (管道下载执行)
  /(?:curl|wget)\s+[^\|]*\|\s*(?:bash|sh|zsh)/i,
  // 5. chmod -R 777 / (递归全权限)
  /\bchmod\s+-R\s+777\s+\//i,
  // 6. fork bomb `:(){ :|:& };:`（容忍空格变体）
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i,
  // 7. npm i -g / pip install 全局安装
  /\b(?:npm\s+i\s+-g|pip\s+install|pip3\s+install)/i,
  // 8. shutdown / reboot
  /\b(?:shutdown|reboot|poweroff)\b/i,
  // 9. 格式化盘符（Windows 格式化命令）
  /\bformat\s+[A-Z]:/i,
  // 10. 注册表删除（reg delete）
  /\breg\s+delete\b/i,
];

export function hardRuleCheck(cmd: string): { blocked: boolean; reason?: string } {
  for (let i = 0; i < DANGEROUS_COMMAND_RE.length; i++) {
    if (DANGEROUS_COMMAND_RE[i].test(cmd)) {
      return { blocked: true, reason: `匹配危险规则 #${i + 1}` };
    }
  }
  const semantic = analyzeDangerousCommand(cmd);
  if (semantic) return { blocked: true, reason: semantic };
  return { blocked: false };
}

export function targetFromArgs(args: string[]): string | null {
  if (args.length === 0) return null;
  // 提取路径目标：取最后一个参数作为目标路径占位
  const last = args[args.length - 1];
  return last && (last.startsWith("/") || last.startsWith(".") || /^[A-Za-z]:\\/.test(last)) ? last : null;
}

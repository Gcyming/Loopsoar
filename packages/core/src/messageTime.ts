/**
 * 模型可见的墙钟时间（消息时间戳）——纯函数，唯一产地。
 *
 * 背景（用户要求，2026-11-08）：Agent 把旧消息当新消息处理、缺乏时间感知。
 * 业界常见做法（Claude Code 注入 Current date、multica 的 add-time-awareness、
 * CLIProxyAPI 在 system reminder 里 pin 会话日期）都指向同一结论：
 *   · 只给「当前日期」不够 —— 模型需要每条消息的时间才能判断新旧与间隔；
 *   · 时间戳必须是确定性文本（同一历史消息每轮生成同样前缀），否则 KV 前缀缓存失效；
 *   · 格式用本地时区 24 小时制 `YYYY-MM-DD HH:mm`，并在 system 稳定段里解释格式语义。
 *
 * 本模块只做格式化与前缀，不做 I/O、不依赖 React/Electron。
 */

/** 两位数补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 把毫秒时间戳格式化成本地墙钟 `YYYY-MM-DD HH:mm`（24 小时制）。
 * 非法输入（非数字/0/负数/NaN）返回 null，调用方自行决定降级。
 */
export function formatWallClock(ts: number | null | undefined): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  const date = new Date(ts);
  const year = date.getFullYear();
  if (!Number.isFinite(year)) return null;
  return `${year}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 消息正文前缀的形态：`[YYYY-MM-DD HH:mm] `。 */
export const MESSAGE_TIME_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /;

/**
 * 给消息正文加上模型可见的时间前缀（幂等：已带前缀则不重复加）。
 * 无有效时间戳或空正文时原样返回，避免出现 `[undefined]` 之类脏文本。
 */
export function withWallClockPrefix(content: string, ts: number | null | undefined): string {
  const text = content ?? "";
  if (!text) return text;
  if (MESSAGE_TIME_PREFIX_RE.test(text)) return text;
  const stamp = formatWallClock(ts);
  if (!stamp) return text;
  return `[${stamp}] ${text}`;
}

/**
 * system 稳定段里的格式说明（**静态文本**，不含当前时间，保证 stable 字节级不变、KV 缓存可复用）。
 * 语义由这里唯一解释，服务层只负责加前缀。
 */
export const MESSAGE_TIME_INSTRUCTION =
  "消息时间约定：历史消息正文前的 `[YYYY-MM-DD HH:mm]` 是该条消息的本地墙钟时间（24 小时制）。请据此判断消息的新旧、时间间隔与先后顺序；旧消息里的请求不要当作当前的新请求重复执行，也不要假设消息按训练时间排列。";

/**
 * volatile 段里的「当前时间」一行：每轮随请求刷新，不进入 stable 段，因此不会破坏前缀缓存。
 */
export function currentWallClockLine(now: number = Date.now()): string {
  const stamp = formatWallClock(now);
  return stamp ? `当前本地时间：${stamp}` : "";
}

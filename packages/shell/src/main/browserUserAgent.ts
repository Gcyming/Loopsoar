/**
 * 浏览器分区的 User-Agent（单一产地）。
 *
 * 为什么不能直接用 Electron 默认 UA：默认串里带 `Loopsoar/0.0.2` 与 `Electron/xx`，
 * 不少下载站/网盘/学校系统的 WAF 会把它判成「非浏览器客户端」直接回 403/拦截页
 * （典型：CLisk 的 Tencent WAF 下载链接）。网页分区统一伪装成同版本的标准 Chrome，
 * 与用户本机 Chrome 发起的请求一致；应用自身窗口不经过这个分区，不受影响。
 */

/** 与 Electron 内置 Chromium 同版本的标准 Chrome UA（Windows/macOS/Linux 三平台）。 */
export function browserUserAgent(): string {
  const chrome = process.versions.chrome ?? "134.0.0.0";
  const platform =
    process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : process.platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

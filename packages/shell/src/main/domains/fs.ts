/**
 * fs 域：本地图片读取（仅附件缩略图用途；白名单扩展 + 6MB 上限）。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import { readImageDataUrl } from "../imageRead.js";

export function registerFsDomain(deps: TrustedIpcDeps): void {
  handleTrusted(deps, "fs:readImage", (payload) => {
    const p = payload as { path?: string };
    if (!p?.path) return { ok: false, error: "缺少 path" };
    return readImageDataUrl(p.path);
  });
}

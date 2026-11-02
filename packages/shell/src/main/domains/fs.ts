/**
 * fs 域：本地图片读取（附件缩略图）+ 剪贴板图片落盘。
 * 安全边界：读只允许图片扩展白名单 + 6MB；写只允许图片 MIME + 6MB，文件名由主进程生成。
 */
import { handleTrusted, type TrustedIpcDeps } from "../trustedIpc.js";
import { readImageDataUrl } from "../imageRead.js";
import { savePastedImage } from "../pastedImage.js";

export interface FsDeps extends TrustedIpcDeps {
  /** 数据目录（粘贴图片落到 <dataDir>/pasted-images/）；缺省用数据目录兜底。 */
  dataDir?: string;
}

export function registerFsDomain(deps: FsDeps): void {
  handleTrusted(deps, "fs:readImage", (payload) => {
    const p = payload as { path?: string };
    if (!p?.path) return { ok: false, error: "缺少 path" };
    return readImageDataUrl(p.path);
  });

  handleTrusted(deps, "fs:saveImage", (payload) => {
    const p = payload as { dataBase64?: string; mime?: string; name?: string };
    if (!p?.dataBase64) return { ok: false, error: "缺少图片数据" };
    return savePastedImage(deps.dataDir, {
      dataBase64: p.dataBase64,
      mime: p.mime,
      name: p.name,
    });
  });
}

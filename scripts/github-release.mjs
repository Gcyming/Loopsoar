/**
 * 用 GitHub REST API 创建 Release 并上传安装包（本机 git push 被重置时的发布通道）。
 *
 * 用法：
 *   $env:GH_TOKEN = "<token>"            # 只需要 repo 权限
 *   node scripts/github-release.mjs --tag v0.0.1 --notes docs/releases/RELEASE-NOTES-0.0.1.md
 *   node scripts/github-release.mjs --tag v0.0.1 --dry-run
 *
 * 说明：
 *   · 上传 release/dist 下的 exe / zip / blockmap / latest.yml / SHA256SUMS.txt；
 *   · 永不覆盖已存在的 release/tag（要改版本请先递增版本号，规则见 docs/发布阶段.md）；
 *   · token 只从环境变量读取，不写日志、不落盘。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = process.env.LOOPSOAR_OUT_DIR ? path.resolve(process.env.LOOPSOAR_OUT_DIR) : path.join(ROOT, "release/dist");
const repo = process.env.LOOPSOAR_GITHUB_REPO ?? "Gcyming/Loopsoar";
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
const dryRun = process.argv.includes("--dry-run");
const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : "";
const notesIndex = process.argv.indexOf("--notes");
const notesPath = notesIndex >= 0 ? process.argv[notesIndex + 1] : "";
const nameIndex = process.argv.indexOf("--name");
const releaseName = nameIndex >= 0 ? process.argv[nameIndex + 1] : `Loopsoar ${tag.replace(/^v/, "")}`;

if (!tag) {
  console.error("缺少 --tag（例如 --tag v0.0.1）");
  process.exit(2);
}
if (!token && !dryRun) {
  console.error("缺少 GH_TOKEN / GITHUB_TOKEN（只从环境变量读取）");
  process.exit(2);
}
if (!existsSync(DIST)) {
  console.error("找不到产物目录：", DIST);
  process.exit(2);
}

const assets = readdirSync(DIST).filter(
  (name) =>
    /\.(exe|zip|blockmap|yml|txt)$/i.test(name) &&
    !/^Uninstall/i.test(name) &&
    // 构建调试元数据含本机路径，只用于排查，不作为 Release 资产上传。
    name !== "builder-debug.yml",
);
const body = notesPath && existsSync(path.resolve(ROOT, notesPath)) ? readFileSync(path.resolve(ROOT, notesPath), "utf8") : "";
console.log("仓库：", repo, "tag：", tag, "产物：", assets.join(", "));
if (dryRun) {
  console.log("dry-run：未调用 GitHub API");
  process.exit(0);
}

const api = async (url, options = {}) => {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "loopsoar-release",
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${url} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

const release = await api(`https://api.github.com/repos/${repo}/releases`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    tag_name: tag,
    name: releaseName,
    body,
    draft: true,
    prerelease: true,
  }),
});
console.log("release draft 已创建：", release.html_url);

let uploadFailed = false;
for (const name of assets) {
  const file = path.join(DIST, name);
  const bytes = statSync(file).size;
  const uploadUrl = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes),
      "User-Agent": "loopsoar-release",
    },
    body: readFileSync(file),
  });
  if (!res.ok) {
    uploadFailed = true;
    console.error(`上传失败：${name} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  } else {
    console.log(`已上传：${name}（${(bytes / 1024 / 1024).toFixed(1)} MB）`);
  }
}

// 仓库启用了 immutable releases：已发布 release 不能再补资产，且 tag 一旦被
// 发布过的 release 使用就不能复用。因此必须先在 draft 状态传完所有资产，
// 全部成功后才 publish；任何一步失败都保留 draft，绝不发布半成品。
if (uploadFailed) {
  console.error(`存在上传失败，release 保持 draft：${release.html_url}`);
  process.exit(1);
}

const published = await api(`https://api.github.com/repos/${repo}/releases/${release.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ draft: false }),
});
console.log("release 已发布：", published.html_url);

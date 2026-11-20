#!/usr/bin/env node
/**
 * Publish committed local history to GitHub through the Git Data API.
 *
 * Why this exists: in the current network the git-receive-pack transport is reset
 * (`git push` → Empty reply / Connection reset), while api.github.com is reachable.
 * This script publishes each local commit since the remote branch head, preserving
 * the commit message, author, committer and tree. It refuses to publish when the
 * remote head is not an ancestor of local HEAD, so it never force-pushes or hides
 * divergence.
 *
 * Usage:
 *   GH_TOKEN=... node scripts/github-api-sync.mjs
 *   GH_TOKEN=... node scripts/github-api-sync.mjs --dry-run
 *
 * Token is read from GH_TOKEN / GITHUB_TOKEN, or `gh auth token` as a fallback.
 * It is never printed or written into the repository.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";
const ROOT = path.resolve(process.env.LOOPSOAR_REPO_ROOT || process.cwd());
const BRANCH = process.env.LOOPSOAR_GITHUB_BRANCH || "";
const DEFAULT_REPO = process.env.LOOPSOAR_GITHUB_REPO || "";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 6;

class SyncError extends Error {}

function fail(message) {
  throw new SyncError(message);
}

function git(args, { allowFail = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (allowFail) return null;
    throw new SyncError(`git ${args.join(" ")} 失败：${(result.stderr || "").trim()}`);
  }
  return result.stdout;
}

function gitBuffer(args) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new SyncError(`git ${args.join(" ")} 失败：${String(result.stderr || "").trim()}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || "");
}

/** Parse a GitHub remote URL, including the ghproxy form used on this machine. */
export function parseRemoteRepo(url) {
  const clean = String(url || "").trim().replace(/\.git$/i, "");
  const match = clean.match(/github\.com(?::\d+)?[:/]([^/]+)\/([^/]+)$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function resolveRepo() {
  if (DEFAULT_REPO.trim()) {
    const [owner, repo] = DEFAULT_REPO.split("/");
    if (owner && repo) return { owner, repo };
    fail(`LOOPSOAR_GITHUB_REPO 不是 owner/repo：${DEFAULT_REPO}`);
  }
  const remote = git(["remote", "get-url", "origin"], { allowFail: true });
  const parsed = parseRemoteRepo(remote);
  if (!parsed) fail("无法从 origin 解析 GitHub owner/repo；设置 LOOPSOAR_GITHUB_REPO=owner/repo");
  return parsed;
}

function resolveToken() {
  const direct = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (direct) return direct;
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  fail("缺少 GitHub token：设置 GH_TOKEN（或先 gh auth login），脚本不会把 token 写入文件");
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "loopsoar-github-api-sync",
  };
}

async function api(token, pathname, init = {}) {
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${API}${pathname}`, {
        ...init,
        headers: { ...authHeaders(token), ...(init.headers || {}) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : {};
      if (response.status === 401 || response.status === 403) {
        fail(`GitHub API 拒绝请求（${response.status}）：${text.slice(0, 300)}`);
      }
      lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`;
      if (response.status < 500 && response.status !== 429) fail(lastError);
    } catch (error) {
      if (error instanceof SyncError) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < MAX_ATTEMPTS) {
      console.error(`  API 重试 ${attempt}/${MAX_ATTEMPTS - 1}：${lastError}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(20_000, 1000 * 2 ** attempt)));
    }
  }
  fail(`GitHub API 失败：${pathname}（${lastError}）`);
}

function parseRawCommit(sha) {
  const raw = git(["cat-file", "-p", sha]);
  const split = raw.indexOf("\n\n");
  if (split < 0) fail(`commit ${sha} 缺少 message 分隔`);
  const header = raw.slice(0, split);
  const message = raw.slice(split + 2);
  const authorLine = header.match(/^author (.+) <([^>]+)> (\d+) ([+-]\d{4})$/m);
  const committerLine = header.match(/^committer (.+) <([^>]+)> (\d+) ([+-]\d{4})$/m);
  const tree = header.match(/^tree ([0-9a-f]{40,64})$/m);
  if (!authorLine || !committerLine || !tree) fail(`commit ${sha} 的 header 无法解析`);
  const parents = [...header.matchAll(/^parent ([0-9a-f]{40,64})$/gm)].map((match) => match[1]);
  return {
    tree: tree[1],
    parents,
    message,
    author: { name: authorLine[1], email: authorLine[2], date: unixToIso(authorLine[3], authorLine[4]) },
    committer: {
      name: committerLine[1],
      email: committerLine[2],
      date: unixToIso(committerLine[3], committerLine[4]),
    },
  };
}

function unixToIso(seconds, offset) {
  const sign = offset.startsWith("-") ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(3, 5));
  const date = new Date((Number(seconds) + sign * (hours * 3600 + minutes * 60)) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  // GitHub 的 date-time 校验要求 +08:00，而 git raw header 是 +0800。
  const isoOffset = `${offset.slice(0, 3)}:${offset.slice(3, 5)}`;
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${isoOffset}`
  );
}

function readBlob(pathname) {
  const bytes = gitBuffer(["show", `${pathname}`]);
  const hasNul = bytes.includes(0);
  if (!hasNul) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { encoding: "utf-8", content: text };
    } catch {
      // Fall through to base64 for invalid UTF-8.
    }
  }
  return { encoding: "base64", content: bytes.toString("base64") };
}

function changedPaths(parent, commit) {
  const raw = git(["diff", "--name-only", "-z", parent, commit]);
  return raw.split("\0").filter(Boolean);
}

function lsTree(commit, pathname) {
  const raw = git(["ls-tree", "-z", commit, "--", pathname]);
  if (!raw) return null;
  const row = raw.split("\0")[0] || "";
  const tab = row.indexOf("\t");
  if (tab < 0) return null;
  const [mode, type, sha] = row.slice(0, tab).split(" ");
  return { mode, type, sha };
}

async function publish(token, repo, branch, remoteSha, localHead, dryRun) {
  const remoteRef = await api(token, `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (remoteRef.object?.sha !== remoteSha) {
    fail(`远端 ${branch} 在读取期间变化：${remoteRef.object?.sha || "unknown"}（预期 ${remoteSha}）`);
  }
  const localRemoteExists = git(["cat-file", "-e", `${remoteSha}^{commit}`], { allowFail: true }) !== null;
  if (!localRemoteExists) fail(`本地缺少远端 commit ${remoteSha}；先运行 git fetch，不能靠猜写远端历史`);
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", remoteSha, localHead], { cwd: ROOT });
  if (ancestor.status !== 0) fail(`远端 ${remoteSha} 不是本地 HEAD 的祖先；先对齐/ rebase，脚本不做 force push`);

  const commits = git(["rev-list", "--reverse", `${remoteSha}..${localHead}`])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (commits.length === 0) {
    console.log(`已同步：${branch} = ${localHead}`);
    return remoteSha;
  }

  let remoteParent = remoteSha;
  let parentTree = (await api(token, `/repos/${repo.owner}/${repo.repo}/git/commits/${remoteSha}`)).tree.sha;
  let uploaded = 0;
  for (const commit of commits) {
    const info = parseRawCommit(commit);
    if (info.parents.length !== 1) fail(`暂不支持 merge commit：${commit}（parents=${info.parents.length}）`);
    if (info.parents[0] !== remoteParent) {
      fail(`本地 commit ${commit.slice(0, 12)} 的 parent 与远端发布链不一致（${info.parents[0]} vs ${remoteParent}）`);
    }
    const localTree = git(["rev-parse", `${commit}^{tree}`]).trim();
    if (localTree !== info.tree) fail(`commit ${commit.slice(0, 12)} 的 tree 读取不一致`);

    const entries = [];
    for (const pathname of changedPaths(info.parents[0], commit)) {
      const row = lsTree(commit, pathname);
      if (!row) {
        entries.push({ path: pathname, mode: "100644", type: "blob", sha: null });
        continue;
      }
      if (row.type !== "blob") fail(`暂不支持目录/子模块变更：${pathname}（${row.type}）`);
      if (dryRun) {
        entries.push({ path: pathname, mode: row.mode, type: "blob", sha: row.sha });
        continue;
      }
      const blob = readBlob(`${commit}:${pathname}`);
      const created = await api(token, `/repos/${repo.owner}/${repo.repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify(blob),
      });
      if (created.sha !== row.sha) fail(`blob 上传后 SHA 不一致：${pathname}`);
      entries.push({ path: pathname, mode: row.mode, type: "blob", sha: created.sha });
      uploaded += 1;
    }

    if (dryRun) {
      console.log(`[dry-run] ${commit.slice(0, 12)} ${info.message.split("\n")[0]}（${entries.length} 个路径）`);
      remoteParent = commit;
      parentTree = localTree;
      continue;
    }

    const tree = await api(token, `/repos/${repo.owner}/${repo.repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: parentTree, tree: entries }),
    });
    if (tree.sha !== localTree) fail(`tree 不一致：${commit.slice(0, 12)} local=${localTree} remote=${tree.sha}`);
    const created = await api(token, `/repos/${repo.owner}/${repo.repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: info.message,
        tree: localTree,
        parents: [remoteParent],
        author: info.author,
        committer: info.committer,
      }),
    });
    if (created.sha !== commit) {
      fail(
        `GitHub 生成的 commit SHA 与本地不同：local=${commit} remote=${created.sha}\n` +
          "为避免制造分叉，脚本未更新远端 ref。请把这条信息反馈给维护者。",
      );
    }
    remoteParent = created.sha;
    parentTree = tree.sha;
    console.log(`已发布 ${commit.slice(0, 12)} ${info.message.split("\n")[0]}`);
  }

  if (dryRun) return remoteParent;
  await api(token, `/repos/${repo.owner}/${repo.repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: remoteParent, force: false }),
  });
  git(["update-ref", `refs/remotes/origin/${branch}`, remoteParent], { allowFail: true });
  console.log(`远端 ${branch} -> ${remoteParent}（${commits.length} 个提交，上传 ${uploaded} 个 blob）`);
  return remoteParent;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    console.log("用法：GH_TOKEN=... node scripts/github-api-sync.mjs [--dry-run] [--allow-dirty]");
    return;
  }
  const dryRun = args.has("--dry-run");
  const allowDirty = args.has("--allow-dirty");
  const repo = resolveRepo();
  const branch = BRANCH || git(["symbolic-ref", "--short", "HEAD"]).trim();
  if (!branch) fail("当前是 detached HEAD；切到分支后再发布");
  const dirty = git(["status", "--porcelain"]).trim();
  if (dirty && !allowDirty) fail("工作树不干净；先提交，或显式加 --allow-dirty（脚本只发布 HEAD）");
  const token = resolveToken();
  const localHead = git(["rev-parse", "HEAD"]).trim();
  const ref = await api(token, `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const remoteSha = ref.object?.sha;
  if (!remoteSha) fail(`无法读取远端 ${branch}`);
  console.log(`repo=${repo.owner}/${repo.repo} branch=${branch}`);
  console.log(`local=${localHead} remote=${remoteSha}${dryRun ? "（dry-run）" : ""}`);
  await publish(token, repo, branch, remoteSha, localHead, dryRun);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`github-api-sync: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

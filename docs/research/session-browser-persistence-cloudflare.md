# 会话/网页持久化：Cloudflare + GitHub 方案查证

> 状态：**仅查证，不实施云端**（2026-11-01）。本地持久化已在 ADR-0014 实现；本文回答"没有服务器，能否用 Cloudflare 关联 GitHub 做跨设备持久化"。
>
> 结论：**技术上可行，免费额度对个人使用足够**；但不建议"GitHub 仓库当数据库"，推荐 **Cloudflare Workers + D1 + GitHub OAuth Device Flow + 自定义域名 + 客户端加密**。Cloudflare Pages 只负责静态页面/部署，不能单独提供数据写入能力。

---

## 1. 先厘清几个产品的能力边界

| 组件 | 能不能存会话数据 | 说明 |
|---|---|---|
| **Cloudflare Pages** | ❌ 单独不行 | 静态站点托管；GitHub 关联的是"构建/部署来源"，每次推送触发构建，不是数据读写通道。静态资源请求免费且不限量。 |
| **Pages Functions** | ✅（作为 API 层） | Pages 里的动态函数实际运行在 **Workers** 上；免费额度与 Workers 共享。适合把同步 API 放在 Pages 项目里。 |
| **Cloudflare Workers** | ✅（作为 API 层） | 无服务器函数，免费 100,000 请求/天、10ms CPU/请求、128MB 内存、50 子请求/请求。做鉴权 + 读写 D1 足够轻。 |
| **D1** | ✅（推荐存储） | 无服务器 SQLite；免费 5GB 总存储、500MB/库、5M 行读/天、100k 行写/天、10 个库、7 天 Time Travel。会话快照是 KB 级，个人用远低于额度。 |
| **KV** | ⚠️ 可用但不推荐 | 最终一致、写入额度低；会话快照要求"写完立刻读回一致"，D1 更合适。 |
| **R2** | ✅（备选） | 对象存储，适合加密大 blob；但会话快照很小，D1 单表足够。 |
| **Durable Objects** | ✅（实时协作才需要） | 未来若做多设备实时同步/冲突串行化再考虑；本轮不需要。 |

来源（官方文档）：
- [Workers 限制（Free/Paid 表）](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 价格/免费额度](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 限制](https://developers.cloudflare.com/d1/platform/limits/)
- [Pages Functions 概述](https://developers.cloudflare.com/pages/functions/)
- [Pages Functions 计费（计入 Workers Free 100k/天）](https://developers.cloudflare.com/pages/functions/pricing/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)

### GitHub 在这里扮演什么角色

- **Pages 的 GitHub 集成** = 仓库推送 → 自动构建部署（CI/CD），不提供运行时数据存储：
  [Pages GitHub integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/)
- **GitHub 仓库当数据库**：可以用 Contents API 每次写一个 JSON 文件（一次 commit），但：
  - 认证用户 REST API 通常 **5,000 请求/小时**（还有次级限流）：
    [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
  - 每次保存 = 一次 commit，仓库历史迅速膨胀；
  - 无查询、无并发控制，冲突只能靠 pull/merge，桌面端还要处理 base64 与 SHA 条件更新：
    [Contents API](https://docs.github.com/en/rest/repos/contents)
  - 私密页面的 URL 历史进 Git 历史，隐私面更大。
- **结论**：GitHub 适合"代码/配置版本化备份"，不适合承载每次导航/退出的会话快照；可以保留为"云端快照的二次备份"（低频导出到仓库），不作为主链路。

### 自定义域名

- Workers 支持自定义域名（需要域名所在的 Cloudflare zone）：
  [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- Pages 也支持自定义域名：
  [Pages Custom Domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)
- 用户已有域名即可用免费计划接入；不需要买服务器。若域名不在 Cloudflare，需要把 NS 迁到 Cloudflare（免费计划即可）。

---

## 2. 推荐方案（免费可落地）

```
Loopsoar 桌面端（本地优先）
  ├─ sessions/<id>.json 已含 browser: { tabs, activeIndex }   ← 已实现
  ├─ 本地变更 → 防抖/退出时生成快照（只存 URL/标题/历史，不存页面正文）
  ├─ 客户端加密（WebCrypto AES-GCM，密钥来自用户口令/系统钥匙串）
  └─ HTTPS 上传/下载（自定义域名，如 sync.example.com）
                    │
Cloudflare Worker（无服务器）
  ├─ GitHub OAuth Device Flow 登录（桌面端不需要 client secret）
  ├─ 校验会话令牌 → user_id
  ├─ D1：users / devices / session_snapshots
  └─ 只存密文与版本号；看不到页面 URL 明文
```

### 2.1 登录：GitHub OAuth Device Flow

桌面应用不能安全保存 OAuth App 的 client secret，因此用 **Device Flow**：
- Worker 持有 GitHub OAuth App 的 `client_id`（公开）+ `client_secret`（Worker secret）；
- Loopsoar 请求 Worker 获取 `user_code`，浏览器打开 GitHub 授权页输入码；
- Worker 轮询 GitHub 换取 token → 取 GitHub 用户 id → 签发自己的短期会话 token 给桌面端；
- 只申请最小 scope（如 `read:user`），**不需要 repo 权限**，除非用户主动启用"GitHub 备份"。

参考：[GitHub OAuth Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)

### 2.2 存储：D1 表结构（草案）

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,            -- 内部用户 id
  github_id INTEGER UNIQUE NOT NULL,
  login TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE session_snapshots (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,       -- AES-GCM 密文（base64），服务端不可读
  version INTEGER NOT NULL,       -- 单调递增，用于冲突检测
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
```

- 单行 < 2MB（D1 行大小上限 2MB），会话快照 KB 级；
- 查询走主键，索引成本低；免费 5M 行读/天足够；
- 不保存聊天正文，只保存 `browser` 快照（可按用户设置只同步标签列表）。

### 2.3 加密与隐私

页面 URL 可能包含搜索词、账号信息，属于敏感数据。建议：
- 客户端用 **AES-GCM** 加密整个快照，密钥由用户口令经 PBKDF2（高迭代）派生，或存入系统钥匙串；
- Worker 只存密文 + 版本号；即使 D1 泄露也拿不到 URL；
- 代价：忘记口令无法恢复（需提供恢复码/导出备份）；多设备必须同一口令；
- 若用户不想加密，至少提供"只同步会话名/不包含 URL"的降级选项。

### 2.4 同步语义（不做实时）

- 触发：退出应用、切换会话、每 5 分钟（可配）或手动"立即同步"；
- 冲突：每会话 `version` 单调递增；上传时带 `base_version`，服务端不匹配返回 409 + 最新密文；桌面端提示"本机/云端二选一"或按标签 URL 并集合并；
- 多设备：同一会话以 `updated_at` 新者为主，冲突显式提示，不静默覆盖；
- 网络失败：本地始终可用；下次启动重试；不做实时双向同步/长连接。

### 2.5 免费额度估算（个人）

| 项目 | 用量 | 免费额度 | 结论 |
|---|---|---|---|
| Worker 请求 | 每次同步 1-2 次；每天几十次 | 100k/天 | 远够 |
| D1 行写 | 每会话每次保存 1 行；每天几十~几百 | 100k/天 | 远够 |
| D1 行读 | 启动/切会话读取 | 5M/天 | 远够 |
| D1 存储 | 100 会话 × 几 KB ≈ <1MB | 5GB | 远够 |
| 域名 | 用户已有域名 | 免费计划可接 | 无需服务器 |

风险：免费计划无 SLA、额度/策略可能调整；Workers Free 单请求 CPU 10ms，鉴权 + D1 尽量轻量（大 payload 加密放客户端）。若未来多设备频繁同步，升级 Workers Paid（$5/月起）即可，不需要自建服务器。

---

## 3. 备选方案对比

| 方案 | 成本 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **Cloudflare Workers + D1**（推荐） | 免费/低 | 无服务器、自定义域名、额度足够、D1 强一致 | 需要 Cloudflare 账号/域名 zone；免费 CPU 10ms | ✅ 推荐 |
| Cloudflare Pages + Functions | 免费 | 与静态站一起部署 | Functions 仍是 Workers/D1；Pages 本身不存数据 | ✅ 可用，API 放 Pages Functions |
| GitHub 仓库/Gist 当存储 | 免费 | 零基础设施、版本历史 | 5k 请求/小时、每次 commit、无并发/查询、隐私差 | ❌ 不推荐主链路 |
| Cloudflare R2 存加密 blob | 免费额度大 | 大对象便宜 | 小快照不划算；元数据仍需 D1/KV | ⚠️ 备选 |
| Supabase/Firebase | 免费额度 | 现成 Auth/DB | 第三方依赖、Sleep/限额、数据出境 | ⚠️ 备选 |
| 家里机器 + Cloudflare Tunnel | 免费 | 完全自控 | 需要常开机器；关机即不可用 | ❌ 不是"无服务器持久化" |

---

## 4. 落地前需要用户确认的点

1. **数据范围**：只同步 `browser` 标签/URL/标题，还是也同步聊天记录/时间线？（聊天正文体积大且敏感，建议分开授权）
2. **加密口令**：是否接受"口令丢失无法恢复"？是否提供导出恢复码？
3. **登录方式**：GitHub Device Flow 是否需要公开 OAuth App（审核/限流）？个人自用可先用私有 OAuth App。
4. **域名**：用哪个域名做 `sync.xxx`；域名是否已在 Cloudflare 托管（不在则需迁 NS）。
5. **冲突策略**：默认"新者覆盖 + 提示"是否可接受，还是每次冲突都要手动选？
6. **是否允许 GitHub 仓库二次备份**（低频导出加密快照）？若不需要，GitHub 仅作为登录身份，不碰仓库。

确认后再进入实现阶段：新增 `contracts` 同步配置 schema → shell `cloudSync` 模块（可注入 fake server 测试）→ 设置页"云同步"分区 → 不做实时。实现前不会修改现有本地持久化语义。

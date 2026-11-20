# 扩展贡献点（contributes）API

> 适用版本：插件生态 v2（API 2.0）。清单文件：`<dataDir>/extensions/<dir>/loopsoar.extension.json`。
> 原则：**声明式贡献点一律是数据，不执行扩展代码**；需要跑代码的能力走扩展 worker 的工具桥（权限交集 + 沙箱确认），
> 富 UI 视图则跑在独立 origin 的沙箱 iframe 中（见 §4），拿不到主界面 DOM / Electron API。

## 1. 支持的类型

| 贡献点 | 作用 | 边界 |
| --- | --- | --- |
| `commands` | Composer 斜杠命令（只把 prompt 填进输入框） | id 字母数字 . _ - |
| `instructions` | 启用后注入 volatile 段的系统指令 | ≤4,000 字符 |
| `ui` | 设置页只读文本/键值面板 | 不接受 HTML/JS |
| `hooks` | `turn.start` 每轮注入提示词 | 仅声明式 |
| `loops` | 注册进 LoopRegistry 的 L2 声明式 loop | 只能收紧预算；与内置同样受回退约束 |
| `themes` | 覆盖白名单 CSS 变量 | 只接受 hex / rgb() / hsl()，不接受 `var()`/`url()`/分号 |
| `views` | 设置页富 UI（HTML/JS/CSS） | 只从扩展目录经 `loopsoar-ext://` 提供，沙箱 iframe + 严格 CSP |

## 2. loops

```json
{
  "id": "loop-theme-demo",
  "name": "Loop / 主题示例",
  "version": "0.1.0",
  "contributes": {
    "loops": [
      {
        "id": "focused",
        "name": "专注模式",
        "description": "更少轮次、只读工具",
        "systemPromptAppend": "本轮以核对事实为主，不要修改文件。",
        "maxRounds": 6,
        "maxToolCalls": 12,
        "allowedTools": ["file_read", "memory_search"]
      }
    ]
  }
}
```

- 注册 id 统一为 `ext.<扩展 id>.<loop id>`，与用户手写 loop（`<dataDir>/loops`）隔离；
- `maxRounds` / `maxToolCalls` 只能**收紧**（与调用方及 `BUDGET_HARD` 取 min），不能放大；
- `systemPromptAppend` 作为额外 user 消息追加，不改 stable 系统提示（保 KV 前缀缓存）；
- 运行失败/静态校验失败时按 LoopRegistry 铁律回退 builtin；已执行工具时不重放副作用；
- **停用/卸载扩展会精确撤下**：若该 loop 正好是活动 loop，先切回 builtin 再移除。

## 3. themes

```json
{
  "contributes": {
    "themes": [
      {
        "id": "midnight",
        "name": "午夜",
        "tokens": { "ls-bg": "#0b0d12", "ls-surface": "#12151c", "ls-accent": "#e0a15a" }
      }
    ]
  }
}
```

- 注册 id 为 `ext.<扩展 id>.<theme id>`，设置·外观的下拉里直接可选；
- 只允许 `EXTENSION_THEME_TOKENS` 白名单（bg/surface/border/text/accent/danger/teal 等 13 个）；
- 值必须是 `#rgb`/`#rrggbb(aa)`/`rgb()`/`rgba()`/`hsl()`/`hsla()`；
- 应用时以 soft 主题为底，只覆盖贡献的变量；切走/卸载即清除内联变量。

## 4. views（富 UI）

```json
{
  "id": "demo-panel",
  "name": "Demo Panel",
  "version": "1.0.0",
  "apiVersion": "2.0.0",
  "engines": { "loopsoar": ">=0.1.0" },
  "contributes": {
    "views": [{ "id": "panel", "title": "面板", "entry": "views/panel.html", "height": 380 }]
  }
}
```

- 视图消息由 `api.onViewMessage(viewId, handler)` 订阅，**不需要**写进 `events`（`events` 只列生命周期钩子）；
- URL 固定为 `loopsoar-ext://<extension-id>/<entry>`；只服务**已启用且声明了 views**的扩展目录，
  服务端做 realpath 校验，拒绝 `../`、绝对路径与 symlink 逃逸，单文件上限 8MB；
- 响应带 `default-src 'none'` / `connect-src 'none'` / `frame-ancestors loopsoar://*`，
  渲染层 iframe 使用 `sandbox="allow-scripts allow-forms"`（无 same-origin），扩展拿不到主界面存储或 Electron API；
- 视图加载后 `postMessage({ source: "loopsoar-extension", viewId, type: "ready" })`；
  向宿主发消息用 `type: "message"`，宿主回复为 `{ source: "loopsoar-host", type: "message", payload }`；
- 自适应高度：`type: "resize", height: 600`（200–1200 之间）。

## 5. events（代码级钩子）

清单顶层声明 `events` 后，worker 必须使用协议 v2（`ready` 里回报 `protocol: 2` 与 `events` 列表）：

| 事件 | 时机 | 返回值 |
| --- | --- | --- |
| `turn.start` | 每轮模型调用前 | `{ promptAppend?: string }`，追加进 volatile 段 |
| `turn.end` | 本轮结束后（旁路） | 忽略 |
| `tool.before` | 工具权限/沙箱/确认全部通过后、执行前 | `{ allow: false, reason }` 可否决；不能放行 |
| `tool.after` | 工具执行后（旁路） | 忽略 |

（视图消息不走 `events`：用 §4 的 `api.onViewMessage(viewId, handler)`，按 viewId 路由。）

- 钩子异常/超时 fail-open（`turn.start`/`tool.before` 2s，其余 5s），**安全边界仍是工具权限/沙箱/确认**；
- `events` 权限不替代工具权限：每个工具仍需在 manifest `permissions` 与工具声明之间取交集（fail-closed）。

## 6. 清单版本、依赖与签名

```json
{
  "id": "demo",
  "version": "1.2.0",
  "apiVersion": "2.0.0",
  "engines": { "loopsoar": ">=0.1.0 <1.0.0" },
  "dependencies": { "base-lib": "^1.0.0" },
  "signature": {
    "algorithm": "ed25519",
    "publicKey": "<base64 SPKI DER>",
    "value": "<base64 签名>",
    "signedAt": 1730000000000
  }
}
```

- `version` 必须是完整 SemVer（市场更新/回滚/依赖比较都依赖它）；`apiVersion` 大版本高于宿主 → blocked；
- `engines.loopsoar` 缺省只给 warning，市场严格认证可要求必填；范围必须能被宿主 SemVer 解析；
- `dependencies` 的版本范围不满足 → 依赖者 blocked；启用会自动拉起依赖闭包，禁用会级联禁用依赖者；
- 签名对象是「去掉 `signature` 字段后的规范化清单」（键排序、无空白），公钥指纹 = `sha256:<SHA-256(SPKI DER) 的 hex>`；
- 包摘要覆盖扩展目录内全部文件（相对路径 + 长度 + 内容，排序后 SHA-256），与签名一起决定 `trusted/untrusted/unsigned/invalid`；
- 指纹必须由公钥重算，信任库拒绝渲染层伪造的 fingerprint；`strict` 策略下未信任签名不可安装/启用。

## 7. 生命周期

1. 安装：设置页「安装扩展」选择 `.zip` 或目录（也可手动放到 `<dataDir>/extensions/<dir>/`）；
   安装会经历暂存 → 兼容/签名/摘要/依赖校验 → 备份 → 原子替换，失败自动还原；
2. 启用：设置·扩展开关 → `extensions:setEnabled` → 依赖闭包自动启用 → `ExtensionHost.onChange` → `ExtensionContributions.sync()`；
3. 生效：loop 立即出现在设置·通用·Loop 列表；theme 立即出现在外观下拉；views 出现「打开面板」；
4. 更新：市场检测到更高版本或再次安装新版本，旧版本进 `.backups`；
5. 回滚：设置页「回滚」恢复上一备份（同样重跑签名/摘要/兼容校验）；
6. 停用/卸载：先撤 loop（必要时回退 builtin），theme 从列表消失；依赖者级联禁用。

## 8. 校验与失败

- 清单由契约层 `ExtensionManifestSchema` 校验；任何非法贡献（坏 id、越界预算、非白名单 token、CSS 注入值）→ **整个清单解析失败**，扩展被跳过并在设置页显示跳过原因（fail-closed）。
- 贡献 id 冲突（重复）不会静默覆盖：进入 `contributions.conflicts`，设置页红字展示。
- 扩展 worker（`main`）仍受权限交集、超时、崩溃退避约束；贡献点不改变这些规则。
- ZIP 读取拒绝路径穿越、绝对路径、反斜杠、symlink、加密/ZIP64、重复路径、CRC 不符、超限条目/体积。

## 9. 示例

- `examples/extensions/loop-theme-demo/`：loops + themes，纯声明式（无 main）。
- `examples/extensions/prompt-commands/`：commands / instructions / hooks。
- `examples/extensions/rich-panel-demo/`：worker 协议 v2 + 富 UI + `onViewMessage` + 工具（`tests/shell/extensionExample.spec.ts` 会真实启动它）。

## 10. 开发者工作流（签名 / 校验）

```bash
pnpm install && pnpm build                 # CLI 复用 core/contracts 的 dist
pnpm ext:keygen --out .loopsoar-keys       # 生成 Ed25519 私钥/公钥（私钥勿提交）
pnpm ext:sign -- ./my-extension --key .loopsoar-keys/extension-key.pem
pnpm ext:verify -- ./my-extension --trusted .loopsoar-keys/extension-key.pub
```

- `ext:sign` 会先重算并写入 `integrity`（排除 manifest 自身），再签「manifest + integrity」；签完再改任何文件都会让校验失败；
- 发布时把「公钥/指纹」和 zip 一起分发；用户首次安装会出现信任确认，信任后 strict 策略才允许启用；
- `ext:verify --trusted` 可传公钥文件、公钥 base64 或 `sha256:` 指纹；摘要/签名失败退出码非 0，可直接进 CI；
- 最小 worker 示例见 `examples/extensions/rich-panel-demo/index.mjs`，视图通信见同目录 `views/panel.js`；
- 端到端验收：`pnpm e2e:extension`（真实 Electron，截图 `e2e-evidence/p2-extension-panel.png`），
  断言 iframe `ready`/`resize` 与 `viewMessage` 回包，不通过则退出码非 0。

## 11. 市场运营（静态托管，零服务器）

registry 就是一份可静态托管的 `index.json`（GitHub Pages / 对象存储 / 内网 CDN），zip 与它同目录或用 `--base-url` 指向别处；客户端只依赖 `ExtensionRegistryIndexSchema`。

```bash
pnpm market:keygen --out .loopsoar-market-keys            # 市场目录专用密钥（与扩展签名密钥分开）
pnpm market:build -- ./dist/extensions \
  --base-url https://cdn.example.com/extensions \
  --out ./dist/extensions/index.json \
  --key .loopsoar-market-keys/market-key.pem \
  --expires-days 30 --revocations ./revocations.json
pnpm market:verify -- ./dist/extensions/index.json --key .loopsoar-market-keys/market-key.pub
```

- `market:build` 从目录内 `.zip` 读取 manifest，自动填 `sha256`/`size`/`engines`/`latest`，按 id 合并多版本；重复版本直接失败；
- 目录签名覆盖除 `signature` 外的全部字段（plugins、revocations、expiresAt、channel），改任何一个字节都会让签名失效；
- 客户端「设置·扩展·市场」里可配置市场公钥；配置后**强制执行 trusted 签名**，拒绝未签名/非受信目录，避免 registry 被替换后把更新指向旧版或恶意包；
- `expiresAt` 防止长期缓存回滚；`channel` 用不同 index URL 实现 stable/beta 灰度（客户端展示但不自行切换）；
- `revocations` 是安装后的止损通道：命中 `id`（可限定 `version`，缺省全部版本）的扩展会被持久化到 `extensions-revocations.json`，重扫后 `certification=blocked`、停止 worker，且不能再启用/安装；撤销采用并集，后续目录省略条目不会“复活”；
- 密钥轮换：新公钥重新信任并重签目录；旧公钥在设置页「撤销密钥」后保留审计记录，但立即退出有效信任集，旧签名扩展变为 invalid/blocked；
- 静态托管的天然限制：无法实时远程停用、不能做账号/评分/支付；这些需要服务端，不属于当前零服务器方案。需要服务端才能做的完整清单见 [`docs/服务端待办.md`](./服务端待办.md)。

## 12. 信任与撤销的边界

- 扩展包签名：证明「包内容 + 清单」未被替换；目录签名：证明「市场让你装的就是这个包」；两者不能互相替代；
- 公钥永远由客户端显式配置/信任，目录里的 `signature.publicKey` 只是候选材料，不能自证可信；
- `warn`（默认）允许未信任扩展运行但标记 unverified；`strict` 只允许 trusted；`invalid` 在所有策略下都 blocked；
- 撤销和过期是 fail-closed：目录过期、签名无效、密钥被撤销都会拒绝目录或阻止启用，而不是降级放行。

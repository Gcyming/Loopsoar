# 密钥安全（API Key 存储与隔离）

## 1. 结论

| 项 | Loopsoar 做法 |
|---|---|
| 用户输入 | 设置 · 供应商 → 「API 密钥」密码框，保存时加密落盘 |
| 加密 | 首选 **Electron safeStorage**（Windows DPAPI / macOS Keychain / Linux libsecret） |
| 降级 | 系统密钥库不可用时用 **AES-256-GCM**，密钥文件 `<configDir>/.secret.key`（0600），诊断页标注 `degraded` |
| 读取 | 只在**主进程**解密；渲染层永远拿不到明文，只显示掩码（`sk-…ab12`） |
| 回传 | `settings:getProvider` / `listProviders` 只返回 `hasKey / keyHint / keySource / storageMode` |
| 日志/审计 | 审计只记 `channel/sender/status`（不含 payload）；错误文案不回显密钥；Key 不进 rules/会话/记忆 |
| 环境变量 | `LOOPSOAR_API_KEY` 仍支持，但**优先级低于**已保存密钥（便于 CI / 无密钥库环境） |
| 隔离 | 每个供应商独立一条密钥记录（`secrets.enc.json.items[providerId]`）；删除供应商同时清理其密钥 |

## 2. 借鉴 slime 的教训（只读参考 `D:\pilot project`）

- slime 把 `api_key` 放在 providers 表里，用 `core-ts/src/encryption.js` 加密写成 `config/providers.enc.json`；
  - 优点：**落盘即密文**；列表只暴露 `has_key` + `key_hint`（`maskKey`），不把明文送渲染层；
  - 我们沿用这条原则（加密落盘 + 掩码回传），但加密实现换成 OS 级 safeStorage，减少自管理密钥的风险；
- slime 的 auth token 也单独加密存 `config/auth_token.enc`——说明**密钥与普通配置分离**是对的，Loopsoar 用独立
  `secrets.enc.json`，与 `providers.json` 解耦。

## 3. 权威实践对照

- [Electron safeStorage 文档](https://www.electronjs.org/docs/latest/api/safe-storage)：官方推荐的 OS 级加密存储，`isEncryptionAvailable()` 需判断；
  社区迁移实践见 [Migrate API keys to Electron safeStorage](https://github.com/daintreehq/daintree/issues/376) 与
  [electron safe-storage 指南](https://github.com/hairyf/skills/blob/HEAD/skills/electron/references/develop-safe-storage.md)。
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) /
  [OWASP SAMM：Secret Management](https://owaspsamm.org/model/implementation/secure-deployment/stream-b/)：
  最小暴露、加密静态存储、密钥生命周期（创建/轮换/撤销/清理）、日志禁止出现秘密。
- 对应落地：① 最小暴露 → 渲染层只见掩码；② 静态加密 → safeStorage/AES-GCM；③ 生命周期 → 清除密钥 / 删除供应商级联清理；
  ④ 日志纪律 → 审计不记录 payload。

## 4. 运维/data 布局

```
<dataDir>/config/
  providers.json        供应商配置（非机密：provider/baseUrl/model）
  secrets.enc.json      { items: { [providerId]: { cipher, hint, updatedAt } } }  ← 密文
  .secret.key           仅降级模式生成（0600）
```

## 5. 已知边界

- 系统密钥库在无桌面会话/容器里可能不可用 → 自动降级 AES，并在「高级 · 诊断」里显示 `secretStorageMode`；
- 密钥一旦泄露只能通过重新输入覆盖（无轮换 UI 之前），计划补齐「轮换/过期」提示；
- 扩展/MCP 子进程**拿不到**父进程环境里的密钥（MCP 环境变量白名单，扩展后续同理）。

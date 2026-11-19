# 扩展贡献点（contributes）API

> 适用版本：0.1.0 后（第三阶段 C 切片）。清单文件：`<dataDir>/extensions/<dir>/loopsoar.extension.json`。
> 原则：**贡献点一律是数据，不执行扩展代码**。需要跑代码的能力仍走扩展 worker 的工具桥接（带权限交集与沙箱确认）。

## 1. 支持的类型

| 贡献点 | 作用 | 边界 |
| --- | --- | --- |
| `commands` | Composer 斜杠命令（只把 prompt 填进输入框） | id 字母数字 . _ - |
| `instructions` | 启用后注入 volatile 段的系统指令 | ≤4,000 字符 |
| `ui` | 设置页只读文本/键值面板 | 不接受 HTML/JS |
| `hooks` | `turn.start` 每轮注入提示词 | 仅声明式 |
| `loops` | 注册进 LoopRegistry 的 L2 声明式 loop | 只能收紧预算；与内置同样受回退约束 |
| `themes` | 覆盖白名单 CSS 变量 | 只接受 hex / rgb() / hsl()，不接受 `var()`/`url()`/分号 |

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

## 4. 生命周期

1. 安装：把目录放进 `<dataDir>/extensions/<dir>/`，或用设置页「打开扩展目录」；
2. 启用：设置·扩展开关 → `extensions:setEnabled` → `ExtensionHost.onChange` → `ExtensionContributions.sync()`；
3. 生效：loop 立即出现在设置·通用·Loop 列表；theme 立即出现在外观下拉；
4. 停用/卸载：先撤 loop（必要时回退 builtin），theme 从列表消失；UI 若仍选中该主题，自动回落到 soft。

## 5. 校验与失败

- 清单由契约层 `ExtensionManifestSchema` 校验；任何非法贡献（坏 id、越界预算、非白名单 token、CSS 注入值）→ **整个清单解析失败**，扩展被跳过并在设置页显示跳过原因（fail-closed）。
- 贡献 id 冲突（重复）不会静默覆盖：进入 `contributions.conflicts`，设置页红字展示。
- 扩展 worker（`main`）仍受权限交集、超时、崩溃退避约束；贡献点不改变这些规则。

## 6. 示例

- `examples/extensions/loop-theme-demo/`：loops + themes，纯声明式（无 main）。
- `examples/extensions/prompt-commands/`：commands / instructions / hooks。

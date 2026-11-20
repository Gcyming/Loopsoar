# Loopsoar 品牌资产（来源：官方 app 图标）

> **产品名：Loopsoar**（仓库/包名/appId/userData/protocol 均用 Loopsoar）。
> 图标来自 `D:\tool\AI\real-project\Loopsoar\app icon\` 的官方应用图标：
> 黑色圆角底 + 米白 `Lp` 连字 + 右上橙色火花。主色约为
> 墨黑 `#0A0A0A` / 米白 `#FCF7F1` / 橙 `#FA9C38`；界面文字仍沿用现有
> `loop`（亚麻白）+ `soar`（赭石）的深浅色分配。

## 文件

| 文件 | 用途 | 来源 |
|---|---|---|
| `packages/shell/resources/icon.png` | Electron 窗口图标（512×512） | `app icon/icon-512.png` |
| `packages/shell/resources/icon.ico` | Windows 多档图标（16–256，打包/安装器用） | 由 `app icon/icon-1024.png` 生成 |
| `packages/ui/public/logo.png` | 界面内 logo（标题栏/欢迎页/加载态） | `app icon/icon-512.png` |
| `packages/ui/public/favicon.ico` | 渲染层 favicon | `app icon/favicon.ico` |
| `packages/ui/public/icon-32.png` | favicon PNG（32） | `app icon/icon-32.png` |
| `packages/ui/public/icon-192.png` | PWA/快捷方式图标（192） | `app icon/icon-192.png` |
| `packages/ui/public/apple-touch-icon.png` | Apple touch icon | `app icon/apple-touch-icon.png` |

## 铁律

1. **禁止引用 `_old-slime-icons/`**——那是旧项目（pilot project / slime）的图标，属于隔离对象；
   本仓库资产只能来自 Loopsoar 自己的品牌目录或上述官方资产。
2. 品牌资产只放在本仓库的两个固定目录（`packages/shell/resources`、`packages/ui/public`），
   守卫测试 `tests/guards/project-isolation.spec.ts` 会检查存在性。
3. 更换图标时同步更新本 README 的来源行；不要从其他项目拷贝覆盖。

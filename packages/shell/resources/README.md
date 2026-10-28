# Loopsoar 品牌资产（来源：前期准备官方资产）

> **产品名：Loopsoar**（仓库/包名/appId/userData/protocol 均用 Loopsoar）。
> 图标沿用 `D:\tool\AI\real-project\Loopsoar\前期准备工作\brand\quilt-inf\` 的官方设计
> 「破环·化片（Break the Loop · Shards）」——深墨 `#111318` / 亚麻白 `#F4EFE6` / 赭石 `#C8763C`，
> ∞ 居中、线宽周期收细、右下环断裂化为布片。

## 文件

| 文件 | 用途 | 来源 |
|---|---|---|
| `packages/shell/resources/icon.png` | Electron 窗口图标（256×256） | `quilt-inf/fin-256.png` |
| `packages/shell/resources/icon.ico` | Windows 多档图标（打包/安装器用） | `quilt-inf/quilt-icon.ico` |
| `packages/ui/public/logo.png` | 界面内 logo（顶部栏） | `quilt-inf/fin-256.png` |
| `packages/ui/public/logo-mono-dark.png` | 单色深底变体（后续标题栏/托盘） | `quilt-inf/fin-mono-dark-256.png` |

## 铁律

1. **禁止引用 `_old-slime-icons/`**——那是旧项目（pilot project / slime）的图标，属于隔离对象；
   本仓库资产只能来自 Loopsoar 自己的品牌目录或上述官方资产。
2. 品牌资产只放在本仓库的两个固定目录（`packages/shell/resources`、`packages/ui/public`），
   守卫测试 `tests/guards/project-isolation.spec.ts` 会检查存在性。
3. 更换图标时同步更新本 README 的来源行；不要从其他项目拷贝覆盖。

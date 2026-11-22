# Loopsoar 0.0.2 内测发布说明

> **内测构建，未公开发布，未做代码签名。** 0.0.x 均按内测处理，不构成稳定版承诺。
> 发布通道：GitHub Releases（手动下载安装；自动更新入口已内置，暂不作为正式更新通道）。

- 版本：0.0.2
- 平台：Windows 10/11 x64（NSIS 安装包 + 免安装 zip）
- 构建：Node 24 / Electron 45.0.0 / Chromium 依 Electron 版本
- 代码签名：无（Windows 会提示「未知发布者」，属预期；签名准备计划到 v0.0.8）

## 1. 安装包

| 文件 | 用途 |
|---|---|
| Loopsoar-Setup-0.0.2.exe | NSIS 安装包，按用户安装（无需管理员），可选安装目录 |
| Loopsoar-0.0.2-win-x64.zip | 免安装版，解压后运行 Loopsoar.exe |
| SHA256SUMS.txt | 安装包/压缩包校验值 |
| latest.yml / *.blockmap | 更新元数据（随 Release 上传，暂不作为正式自动更新通道） |

安装/解压后首次启动会创建数据目录 `%APPDATA%\loopsoar`。卸载默认保留该目录。

安装向导保留「安装选项」页：
- 创建桌面快捷方式（默认勾选）；
- 开机自动启动 Loopsoar（默认不勾选，写入当前用户 Run 项，卸载时清理）。

卸载向导保留数据处理选择：默认**保留**用户数据；勾选「删除用户数据」才会清理
`%APPDATA%\loopsoar` 与 `%LOCALAPPDATA%\loopsoar`（不可恢复）。

## 2. 本版修复

### 2.1 供应商无法添加 / IPC `too_big`

- `ProviderModelSchema` 的 `maxOutput` / `contextWindow` 上限从 **1,000,000** 放宽到 **10,000,000**，
  兼容上游常见的 **1,048,576** 等二进制百万值。
- 供应商模型表改为直接填写**实际 token 数**，不再按 K 做 `× 1000` 换算；表头改为
  「上下文（tokens）/ 输出（tokens）」，并显示单位提示。
- 保存前进行本地校验，超限时显示具体模型和字段，而不是把裸 IPC 校验错误抛给用户。
- 已实测：编辑供应商模型，输出 tokens 填 `1,048,576`，保存并设为活跃成功。

### 2.2 安装到受限目录后启动失败

- 安装器在写入前检查目标目录：
  - 带 Windows **Low Mandatory Level** 完整性标签；
  - 带 `Everyone` DENY ACL；
  - 不可写。
- 命中时拒绝安装并提示改用默认的当前用户目录；静默安装返回非 0，不再出现
  「安装成功但 Chromium 子进程无法启动」。
- 免安装 zip 仍必须解压到普通可写目录。

### 2.3 安装器许可页版本

- 许可页标题注入实际软件版本（`Loopsoar 0.0.2 内测许可协议`）；
- 协议自身版本单独标为「协议版本 1.1」，避免把协议版本误读成应用版本。

### 2.4 构建/发布链路

- 修复项目容器继承 `Low Mandatory Level` + `Everyone` DENY 时，从 `release/dist` 启动
  NSIS 报 `Error writing temporary file` 的问题；这是本机构建环境问题，不改变安装包行为。
- 构建中间目录继续放在系统临时目录；`release/dist` 只保留交付件。
- 新增/更新代码签名准备文档：`docs/releases/代码签名准备-v0.0.8.md`（v0.0.2–0.0.7 不签名）。

### 2.5 试用体验修复

- **模型列表刷新**：供应商保存/切换后主动刷新跨供应商模型清单；并发刷新改为“尾部合并”，
  不再因为前一次加载未结束就丢弃后到的刷新。打开模型菜单时保留旧列表并后台刷新，
  避免先闪空白。列表只读取密钥状态，不再为每个供应商解密完整 API Key。
- **移除「完成」提示**：正常回复结束不再弹提示；只有用户主动停止时提示「已停止」，
  错误/中断仍按原有错误路径显示。
- **Office 文档应用内打开**：拖入 Office/PDF 时由主窗口/浏览器页 preload 截获 `file://` 导航或下载事件，
  主进程优先调用本机 Microsoft Office（Word/PowerPoint/Excel）只读导出 PDF，LibreOffice headless 作为兜底，
  再在新建的应用内标签页用 Chromium PDF 查看器显示；打开失败会显示可读错误，
  不再出现系统「另存为」对话框或纯白窗口。支持 `.doc/.docx/.xls/.xlsx/.ppt/.pptx`
  及同类 OOXML/OpenDocument/RTF/CSV/PDF 扩展名，单文件上限 120MB。

### 2.6 Office 预览错位与首次打开慢

- **错位根因**：此前所有 Office 文件统一走 LibreOffice headless 转 PDF；LibreOffice 对复杂 PPT/Word 的
  文本框、图片锚点、公式位置存在偏移。现在优先使用本机 Microsoft Office 的原生导出（PowerPoint/Word/Excel），
  使用与源文件相同的排版引擎，导出前禁用宏、只读打开、不修改源文件。
- **安全保护**：若用户已经打开同款 Office 应用，不再通过 COM 附着/退出该实例，直接回退 LibreOffice，
  避免预览过程关掉用户正在编辑的窗口；PowerPoint 导出后清理遗留的 COM 进程。
- **缓存失效**：缓存版本提升为 `office-pdf-v3`，key 加入文件 `ctimeMs`，旧的错位/无网格线 PDF 不再命中。
- **首次打开反馈**：拖入 Office 文档后 500ms 内先创建同一标签页的转换加载页（“正在准备…”），
  转换期间显示提示（首次通常 5–15 秒），完成后在原标签替换为 PDF；不再出现“无响应”的空白等待。
- **启动优化**：应用启动时非阻塞预热 LibreOffice 兜底环境；本机 Office 原生导出路径没有 profile 初始化开销。
- **Excel 表格预览**：Excel 默认不打印网格线，之前 `.xlsx` 预览可能只看到文字、看不到表格边界。
  原生 Excel 导出前对每个工作表开启 `PrintGridlines`；小表（≤20 列、≤60 行）缩放到一页并水平居中，
  预览时能直接看到完整表格。该设置只作用于导出的 PDF，不修改源文件。
- OpenDocument/PDF 及无本机 Office 的环境仍走 LibreOffice；单文件上限保持 120MB。

### 2.7 使用中突然无渲染内容（黑屏/空白窗口）

- **复现与根因**：主进程仍存活、Agent 回合也仍在主进程执行，但主窗口的
  `render-process-gone` 事件显示 `loopsoar://app/index.html?` 的渲染器已 `crashed`
  （`exitCode: -1`）。此前主进程只把该事件写入 `crash.log`，没有恢复动作；
  Electron 保留了一个已隐藏/无渲染内容的 BrowserWindow 外壳，于是用户看到整窗空白或纯黑。
  这不是 Office 预览或数据损坏，而是**界面渲染进程退出后缺少自愈**。
- **触发背景**：故障前该会话是 23 万 token、17 次工具调用的长回合；同时窗口拖拽期间
  `browser:setSidebarWidth` 以约 60 次/秒持续触发原生视图 `setBounds`。两者叠加会放大
  Chromium 渲染/GPU 压力；无论具体触发点是长回合还是显卡驱动，渲染器退出后都不应留下黑屏。
- **降低触发压力**：侧栏拖拽期间原生网页视图本来就被 overlay 隐藏，UI 现在不再每帧发送
  `setSidebarWidth`，只在松开时落位一次，避免无意义的 60 次/秒主进程布局。
- **自愈机制**：新增 `packages/shell/src/main/rendererRecovery.ts`。主窗口渲染器
  `render-process-gone` 后，若崩溃前窗口可见则立即 `show()`；用崩溃前 URL 重新导航，
  250ms 后首次重试、后续 1s 重试，最多自动重试 3 次；第 4 次仍崩溃则显示带
  「重新加载 Loopsoar」的静态错误页，而不是无限黑屏。`unresponsive` 超过 10 秒也会受控 reload。
- **不打断后台任务**：恢复只重载 UI renderer，不重建主进程、不取消 Agent 回合和工具执行；
  会话历史仍从本机存储恢复。隐藏到托盘时崩溃不会被强行弹窗，用户再次显示窗口时会做
  一次进程存活探测并恢复内容。
- **验证**：final17 构建中主动终止主窗口及辅助 renderer（模拟 3 个进程同时崩溃），
  主窗口自动重新显示并回到正常欢迎界面；连续 4 次崩溃才进入可操作的错误页。

## 3. 数据、备份与回滚

- 数据目录：`%APPDATA%\loopsoar`（设置 → 关于/诊断 可查看完整路径）。
- **升级前自动备份**：启动时若发现版本号变化，会把用户数据复制到
  `%APPDATA%\loopsoar\backups\pre-<旧版本>-<时间戳>\`（排除浏览器缓存、日志、traces；
  单文件超过 64MB 跳过）。
- 手动备份：设置 → 关于 →「导出数据备份」，或关闭应用后复制整个数据目录。
- 回滚：卸载当前版本 → 安装旧版本 → 如需还原数据，把对应 backups 目录内容覆盖回数据目录。
  0.0.1 ↔ 0.0.2 的升级/回滚演练见 `docs/releases/UPGRADE-DRILL.md`。

## 4. 已知问题

1. **未签名**：SmartScreen 会拦截，需「更多信息 → 仍要运行」。签名准备推迟到 v0.0.8 前。
2. **自动更新尚未正式启用**：入口与 `latest.yml` 已就绪，但本版未签名，先手动覆盖安装；
   覆盖安装不会删除数据，更新前也会自动备份。
3. **可选向量后端随包但默认不启用**：better-sqlite3 / sqlite-vec 已随包，
   默认仍是 flat 后端；设置 → 通用 →「记忆向量后端」可切换（重启后生效，失败自动回退 flat）。
4. **干净机器验收范围**：Windows 11 x64、非管理员账户、中文/含空格安装路径已验证；
   Windows 10 x64 尚未实机验证。
5. **代码签名 / 更新包签名校验 / 灰度**：按当前计划，v0.0.8 前开始准备；0.0.2–0.0.7 内测不签名。

## 5. 验证摘要

- `pnpm -r typecheck`：通过。
- `npx vitest run`：306 个测试文件、2222 个用例通过。
- `pnpm package:win`：生成 NSIS 安装包与免安装 zip。
- 全新安装到 `D:\Loopsoar`：静默安装退出码 `0`，安装版版本 `0.0.2.0`。
- 0.0.1 → 0.0.2 覆盖安装：退出码 `0`；首次启动生成
  `backups\pre-0.0.1-<时间戳>`，`version.json` 更新为 `0.0.2`。
- 打包版 E2E：启动、供应商编辑保存并设为活跃、诊断导出、备份导出、终端功能通过。
- Office 预览 E2E：拖入 `第五章 基带数字信号的表示和传输.ppt` 后约 500ms 出现同标签转换加载页，
  约 9–13s 后替换为原生 Office 导出的 PDF；标签标题为文档名，PDF 查看器正常渲染，主窗口没有出现系统「另存为」或白页。
  同一构建下 `实验2.doc` 约 8.6s、`_a1136-test.xlsx` 约 6.1s 完成；三者转换后均无残留 Office 进程。
- PPT/Word/Excel 原生导出 PDF 页面抽查：文字、图片、表格、图注无错位/重叠/裁切。
- Excel 预览：拖入 `_a1136-test.xlsx` 后自动显示 5 列 × 5 行表格，`PrintGridlines` 网格线可见；
  “金额”列在源文件中本身为空，不是渲染丢失。
- 空白窗口自愈：final17 中主动终止主窗口 renderer 后，主窗口自动恢复显示并渲染欢迎界面；
  渲染器连续崩溃超过阈值时显示错误页，主进程与 Agent 回合不中断。
- 受限目录（Low Mandatory Level）静默安装：退出码 `2`，未写入文件。

## 6. 交付校验值

| 文件 | SHA-256 |
|---|---|
| Loopsoar-Setup-0.0.2.exe | `2407be40a5d545bf98f1d364b52a5f92aab86e3f01a861e7e54c25b872b7d01d` |
| Loopsoar-0.0.2-win-x64.zip | `556abedd9988e7f61561854dab071bbaaef05031b597672b7635fb8cb01e5e3b` |

以 `release/dist/SHA256SUMS.txt` 为准。

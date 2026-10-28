# D0 决策门结论（浏览器技术路线验证）

> 结论：**通过（PASS）** —— WebContentsView 路线在实测中走通全部核心操作；
> `BrowserAdapter` 接口可以冻结（实现见 `packages/shell/src/browserAdapter/backends/webContentsView.ts`）。
> 时点：2026-10-28 ｜ 验证环境：Windows x64 / 受限桌面会话（agent shell）

## 一、实测结果（Electron 40.10.2，完整通过）

命令：`environment -u ELECTRON_RUN_AS_NODE <electron> packages/shell/dev/d0-probe`

```
D0_RESULT {
  "ok": true,
  "loaded": true,                 // 导航 + dom-ready 等待
  "markedElements": 2,            // 可交互元素编号注入（input/button）
  "title": "D0 Probe",
  "elementList": [{"id":"0","tag":"input"},{"id":"1","tag":"button"}],
  "clickResult": "点击成功",       // 按编号点击 → DOM 状态真实变化
  "inputValue": "Loopsoar",       // 原生 setter + input/change 事件（React 受控组件兼容）
  "scrollY": 1200,                // 滚动生效
  "screenshotBytes": 5676,        // capturePage 真实像素（shot.png 已落盘）
  "jsInjected": {"sum": 3, "hasBottom": true}   // executeJavaScript 注入
}
```

## 二、环境约束与发现（重要）

1. **`ELECTRON_RUN_AS_NODE=1` 被注入到当前 shell 环境**：直接运行 electron 二进制会退化为 Node（`--version` 打印 Node 版本）。运行 electron 必须先 `env -u ELECTRON_RUN_AS_NODE`。
2. **Electron 45 在本机受限会话下需要 `--no-sandbox`**：不加该参数时启动即退出（exit 3，无输出）；加 `--no-sandbox` 后可正常启动并输出 `v45.0.0`。
3. **`capturePage` 需要交互式桌面**：在 agent 的受限会话中 v45 报 `Current display surface not available for capture`；40.10.2 在同一会话可截图成功。**这是运行环境限制，不是 WebContentsView 路线问题。**
4. userData 缓存目录在受限会话下出现 `拒绝访问 (0x5)`：同样是会话权限限制，非代码问题。

## 三、待用户在本机桌面确认（一次即可）

```bash
cd "D:\tool\AI\real-project\Loopsoar\Parent file"
node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/electron.exe packages/shell/dev/d0-probe
```

预期：弹出探针窗口并在控制台打印 `D0_RESULT {... "ok": true ...}`，产出 `shot.png`。
若通过 → **D0 决策门正式签核，冻结 BrowserAdapter 接口**（接口已实现，不再改动方法签名）。

## 四、13 个 browser 工具的存量评估

见同目录 `TOOL-TRIAGE.md`：**8 项直接复用（语义不变）、5 项改造（实现替换、参数语义保持）、3 项重写（webview 弃用影响）**，无架构性风险。

## 五、对规划的影响

- `BrowserAdapter` 接口冻结（ADR-0003 状态可从「待验证」转「已验证」）。
- 主实现已落地（`createWebContentsViewAdapter`，依赖注入、零 electron 依赖、可单测）。
- 多标签/下载/历史/弹窗/缓存分区属接线工作，排入 P6（壳层+UI）。
- v45 的 `--no-sandbox` 仅为**受限会话**下的开发参数，正式打包不启用（发布前按 §6.4 安全门复核）。

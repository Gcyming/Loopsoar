# Loopsoar 隐私说明（内测版 0.0.x）

本文件说明 Loopsoar 在运行过程中会产生、保存与发送哪些数据。内测版本默认**不包含任何遥测或
使用统计上报**；除非你主动配置并触发，应用不会向 Loopsoar 项目方发送数据。

## 1. 数据保存在哪里

默认数据目录（Windows）：

    %APPDATA%\loopsoar

可用环境变量 LOOPSOAR_DATA_DIR 覆盖。目录内主要包含：

| 内容 | 位置 | 说明 |
|---|---|---|
| 配置与偏好 | config/ | 语言、主题、工作区、供应商配置等 |
| API Key | config/secrets.enc.json + config/.secret.key | 见第 3 节 |
| 会话记录 | sessions/ | 对话正文、工具调用与结果摘要 |
| 记忆库 | memory/（可在设置里改路径） | Markdown 笔记 + 索引缓存 |
| 规则 | config/rules/、工作区 AGENTS.md | 用户规则与守卫 |
| 扩展 / 技能 | extensions/、skills/ | 本地安装的扩展与技能 |
| 浏览器状态 | browser-state.json、browser-history.json | 标签、历史（上限受控） |
| 审计日志 | logs/audit-YYYYMMDD.jsonl | 受信 IPC 的通道/结果，不含工具参数 |
| 崩溃日志 | crash.log（>2MB 轮转一次） | 未捕获异常、渲染进程/子进程退出 |
| 升级备份 | backups/pre-<旧版本>-<时间戳>/ | 版本变化时自动创建，排除缓存与日志 |

卸载应用默认**保留**上述数据目录；如需彻底删除，请手动删除 %APPDATA%\loopsoar。

## 2. 会发送到外部的数据

Loopsoar 本身不运营中转服务。当你在设置中配置模型供应商后：

- **对话与工具参数**：你输入的提示词、附件文本、工具调用参数会发送给你选择的供应商；
- **网页内容**：Agent 读取页面、截图或执行页面脚本时，页面文本/截图可能作为工具结果发送给供应商；
- **图片/文档**：你附加的图片、PDF、Office 文档在被工具读取后，内容可能随请求发送。

发送目标由你配置的 base URL 决定。请自行阅读对应供应商的隐私政策；不要在内测阶段输入真实
敏感数据（密钥、身份证号、客户资料等）。

以下功能只在本机执行、默认不联网：记忆检索（flat 向量）、规则守卫、文件/终端工具、
浏览器自动化、定时任务调度。扩展（extensions/）与 MCP Server 可能自行联网，行为由第三方代码决定。

## 3. API Key 的保存方式

- 首选 Electron safeStorage（Windows 上由 DPAPI 保护）加密后写入 config/secrets.enc.json；
- 同时写入一份 AES-256-GCM 备用密文，密钥文件为 config/.secret.key（与密文同目录）；
  这样在系统密钥库临时不可用时仍能解密，代价是：**能读取该数据目录的人可以解密 Key**；
- Key 不会写入日志（crash.log 与诊断输出经过脱敏），不会上传到 Loopsoar 项目方；
- 你可以在设置里清除某个供应商的 Key，或直接删除上述文件。

## 4. 崩溃与诊断

- 崩溃信息只写入本地 crash.log，包含时间、版本、Electron/Node 版本、平台与异常摘要；
- 应用**不会自动上传**崩溃日志。反馈问题时由你自行决定是否提供该文件；
- 日志脱敏：字段名命中 apiKey/token/secret/password/authorization/cookie 时整值替换为
  [redacted]；字符串中的 sk-…、Bearer …、apiKey=… 形态也会被替换。

## 5. 浏览器数据

内置浏览器使用独立分区（persist:loopsoar-browser），Cookie/缓存与系统浏览器隔离，
存放于数据目录的 Partitions/ 下。清理数据目录即清除这部分数据。

## 6. 数据删除

1. 设置 → 关于/诊断 可查看当前数据目录路径；
2. 关闭应用后删除 %APPDATA%\loopsoar 即删除全部本地数据；
3. 升级备份位于 backups/，删除该子目录即可清理历史备份。

## 7. 变更

内测阶段本说明可能随版本更新。重要变更会写入对应版本的发布说明。

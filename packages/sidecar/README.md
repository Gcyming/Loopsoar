# loopsoar-sidecar — 二进制侧车装配（P9 实现）

> 说明：llama-server 等推理/嵌入二进制侧车的打包装配（打包、分层、更新、卸载、安装验证）。
> 当前为占位清单，P9 阶段由对应子代理完成，内容包括但不限于：

- llm-server 打包（llama.cpp / llama-server 系列，CUDA/CPU 双后端随包）
- 嵌入（BGE-M3 / sqlite-vec 或 LanceDB 后端）二进制打包
- 安装分层：主包（CPU 运行时）+ CUDA 增补包（代码去装）
- 版本回归与 sha256 校验（供应链签名）
- 侧车生命周期：spawn / 监控 / 重启 / 清理
- 卸载 / 更新 / 崩溃自愈

---

## 负责人

S1（本目录占位），P9 实现由对应工程阶段执行。

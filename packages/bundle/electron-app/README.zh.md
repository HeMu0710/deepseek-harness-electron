# `@deepseek-ai/dsh-electron-app`

[English](README.md) | 中文

Electron 表层组合包。[`cordis.patch.yml`](cordis.patch.yml) 位于 [`dsh-base`](../base/README.md) 和 [`dsh-gui-app`](../gui-app/README.md) 之后，并把 Host 目录选择器及其客户端表层固定为操作系统原生交互。Web 启动、`webServer`、Web 运行时粘合逻辑和客户端 HMR 并非禁用的占位配置项：它们只属于 [`dsh-web-app`](../web-app/README.md)，从不进入桌面组合。由此得到的依赖闭包会保留共享 modules、connection、API 和 UI roster，同时不携带 Web 服务器或前端资源服务包。

本包是静态表层 patch，没有运行时 API。Electron 应用拥有 renderer 资源加载、IPC 载体、窗口生命周期和打包后运行时位置；这些进程职责不会成为本组合包中的 Cordis 配置项。

## 模型体验

无影响，因为该表层组合包只选择原生目录交互，不添加提示词、消息、工具 schema 或模型可见结果。

#### KV Cache 影响

无影响；该表层不会改变任何已组装的模型请求。

## 已知限制和延后工作

- **必须遵守层顺序**：若未组合 `gui-app` 就应用本组合包，只会安装原生目录交互，并缺少 Host／API／客户端 roster。
- **Electron 应用必须提供载体**：本 patch 刻意不包含 HTTP 回退；只有应用把共享 connection 和模块清单绑定到 IPC 与 renderer 资源载体后，启动才可用。

# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness 的零端口 Electron 应用。它复用构建后的 Web 外壳和共享 GUI profile，但所有 API、通用 RPC 与事件流流量均通过隔离的 preload bridge 传输，而不使用 HTTP 或 WebSocket。

运行 `pnpm desktop`。该命令依次运行根目录的 `build:lib`、`build:web` 和桌面包构建，之后才启动 Electron，避免复用过期 renderer 产物。在 macOS 上运行 `pnpm package:mac` 可生成当前原生架构的 `.app` 与 ZIP；[macOS 打包教程](../../docs/cookbook/packaging-macos-app.md)涵盖本地构建、签名与公证。桌面 profile 初始化为 `dsh-base` + `dsh-gui-app` + `dsh-electron-app`；它与各 CLI 对外界面共用同一套 `$DSH_HOME` 设置、凭据、会话、workspace 和 agent preset。

主进程在 ESM 求值期间注册私有 scheme，把其余启动工作调度到 Electron ready 之后，并且仅通过标准安全的 `dsh://app` scheme 提供构建后的外壳，以及 Host inventory 发布的确切客户端 bundle。renderer 使用 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、绑定 nonce 的内容安全策略（Content Security Policy），并拒绝权限和阻止导航；preload 只公开 `fetch`、`pull`、`cancel`、`saveDownload` 与不可变的应用元数据。Harness Host 在 Electron utility process 中运行。它的 Cordis HMR 服务使用 `root: []`，因此 profile 与 home patch 文件仍会持续生效，但模块 HMR 保持禁用；打包后的 Host 不依赖 Electron 转发 `--expose-internals`。API 与 SSE（Server-Sent Events）响应体每次通过 IPC 传输一个主动拉取的分片。会话导出由主进程取得操作系统批准的路径，再由 utility Host 把 ZIP 直接流式写入临时文件后替换目标文件；该路径不会进入 renderer 代码。取消操作会中止 Host Request、取消其 reader，并等待清理完成。

退出时，utility Host 会停止接收新工作，取消并等待 active handler 结算，随后 dispose profile，确认清理完成并自然退出。profile disposal 会在确认之前释放 `$DSH_HOME/.host.lock`。main 进程为正常清理与自然退出提供两秒时间；只有 Host 错过该期限时才会将其 kill，之后再以独立的有界等待确认进程已经终止。到达正常退出期限时仍没有清理确认、强制终止前退出码非零或 kill 后仍未退出，都会使桌面应用以失败状态退出。

## 已知限制与暂缓事项

- **macOS 包以构建主机的架构为目标**：`pnpm package:mac` 会生成供本地使用的 ad-hoc 签名 `.app` 与 ZIP；配置 Apple 凭据后则生成经 Developer ID 签名和公证的产物。Universal 构建、DMG 安装包、Windows 包、自动更新与产品图标仍属于发布工作。
- **严格 CSP 下不支持运行时安装的 Client half**：`cordis-client-runner` 使用 `new Function` 求值其源码字符串，而 renderer 禁止字符串代码生成。随附静态 Client 图和运行时安装的 Host half 会继续工作。若要支持动态 Client 代码，需要不依赖字符串代码生成的交付路径；桌面应用不会加入 `unsafe-eval`。
- **Electron 必须保留 RunAsNode**：Windows ACL 沙箱、持久终端与原生目录选择器通过 `process.execPath` 启动 JavaScript helper。它们只为外层 helper 启用 Node 模式，ACL runner 会在启动用户命令前移除该值。打包后的构建必须保留此 fuse，或先引入共享 Node launcher。
- **同一时间只能有一个 Host 进程使用某个 Harness home**：profile 启动会强制获取 `$DSH_HOME/.host.lock`，因此使用同一 home 的 Web、CLI 或桌面 Host 并发启动时会失败，而不会让 Session 或 Storage 写入发生竞争。如需有意并发，请使用不同的 home。进程非正常退出后，必须先确认没有 Host 正在使用该 home，再删除遗留锁文件。
- **仅支持一个窗口**：IPC 请求所有权和发送方验证有意绑定到单个应用窗口。

## 模型体验

间接影响：应用挂载共享 GUI profile，模型可见行为全部由该 profile 的子插件负责。

#### KV Cache 影响

无直接影响。

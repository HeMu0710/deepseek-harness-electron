# Agent Note: 采用零端口 utility Host 的 Electron IPC 桌面应用

Status: implemented

[English](2026-08-14-electron-ipc-desktop-application.md) | 中文

## Problem

GUI 过去只能作为浏览器应用部署。共享的 Client 包和通道无关 RPC 协议已经为 Electron 载体保留位置，但随附组合仍把完整 GUI roster 与 Web 启动、HTTP／WebSocket 服务、浏览器信任配置及 Web 专属模块交付耦合在一起。在 Electron 内复用该组合，要么打开一个不必要的回环端口，要么保留一整套被禁用的 Web 依赖闭包及桌面应用并不需要承担的生命周期与安全义务。

Electron 也带来不同的信任与进程模型。renderer 不得继承 Node.js 权限或通用 `ipcRenderer`；Harness Host 仍须能够加载 Node 插件和原生提供方；流式响应不得经 structured clone 让快速 Host 压垮 renderer；打包后的资源解析也不能依赖 `file://` 路径或开发 checkout 的目录布局。因此桌面壳必须明确持有 renderer 资源、Host 生命周期、IPC 请求归属和后续打包。

## Decision

桌面产品是 `apps/electron`（`@deepseek-ai/dsh-desktop`）。它实现了 [GUI 分层与 RPC 协议决策](2026-07-19-gui-layering-and-rpc-protocol.md)中的 Electron 保留位，而不引入第二套应用协议。应用包含三个独立构建的入口：ESM main 进程、ESM utility Host 和 CommonJS preload。renderer 继续运行已构建的 `dsh-web-frontend` 壳及普通 Client 插件图。

### GUI 组合与 renderer 资源

GUI 组合包含三个有序层。`@deepseek-ai/dsh-base` 持有 core 进程配置项；`@deepseek-ai/dsh-gui-app` 持有与传输无关的 Host 服务、API 和模块清单、Agent Presets，以及共享 Client／UI roster；其后恰好跟随一个表层。`@deepseek-ai/dsh-web-app` 持有 Web 启动、`webServer`、Web 运行时粘合逻辑、客户端 HMR、浏览器连接信任和自适应目录交互。`@deepseek-ai/dsh-electron-app` 则固定使用既有的原生 Host 目录选择器及其 Client 交互，不包含任何上述 Web 配置项。这扩展了 [profile 组合包决策](2026-08-05-profile-plugin-bundles.md)：随附 Web profile 组合 `base + gui-app + web-app`，桌面 profile 则组合 `base + gui-app + electron-app`。

`dsh-client-modules` 的 Host 面是不依赖任何载体的清单。它始终扫描已挂载的 Loader 树、组合启动图、暴露每个图配置项的已构建 bundle 路径，并发布图变更通知。其 Web 路由与 index manifest 适配器只在 `webServer` 存在时挂载。桌面 utility Host 读取同一张图和路径，再把 opaque 图及 pathname 到绝对路径的资源列表发送给 main 进程。这让 renderer 内的 [客户端插件加载模型](2026-07-23-client-plugin-loading-model.md)保持不变：Web 与 Electron 使用相同的插件 id、revision、依赖边、工厂和 Loader 生命周期。

main 进程在 ESM 求值期间把 `dsh` 注册为标准安全 scheme，再把其余启动工作调度到 Electron ready 之后，而不会暂停入口模块求值。它只服务一个应用 origin：`dsh://app`。scheme handler 使用与同一响应 CSP 匹配的逐响应 nonce，把 Host 编写的启动图注入已构建前端 index；它从解析出的前端 dist 服务 Vite 根相对资产，并且只从当前 Host 清单服务 `/plugins/...`。标准 origin 让既有的绝对资产和插件 URL 正常解析，也让 CSP、同源检查、Fetch URL 解析和代码缓存拥有 `file://` 无法提供的一致语义。

严格的桌面 CSP 不包含 `unsafe-eval`。因此 vendored Loader 会把 JavaScript 表达式 evaluator 保持在未初始化状态，直到真正插值某个 Loader 表达式：为静态 Client 配置项治理导入 Loader 时不会创建 `Function`，Node utility Host 则可在 Host 配置使用 `!!js` 时初始化 evaluator。这让普通静态 Client 图无需弱化 renderer 策略即可启动。

同一条 CSP 路径会在 boot manifest 与所有 Client bundle 之前运行经 nonce 授权的启动脚本，把 `globalThis.__zod_globalConfig.jitless = true`。Zod 在导入时读取该值，跳过 `new Function` 能力探测与 JIT 对象解析器路径，并通过 jitless 解析器执行普通 schema 校验，不会产生 CSP 违规。

### 进程与安全模型

main 进程是 renderer 和 utility Host 之间唯一的 broker。`BrowserWindow` 禁用 Node integration，启用 context isolation、sandbox、Web security 和严格的 Content Security Policy，拒绝权限检查与请求、拒绝 webview、阻止应用窗口导航到 `dsh://app` 之外，并且只通过操作系统打开 HTTP(S) 链接。每次 IPC 调用都必须来自唯一归属窗口和 `dsh://app` sender frame。

preload 暴露一个固定的 `window.__DSH_DESKTOP__` 对象：序列化的 `fetch`、一次一块的 `pull`、幂等 `cancel`、原生 `saveDownload` 和不可变桌面元数据。它不暴露 Electron 对象、任意 channel 名、文件系统访问、进程访问或选中的路径。main 进程在转发请求前校验请求 id、精确应用 origin、允许的方法、header 字段和共享的 `DEFAULT_MAX_REQUEST_BODY_BYTES` 上限；原生保存还会在打开操作系统对话框前只接受 Session 导出 URL 和安全的建议文件名。utility Host 会再次校验每条命令。Client Connection 在重建浏览器对象前校验响应 head 和 chunk。

设置 schema 的 rehydration 采用同一 renderer 规则。序列化 callback 源码会被替换为 identity transform，因此 Client 编辑器保留结构校验，却不会执行 callback 代码；每次写入仍由包含真实 callback 的 Host 权威 schema 校验。

运行时安装的 Client half 是静态 Client 加载的明确例外。`cordis-client-runner` 目前使用 `new Function` 求值其源码字符串，而桌面 CSP 禁止这种行为。随附静态 Client 图会继续运行，运行时安装的 Host half 也仍在 utility Host 中执行。若要支持动态 Client 代码，必须提供不依赖字符串代码生成的交付或求值机制，而不是加入 `unsafe-eval`。

utility 进程是可信 Node Host，不是操作系统安全 sandbox。它通过 `bootProfile` 启动普通 desktop profile、提供启动环境、以通常权限加载用户选择的 Host 插件，并持有 Cordis 应用 fiber。桌面应用以 `root: []` 使用 vendored HMR 服务：profile 与 home patch 的精确文件监视会持续运行，却不会读取 Loader 的内部模块 loader，模块 HMR 也保持禁用。因此，打包后的 utility process 不需要 `--expose-internals` 例外。renderer sandbox 和窄 preload 会限制 renderer 被攻破后的 Electron 权限，但不会让各 Client 插件彼此变成不可信代码，也不会限制用户主动安装的 Host 插件。

桌面请求只有通过 main 进程 sender 检查后才绕过 Web Host／Origin 信任栅栏。`HostConnectionHandle.fetch(Request)` 明确受到本地载体信任；它依次分发已登记的逻辑 channel、共享 `/api` interceptor 和 API Proxy fallback。可选 Web 适配器仍会在调用同一个 dispatcher 前应用浏览器 authority 策略。因此桌面不会伪装成回环浏览器，也不会削弱真实 HTTP／WebSocket 流量的[浏览器信任决策](2026-07-28-api-browser-trust-boundary.md)。

### 基于 pull 的 IPC Fetch 与 SSE

Client Connection 插件在请求 fixture 时优先选择 fixture，否则在固定的桌面 preload global 存在时选择它，最后才选择 Web 载体。桌面分支创建一个由 `DesktopApiClient` 和通用 Connection RPC 共享的 `createDesktopFetch` 函数。`DesktopApiClient` 只替换 `AbstractApiClient.doFetch`；请求 envelope、响应 schema、关联关系、传输错误处理和两条逻辑事件流仍使用同一协议。

一次桌面 fetch 在 renderer 生成的 opaque id 下序列化 URL、method、header 和有上限的 body。utility Host 重建本地 `Request` 并直接调用 `ctx.connection.fetch`，因此 unary RPC 与流都不会打开 socket。它先返回响应元数据，并保留响应体 reader。renderer 重建出的 `ReadableStream` 每次收到需求信号只发出一次 `pull(id)`；utility 只执行一次 reader read，并返回一个 chunk、end 或 error。因此既有 SSE decoder 能够以 renderer 驱动的背压在 IPC 上承载 `events.mux` 和 `events.host`，Web 载体则继续按 [WebSocket 载体决策](2026-08-04-websocket-downlink-carrier.md)使用 HTTP 上行与 WebSocket 下行。

桌面 IPC 适配器从 Client Connection 导入 `DEFAULT_MAX_REQUEST_BODY_BYTES`，目前执行与 Web bridge 相同的 160 MiB 上限。该上限覆盖默认 100 MiB 聚合图片额度经过 base64 扩张后的大小及 envelope 余量，避免不同载体的容量发生偏移。两种载体仍会完整缓冲每个请求体，Electron 还会把它作为一个 structured-clone 值传输；若要降低这部分驻留内存成本，需要流式请求路径或更小的图片额度配置。

Session 导出不会让 ZIP chunk 经过 renderer。main 进程从 Electron 保存对话框取得目标位置，并把这个已批准的绝对路径发送给 utility Host。Host 使用同一个本地 Connection dispatcher，把响应逐块写入权限模式为 0600 的同级临时文件，并且只在流成功后重命名到目标位置。取消和流错误会删除不完整文件，选中的路径不会进入 Client 代码。

`AbortSignal`、renderer stream cancellation、窗口 teardown 和应用 shutdown 会汇合到同一个请求 id。取消会移除远端归属、中止 utility 侧 `Request`、取消保留的 body reader，并安全结算重复取消。main 进程拒绝重复 id、并发 pull，以及一个 renderer 试图消费另一个 renderer 的响应。该逐请求 ledger 也是 utility Host 退出时让所有未完成调用失败的归属点。

### 应用生命周期

main 进程持有单实例锁，安装 scheme 与 IPC handler，启动 utility Host，并等待其 ready 图之后才创建和显示窗口。utility 后续把图变更发布给 main 进程，main 原子替换 scheme 资源映射。Host fatal error 会拒绝待处理 IPC，并把应用视图替换为失败诊断，避免留下看似已连接的壳。

包括 Web 和 Electron 在内的每个 profile Host，都会在挂载 Cordis 配置树之前通过 `bootProfile` 获取 `$DSH_HOME/.host.lock`。该锁由一项 deferred `withFileLock` operation 持有，其生命周期只能经返回的幂等 `dispose()` 结束：dispose 会先等待应用 fiber 完全停稳，再释放锁。启动失败也使用同一释放路径。这项进程级归属机制可阻止 JSONL Session 和 JSON Storage 后端并发写入同一个 Harness home。

正常退出会先把 utility Host 标记为 stopping，因此新的 fetch、save 与 pull 命令会被拒绝，而 cancel 仍可执行。shutdown 会取消全部 active 请求，等待所有进行中的 fetch、save、pull 与 cancel handler 结算，dispose profile boot 并释放 Home 锁，发送 `stopped` 确认，随后在下一个事件循环轮次自然退出。main 进程用同一段两秒正常退出期限等待确认与自然退出。如果已确认的 Host 到期仍未退出，main 会将其 kill，并另外等待两秒确认进程终止。Host 到期仍未确认时会被 kill；即使强制终止成功，应用也会失败。强制终止前出现非零退出码会失败，kill 后仍未退出也会失败。ready 前退出、启动 fatal event 与运行时 Host 故障都会汇合到同一个单飞 application-stop owner；它保留所请求的最高退出码，并且只在 Host shutdown 结算后调用 `app.exit`。关闭唯一窗口会取消该窗口的待处理请求。应用刻意只支持一个窗口，因此 sender 身份和请求归属不需要跨窗口路由策略。

### 打包状态

`apps/electron/package.json` 同时是应用 manifest 和桌面部署根目录。它的生产依赖会提供桌面组合可达的全部必需 workspace peer；按条件注入的主题集成把 WebServer 标为可选，因此该闭包不会重新引入 Web 载体。`pnpm package:mac` 会检查该依赖图、构建 Host 和 Client 产物，并按 frozen lockfile 把生产 workspace 包注入隔离且采用 hoisted 布局的 staging 目录，且不运行依赖的 lifecycle script。它会从所属 staged 包解析每项 dependency 与必需 peer，使用 plain Node 导入 main 与 Host 的外部根入口，验证前端 dist、桌面入口、随附 Agent Preset、Client bundle、worker、原生代码、libvips、`rg`、`spawn-helper` 与全部剩余符号链接，并拒绝会改动仓库安装元数据的 deploy。

`@electron/packager` 会以 `asar: false` 复制经过验证的 staging 根目录，并解引用其中包含的链接。因此桌面 install anchor、profile patch、动态 bundle 路径、原生代码与 helper 可执行文件均保持为普通且可搬移的文件系统资源，也不会保留 staging 路径。复制后的应用会在签名验证前再次执行生产入口导入与链接检查。默认产物使用供本机运行的 ad-hoc 签名；配置 Developer ID 身份与一套完整凭据策略后，同一命令会启用 hardened-runtime 签名与公证。

Host 还会通过 `process.execPath` 启动 Node helper。当前 Windows ACL sandbox、持久终端和原生目录选择器路径只会为外层 JavaScript helper 应用 `ELECTRON_RUN_AS_NODE=1`；ACL runner 会在启动调用方命令前删除它。当这些 helper 仍使用 Electron 可执行文件时，应用包会保留 Electron 的 RunAsNode fuse。由于 pnpm 会在 staging 期间选择特定架构的原生依赖，因此每个 macOS 架构都在匹配的主机上构建。Universal 应用、DMG 生成、产品图标、Windows 签名与 installer 以及更新交付仍属于显式发布工作。

## Verification

组合包测试从空 root 应用 patch，并固定两条受支持链路：desktop 保留共享 modules、Connection、API、UI 和 Agent Preset 配置项，同时不包含 `web-startup`、`webserver`、`web-runtime` 或 `client-hmr`；Web 保留同一共享 roster，并添加其载体配置项和 connection 配置。相同测试要求每个 patch 中的所有裸插件都出现在该组合包 manifest 中。

Connection 测试覆盖桌面 bridge 发现、Fetch 重建、每个 chunk 一次 pull 的背压、通过 `DesktopApiClient` 消费 SSE、abort 与 stream cancellation 汇合、非 OK body 清理、响应校验，以及共享通用 RPC 传输。应用测试证明 main 入口的 ESM 求值会在 readiness 待定时完成，并覆盖 response-header CSP，以及 Zod jitless 配置、boot manifest 与 shell bundle 的 nonce 绑定顺序、原生保存替换与不完整文件清理、已安装 CLI preset 解析，以及协议拒绝外部 origin、不允许的方法、过大请求体、畸形 id 和无效 utility 命令。vendored HMR 测试证明空模块根列表可以在没有 Loader internals 时监视精确配置文件，而非空列表缺少 internals 时会明确失败；app-boot 测试覆盖 profile 与 home patch 注册。真实全新进程冒烟测试从初始插件图进入 Settings → Models；DevTools 显示“No Issues”，console 消息为 0。profile-runner 测试会在整个 boot 期间持有 Home 锁，拒绝并发使用同一 Home 的 Host，允许顺序复用、合并重复 dispose，并证明启动失败会释放锁。sandbox 与 terminal 测试覆盖 Electron 专属外层 runner 环境不会转发给用户命令。打包测试会固定 modern injected hoisted deploy 参数、产物路径归属、签名模式、凭据完整性、外部 staging 链接拒绝、staged dependency 解析失败与生产入口导入失败；真实打包命令还会验证其 frozen 部署闭包、仓库安装元数据未变化、property list、代码签名与 ZIP。除非打包时明确传入 `--skip-build`，`pnpm desktop` 与 `pnpm package:mac` 都会在消费库和 Web 外壳前重新构建它们。

## Alternatives considered

**组合 `web-app`，再在桌面 overlay 中禁用它的配置项。** 否决，因为 Loader 状态看似正确，桌面包却仍会依赖 Web 启动、server、前端服务、HMR 和自适应选择器包。共享 `gui-app` 层为各表层提供干净的依赖闭包，也让 composition test 能看见 Web 被意外重新引入。

**在 Electron 内通过回环端口运行既有 Web 应用。** 否决，因为它会给本地应用增加端口冲突、防火墙、DNS rebinding、浏览器 authority、server shutdown 和 URL discovery 问题。零端口 IPC 复用协议，但不复用风险并不适用的物理载体。

**在 Electron main 进程内运行 Harness Host。** 否决，因为插件 activation、CPU 工作和 teardown 会与持有窗口、导航策略、protocol 服务和 IPC 请求 ledger 的进程共享。utility 进程为可信 Host 提供独立 event loop 和有上限的 kill fallback，但不会假称它是恶意代码 sandbox。

**暴露 `ipcRenderer` 或通用 invoke bridge。** 否决，因为 channel 名和 Electron 值会成为 renderer 可控制的应用 API。固定 Fetch 形状 bridge 是既有 Client 协议所需的最小权限，并把 channel 路由留在 main 进程。

**通过 IPC push 响应 chunk 和 Host event。** 否决，因为 push 会忽略 renderer 需求，并需要第二套 buffering 和 flow-control 协议。每次 `ReadableStream` 需求拉取一个 chunk 可以保留 Fetch 背压，也让既有 SSE decoder 继续作为非 Web 载体唯一的事件 framing 实现。

**从 `file://` 加载壳。** 否决，因为它无法给 Vite 根相对资产和插件 URL 提供稳定应用 origin，会让 CSP 与同源行为更复杂，并把 renderer URL 语义耦合到文件系统布局。私有标准安全 scheme 能命名应用资源，而不会授权任意文件读取。

**依赖 Electron 单实例锁持有 Harness home。** 否决，因为它无法发现正在使用同一 Home 的 Web 或 headless Host。共享 profile boot 点会为每种 Host 载体持有一项跨平台 exclusive-create 锁，而无需在 Session 和 Storage 后端之间重复实现持久化专属锁。

## Consequences

Electron 复用与 Web 相同的 API 定义、Client bundle、模块图、Agent Presets、设置、凭据、session 和 workspace，且不打开网络 listener。Web 专属服务和信任策略继续由 Web 表层持有，与传输无关的 Host 清单和 Connection 分发则成为可复用的应用基础设施。

共享 Harness home 是单 Host 资源。Web、CLI 与 Electron 进程可以顺序复用它；并发 profile boot 会在 `.host.lock` 上超时，并在挂载插件前失败。如需有意并发，必须使用不同的 `$DSH_HOME` 根目录。进程非正常退出可能遗留锁文件，且崩溃恢复刻意采用人工方式：操作者确认没有 Host 仍在使用该 Home 后才可删除锁。文件时长或 PID 猜测都不能授权自动抢占锁。

代价是一套真实的 broker 协议和三进程生命周期：请求 id、body reader、取消、图资源、fatal error 和 shutdown 都需要明确归属。单窗口限制让这些状态目前保持精简。源码执行与产品打包仍是两份独立证据：`pnpm desktop` 证明 workspace 应用，`pnpm package:mac` 则证明一个当前原生架构、已签名且可搬移的产品闭包。

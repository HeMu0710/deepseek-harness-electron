# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费与 Host 分发层。客户端插件挂载的 `ctx.connection` 包含一个共享 API 客户端、通用 RPC、当前平台的 loopback 状态、可观察且按 generation 生效的 `hostDescription`，以及单消费方流循环启动器。就绪握手成功后会在 `onConnected` 前发布完整的 `host.describe` 值；generation 失效或显式 stop 会清空它。renderer（渲染进程）依次选择 fixture 模式、固定的桌面 preload bridge，最后才是 Web 载体。Host 服务独立于具体载体分发 Fetch 请求；可选的 Web adapter 再提供 HTTP 路由、浏览器信任检查与 WebSocket 下行。导出表层携带协议类型、`AbstractApiClient`、桌面 preload 类型以及流循环的 sink／配置类型。

## 桌面 preload 载体

Electron preload 暴露一个冻结且窄化的 `window.__DSH_DESKTOP__` 对象，实现本包导出的 `DesktopBridge` 接口。`fetch` 接收可安全 structured clone 的 `DesktopFetchRequest`，只返回 `DesktopFetchHead`；响应字节仍由 Host 持有。renderer 每次 `ReadableStream` pull 都只调用一次 `pull(id)`，且 high-water mark（高水位）为零，因此只有消费方存在待满足需求时，Host 才会继续读取。`AbortSignal` 与 reader cancellation（读取器取消）最终都调用幂等的 `cancel(id)`。响应正常结束会释放 id；序列化后的读取失败会成为 stream error（流错误）。bridge 会把完整请求体作为 `Uint8Array` 传输，因此 Electron adapter 必须先校验 sender 所有权与请求字段，再调用本地可信的 Host 入口，并应直接复用 Host 导出的 `DEFAULT_MAX_REQUEST_BODY_BYTES` 作为字节上限。

`DesktopApiClient` 与通用 `ctx.connection.rpc` 共享同一个 bridge-backed Fetch 函数。Unary（单次）调用、响应以及 `events.mux`、`events.host` 两条流因此使用同一载体；桌面事件流保留 API Proxy 的 SSE framing（帧格式），并通过 pull 协议传输。`HostConnectionHandle.fetch(request)` 依次分发独占首段路径的 RPC channel、已被 interceptor 认领的 `/api` endpoint，最后回退 API Proxy。Web adapter 会把相同的独占注册挂为 prefix route，并保留原有信任策略；桌面组装不需要 `webServer`。

浏览器载体用 HTTP POST 发送 unary 与 response，并为 `events.mux`、`events.host` 各开启一条只下行的 WebSocket。Loopback hostname 判定留在包内部：`/api` Host fence 与 WebSocket upgrade 直接使用它，其他客户端插件消费 `ctx.connection.isLoopback`。Web `/api` 路由把特权方法集（`host.pickDirectory`、`host.openPath`、settings 与 credentials 配置面、`llm.discoverModels` 以及 agent-preset 创作面）限制在 loopback；真正的认证层出现前，已声明的 `trustedHosts` authority 只可访问其他方法。下行细节见 [WebSocket 下行载体 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md)。

## /api 浏览器信任栅栏

node 半侧在桥接或 upgrade 前守卫 `/api` 下的每个入口（`src/api-request-trust.ts`）。每个请求——无论是否带浏览器标记——`Host` 都必须是回环地址权威，或与某个 `trustedHosts` 条目匹配：带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较（DNS rebinding 防御）。刻意不为无浏览器标记的 HTTP 请求开捷径：明文 HTTP 下浏览器的图片与导航读取既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起的、响应可被读走的读取，而 Host 是重绑唯一伪造不了的请求头；WebSocket 浏览器握手会带 `Origin` 并通过同一道比较。非浏览器客户端经由回环地址、部署推导的 LAN IP 字面量或已声明的权威通过同一道栅栏。当标记存在时，如附带 `Origin`，则它必须与 Host 权威完全一致；显式的 `sec-fetch-site: cross-site` 标记一律拒绝。不是纯的、规范形 `host[:port]` 权威的 `trustedHosts` 条目——即 WHATWG 解析读回后与原文不完全一致的——会让插件加载明确报错：否则解析会悄悄授权 `harness.internal/path` 这类笔误里的 hostname，或把悬空冒号、补零端口放大成任意端口授权。HTTP 失败在任何 RPC 分发之前以纯 403 应答，upgrade 失败在启动任何事件流前拒绝握手。非回环组合必须显式信任其服务权威：Web 运行时从全接口服务器配置推导 LAN IP 字面量，cordis.yml 中的 `trustedHosts` 与 CLI（命令行界面）的 `--trusted-host` flag 则声明具名权威。`dsh web --host 0.0.0.0` 在远程访问具备认证层之前有意不受支持。这道栅栏是可达性策略，而不是认证；Web 载体不提供认证层。决策记录：[api 浏览器信任边界 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md)。

## `/api` WebSocket 下行

`/api/events.mux` 与 `/api/events.host` 各接受一条 WebSocket upgrade，并只向浏览器发送对应的 `ServerRequest` 文本消息；客户端不会在这些 socket 上发送业务数据。任一 socket 结束都会使当前 connection generation 失败并重建两条流，连接就绪仍要求两条 socket 均已打开且 `host.describe` HTTP 调用成功。Host teardown 会终止两条 socket、中止各自的 source，并等待 source 清理完成后再返回。普通网络 GET 这些路径会返回 426，不保留 SSE（Server-Sent Events）回退；`toFetchHandler` 的 SSE 编解码只服务进程内同构载体。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **History 会恢复未附加的会话**：打开 history 可能创建宿主侧 agent，并增加首次打开的延迟；没有仅从持久化读取的路径。
- **`/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 160 MiB，按默认 100 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；要降低它而不缩小图片限额，需要流式请求体路径。
- **桌面 bridge 会把每个请求体作为一个 structured-clone 值传输**：Electron adapter 执行本包导出的 160 MiB 请求上限；响应体仍按 pull 增量传输。

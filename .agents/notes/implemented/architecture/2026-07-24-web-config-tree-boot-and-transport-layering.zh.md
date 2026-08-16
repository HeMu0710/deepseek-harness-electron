# Agent Note: dsh web 的 config-tree boot 与 web 传输分层

Status: implemented

[English](2026-07-24-web-config-tree-boot-and-transport-layering.md) | 中文

> 范围：`dsh web` 如何组合（profile 组合包 patch + Cordis 之前的 boot + 配置源），以及 Web 传输如何跨包分层（网关 / 载体 / 绑定 / 图 / 开发期重载）。浏览器侧装载链归 [Client 插件装载 note](2026-07-23-client-plugin-loading-model.md) 所有，本组合只是它的供给方；同级非 Web 载体归 [Electron 桌面应用](2026-08-14-electron-ipc-desktop-application.md)所有。

## 问题

`dsh web` 曾是仅剩的手工装配面：`bootHost` 逐个挂 32 个插件、config 钉死在代码里（违反 no-hardcoded-tunables），client roster 是 `web.ts` 常量，而 TUI/headless 早已是 yml 组合。传输层的职责错位与之配套：webserver 自称哑载体却认识 `__DSH_BOOT__` 图、拥有 SSE（Server-Sent Events）通道、硬编码 `/api/*` 前缀；dev 的 bundle watch 寄居在 prod 注册表里靠 `watch?` 参数开关、生命周期无主；图注册表对每次 `internal/plugin` 全量重扫；单请求失败与致命 server 错误共用一个一律退出进程的 sink。还有一个用户可见缺陷：web 路径从不加载 `$DSH_HOME/.env`，`DSH_HOME=… dsh web` 读不到自定义 home 下的 API key。

## 决策

**组合结果是一棵平铺配置树。** Profile 组合包只打包归属，不嵌套 Loader 结果：Web 先应用 `dsh-base`，再应用与传输无关、持有 Host 与 Client roster 的 `dsh-gui-app`，最后应用 `dsh-web-app` 载体配置项；其后才是 profile 和 launcher patch 层（[profile 组合包决策](2026-08-05-profile-plugin-bundles.md)）。每个插件仍是一项配置项，每个 config 字段仍可由 YAML 修改。`dsh-client-hmr` 配置项只属于 Web 表层，在重建 watcher 改写 Client bundle 之前保持空闲；Electron 会省略它。配置项顺序没有装载语义；激活由服务可用性驱动。共享 audit 会拒绝没有 fiber 的 import、仅等待失败的 fiber 以恢复原始激活错误，并报告让 fiber 停在 `PENDING` 的服务；抛出错误前，审计会通过一个进程级检查点标记这些 rejection 的确切原因，从而让 `installFailLoud` 将 Loader 的重复通知合并为一次，而无关的未处理 rejection 仍然致命。Node app-boot 产物内嵌 `@cordisjs/plugin-include`，但将 `@cordisjs/plugin-loader` 保持为外部依赖，因此 include 的 `EntryTree` 与 Host 会绑定到同一个 Loader peer，而不会让一棵配置树横跨两个 Loader 实现。

**boot 胶水由一个 Host runner 和一个 Client 内核组成。** `dsh-app-boot` 中的 `bootProfile` 持有每个长驻 Host 在 Cordis 配置项挂载前都需要的内容：分层 env、有序 patch 组合、Loader boot、activation audit、用户 patch watcher、profile root 与失败清理。CLI 与 Electron 在该 runner 外提供各自的调用事实和进程生命周期。`AppWebEntry` 持有 Client Cordis 之前必须存在的 renderer 事实：把 `window.__DSH_BOOT__` 解析成 `BootManifest`（双视角：npm 包配置项给模块表、Cordis 插件配置项给 entry 组合；畸形 wire 大声抛）、构建模块系统、渲染 loading 页、让 `immediately` 层预取与 Context／Loader 准备并行、**create entry 之前等预取齐**（物化是 `tree.import` 的同步 require，不受 fiber inject 等待保护；locale → runtime/client 这类跨包 require 边要求 `immediately` 层工厂全部注册完——否则有实测 10–25% 的 boot 竞态）、收编 modules entry、逐一创建图配置项、settle 并 sweep。

**每个配置源有唯一声明位置。** 组合包 yml 值是工程默认，Settings 分节是可写的用户偏好，CLI（命令行界面）flags 面向其归属的启动器配置行，env 值则通过 yml `!!js` 表达式进入。patch 会整体替换一行的 config。解析后的前端 `distIndex` 通过同一条 patch 通道作为组装事实传递。与传输无关的提供方／模型默认值归 `ctx.agentDefaultModel` 所有；[直接 headless 入口](2026-08-09-headless-direct-core-entry-point.md)与 Web 网关消费同一份状态。

**传输五分。** `dsh-host-apiproxy` 是网关插件（`api-gateway` 配置项）：provide `ctx.apiProxy`，保持传输无关且不注册路由。`dsh-host-webserver` 是朴素路由注册插件：`WebServer` provide `ctx.webServer`（`register(route) → disposer`、重复 pattern 即抛、index transform 按注册序应用、`port`），激活即 listen，且不认识任何 Harness 概念。Connection Host 半始终提供与传输无关的 Fetch dispatcher，并在 `webServer` 存在时条件挂载 `/api` 与 WebSocket 下行；Electron 经 IPC 调用同一个 dispatcher。modules Host 半（`ClientModuleRegistry`，provide `ctx.clientModules`）始终持有单包增量扫描和图／路径通知，并且只在 `webServer` 存在时挂载 bundle 路由与 index tap。HMR Host 半通过 stat-poll membership 与 `/plugins/events` SSE 路由持有仅 Web 的开发期重载。

**包出口纪律。** modules 包只暴露 `.`（node 半）与 `./client`（完整浏览器半：`ClientModuleSystem`、`parseBootManifest`、收编插件面）——不设专用子路径；wire 类型经根出口 re-export 给 host 侧消费方。收编握手：内核在 cordis 之前把建好的实例写入 `window.__DSH_MODULES__`；`./client` 的 apply 读取该槽位（缺少时显式抛错）并 provide `ctx.modules`。

## 后果

- 重组一个 web 部署 = 改 yml/patch；退役件（`mountWebPlugins`、`CLIENT_PACKAGES`、`createHostWebPluginRegistry`、`startWebServer`、webserver 的图/SSE/api 知识）全部删除。
- [Headless 是直接 core 入口](2026-08-09-headless-direct-core-entry-point.md)：其随附 profile 包含共享的 base Agent 能力，并省去 Host、HTTP、Web 与浏览器层。本笔记的传输划分是浏览器 surface 的约定。
- 一个值得记住的 TypeScript 坑：`declare module 'cordis'` augmentation 所在文件若**没有任何 cordis import**，会被降级成独立模块声明，无声打散全程序的 `Context` merge（`ctx.on`/`ctx.effect` 全程序消失）。用 `import type {} from 'cordis'` 锚定。

## 考虑过的替代方案

| 弃案 | 一行理由 |
|---|---|
| 专门的 `dsh-host-profile` 受体包 | 用户模型状态归 Settings 支撑的 `ctx.agentDefaultModel` 所有；额外的 Host 受体会重复归属，并排除直接入口 |
| 运行时里的 `assembly` 垫层插件（provide `apiHandler`） | 它的存在只因 `createApiProxy` 住运行时；本体迁入 apiproxy 后网关可自承载，且 `toFetchHandler` 是绑定方自己调的纯函数 |
| 全量重扫与增量扫描并存 | 两条实现两份语义；单包路径足以覆盖激活初扫 |
| modules 包特设 `./impl` 出口 | 出口不统一；标准 `./client` 承载完整浏览器半 |
| dev overlay / `cordis.dev.yml` | 一套 yml；`!!js` 无法条件化行存在性，`--dev` 追加一行就是全部差异 |
| env 进映射表 | 同一字段将出现 env/json 双源，需再发明优先级 |
| create 不等预取（以 `arrive()` 去重为安全依据） | 被 10–25% boot 竞态证伪：在途去重只覆盖同包双拉，不覆盖跨包同步 require 边 |
| json 直接当 loader patches 文件 | json 键名将耦合 yml 行结构，profile 编写者要懂 cordis |

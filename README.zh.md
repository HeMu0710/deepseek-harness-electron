# DeepSeek Harness Electron

[English](README.md) | 中文

DeepSeek Harness Electron 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 独立维护的 Electron 桌面 GUI。本公开 fork 保留上游的插件化 agent 运行时与 Web UI，并让 Harness Host 运行在 Electron utility process 中，通过本地 IPC 与 renderer 通信，不再依赖 loopback HTTP server。

上游项目由 [DeepSeek AI](https://deepseek.com) 开发。本 fork 发布的 Release 产物由本项目独立维护，并非 DeepSeek AI 官方发行版本。

## 开发者预览

桌面应用与上游 Harness 均处于开发者预览阶段，可能引入破坏兼容性的变更。

## 运行

### 下载 macOS Release

已发布的 macOS 版本会作为 ZIP 附加到 [GitHub Releases](https://github.com/HeMu0710/deepseek-harness-electron/releases)。请根据 Mac 处理器下载对应文件：

| Mac | Release 产物 |
|---|---|
| Apple Silicon（M1/M2/M3/M4 及后续型号） | `DeepSeek-Harness-darwin-arm64.zip` |
| Intel | `DeepSeek-Harness-darwin-x64.zip` |

打开 ZIP，将 `DeepSeek Harness.app` 移入 `/Applications`，再从该目录启动。每个 Release 可能提供其中一种或两种架构；本项目目前不生成 Universal 应用。

只有包含经过 Developer ID 签名与 notarization 的应用的 ZIP 才适合直接公开分发。如果 Releases 页面没有适合当前架构的产物，请从源码运行或在本机打包。

### 从源码运行 Electron

安装 Git、Node.js `^22.19.0 || >=24.0.0`，以及带 pnpm 11.7.0 的 Corepack，然后运行：

```sh
git clone https://github.com/HeMu0710/deepseek-harness-electron.git
cd deepseek-harness-electron
corepack enable
pnpm install
pnpm desktop
```

`pnpm desktop` 会先构建 Host 库、Client bundle、Web shell 与 Electron 入口，再启动应用。首次启动后，在设置 → 模型中配置模型提供方与凭据。桌面运行时、IPC 安全模型、共享数据目录与当前限制见 [Electron 应用 README](apps/electron/README.md)。

### 运行 Web UI

上游的浏览器界面仍可使用。无需克隆仓库即可运行已发布的 CLI：

```sh
npx @deepseek-ai/dsh web
```

#### 从源码运行

如需改为从当前源码运行 Web UI：

```sh
pnpm install
pnpm run build
pnpm dsh web
```

命令会打印本地访问地址，默认为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

## 打包 macOS 应用

打包需要一台运行目标架构的 Mac，以及 Xcode Command Line Tools。在仓库根目录运行：

```sh
pnpm package:mac
```

该命令会构建、校验、ad-hoc 签名并打包当前架构，生成：

```text
.artifacts/electron/macos/DeepSeek Harness-darwin-<arch>/DeepSeek Harness.app
.artifacts/electron/macos/DeepSeek-Harness-darwin-<arch>.zip
```

默认生成的 ad-hoc ZIP 仅用于本机测试，在另一台 Mac 上可能被 Gatekeeper 拒绝。如需准备公开 GitHub Release，请分别在对应架构的 Mac 上构建 arm64 与 x64，配置 `Developer ID Application` 身份和 Apple notarization 凭据，再上传生成的架构专用 ZIP。不要把默认 ad-hoc 压缩包作为公开 Release 发布。

[macOS 打包教程](docs/cookbook/packaging-macos-app.md)详细说明前置条件、增量构建、ZIP 冒烟测试、Developer ID 签名、notarization 与独立签名校验。

## 上游与开发

- 核心 agent harness 与插件架构见上游 [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)。
- 本地开发请从[开发指南](docs/development.md)与[架构文档](docs/architecture.md)开始。
- 贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；使用 coding agent 时请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

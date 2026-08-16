# 打包 macOS 桌面应用

[English](packaging-macos-app.md) | 中文

本教程从 Electron 应用生成可搬移的 `DeepSeek Harness.app` 与 ZIP。默认使用 ad-hoc 签名，供本机测试。配置 Developer ID 身份与公证凭据后，同一条命令会生成可分发构建。Electron 的[应用分发](https://www.electronjs.org/docs/latest/tutorial/application-distribution/)与[代码签名](https://www.electronjs.org/docs/latest/tutorial/code-signing)指南解释了这些步骤背后的平台要求。

## 前置条件

- 一台 arm64 或 x64 Mac，且当前运行架构与目标架构一致。原生提供方会为当前架构安装，因此该命令不会交叉构建，也不会生成 Universal 应用。
- 仓库支持的 Node.js、Corepack、pnpm 与 Git 版本，之后运行 `pnpm install`。
- Xcode Command Line Tools。必须能够使用 `xcode-select -p`、`codesign`、`plutil`、`ditto` 与 `xcrun`。
- 如需公开分发，需要 Apple Developer 会员资格，以及安装在已解锁 keychain 中的 `Developer ID Application` 证书。

## 构建本地应用

在仓库根目录运行：

```sh
pnpm package:mac
```

该命令会验证桌面部署根目录的 peer 闭包；构建 Host 库、Client bundle、Web 外壳与 Electron 入口；然后按 frozen lockfile 把生产 workspace 包注入隔离且采用 hoisted 布局的 staging 目录，并且不运行依赖的 lifecycle script。它会拒绝无法从所属 staged 包解析的 dependency 与必需 peer，使用 plain Node 导入 main 和 Host 的 workspace 根入口，验证前端、preset、Client bundle、worker、原生 addon、libvips、`rg` 与 `spawn-helper`，并拒绝指向 staging 外部的链接。命令在以 `asar: false` 调用 `@electron/packager` 前移除仅部署期使用的 `.bin` 链接；Packager 会物化其余经过验证的 staging 链接，因此产物不会保留指向临时 staging 目录的路径。命令还会验证 deploy 没有改动仓库 lockfile 与安装元数据。它会对应用执行 ad-hoc 签名、验证复制后的生产入口、property list 与签名，并生成两个产物：

```text
.artifacts/electron/macos/DeepSeek Harness-darwin-<arch>/DeepSeek Harness.app
.artifacts/electron/macos/DeepSeek-Harness-darwin-<arch>.zip
```

应用资源目录保持解包状态是有意设计。utility Host 会通过普通文件系统路径解析随附 preset、前端文件、动态 Client bundle、原生 addon 与 helper 可执行文件。不得在不修改这些查找和执行路径的情况下启用 `asar`。

桌面 Host 会以 `root: []` 挂载 Cordis HMR。无论源码启动还是打包后的应用，profile 与 home `cordis.patch.yml` 的改动都会持续生效，而模块 HMR 保持禁用。因此，打包后的 utility process 不依赖 Electron 转发 `--expose-internals`。

如标准本地缓存中已有匹配版本的 Electron archive，Packager 会直接复用。首次打包可能需要下载该 archive。

完整构建成功后，如源码没有变化，可跳过重建并再次打包：

```sh
pnpm package:mac -- --skip-build
```

修改源码、包 manifest、Client bundle 或 Web 外壳后，不得使用 `--skip-build`。

## 冒烟测试打包后的应用

先解压 ZIP 再测试，使检查覆盖可搬移的发布产物，而不只是 Packager 输出目录。使用隔离的 Harness 与 Chromium 数据目录，避免打包后的 Host 与另一个正在运行的 Web、CLI 或桌面进程竞争：

```sh
DSH_PACKAGE_ARCH="$(node -p 'process.arch')"
DSH_PACKAGE_SMOKE="$(mktemp -d /tmp/dsh-package-smoke.XXXXXX)"
DSH_PACKAGE_HOME="$DSH_PACKAGE_SMOKE/home"
DSH_PACKAGE_USER_DATA="$DSH_PACKAGE_SMOKE/user-data"
mkdir -p "$DSH_PACKAGE_HOME" "$DSH_PACKAGE_USER_DATA" "$DSH_PACKAGE_SMOKE/unpacked"
ditto -x -k \
  ".artifacts/electron/macos/DeepSeek-Harness-darwin-$DSH_PACKAGE_ARCH.zip" \
  "$DSH_PACKAGE_SMOKE/unpacked"
DSH_PACKAGE_APP="$DSH_PACKAGE_SMOKE/unpacked/DeepSeek Harness.app"
DSH_HOME="$DSH_PACKAGE_HOME" \
DSH_TELEMETRY_DISABLED=1 \
  "$DSH_PACKAGE_APP/Contents/MacOS/DeepSeek Harness" \
  --user-data-dir="$DSH_PACKAGE_USER_DATA" \
  --enable-logging=stderr
```

确认初始会话视图打开，设置 → 模型在没有内容安全策略（Content Security Policy）错误的情况下渲染，终端可以启动，文件搜索可用，原生目录选择器能够打开。从应用菜单退出或关闭其唯一窗口，随后验证前台命令已经返回且 Host 锁已消失：

```sh
test ! -e "$DSH_PACKAGE_HOME/.host.lock"
```

ad-hoc ZIP 是本机测试产物；另一台 Mac 上的 Gatekeeper 不会把它视为公开发布版本。

## 签名并公证发布版本

先把公证凭据存入 macOS Keychain。此示例会提示输入 app-specific password，而不会把它放进 shell 历史：

```sh
xcrun notarytool store-credentials "dsh-release" \
  --apple-id "developer@example.com" \
  --team-id "TEAMID"
```

然后使用证书在 Keychain 中的完整身份和已存储的 profile 进行打包：

```sh
APPLE_SIGN_IDENTITY="Developer ID Application: Example Name (TEAMID)" \
APPLE_NOTARY_KEYCHAIN_PROFILE="dsh-release" \
pnpm package:mac
```

打包器会为 Developer ID 签名启用 hardened runtime，对嵌套原生代码签名，通过 `notarytool` 提交应用，并在重新创建 ZIP 前验证 stapled ticket。独立验证发布产物：

```sh
APP_PATH=".artifacts/electron/macos/DeepSeek Harness-darwin-$(node -p 'process.arch')/DeepSeek Harness.app"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
spctl --assess --type execute --verbose=2 "$APP_PATH"
```

在 CI 中，该命令还接受与 `APPLE_SIGN_IDENTITY` 配套的一种完整公证策略：

- App Store Connect API key：`APPLE_API_KEY` 指向 `.p8` 文件，`APPLE_API_KEY_ID` 指定 key，Team key 还需用 `APPLE_API_ISSUER` 提供 issuer。
- Apple ID：`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 与 `APPLE_TEAM_ID`。

把全部凭据值保存在 CI secret store 中。该命令会拒绝不完整或混用的策略。

## 当前发布范围

该命令生成当前原生架构的 `.app` 与 ZIP，尚不创建 Universal binary、DMG、Windows installer、自动更新 feed 或产品图标。arm64 与 x64 发布版本应分别在相同架构的 Mac 上构建。保持 Electron 的 RunAsNode fuse 启用：sandbox、terminal 与原生 picker helper 只会为它们的外层 JavaScript runner 把 Electron 可执行文件当作 Node 使用。

[Electron 应用 README](../../apps/electron/README.md)负责说明运行时限制。`@electron/packager` 配置遵循其[官方选项](https://electron.github.io/packager/main/interfaces/Options.html)。

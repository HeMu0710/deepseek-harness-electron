# DeepSeek Harness Electron

English | [中文](README.zh.md)

DeepSeek Harness Electron is an independently maintained Electron desktop GUI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). This public fork keeps the upstream plugin-based agent runtime and Web UI, then runs the Harness Host in an Electron utility process connected to the renderer through local IPC instead of a loopback HTTP server.

The upstream project is developed by [DeepSeek AI](https://deepseek.com). This fork is maintained independently and is not an official DeepSeek AI distribution.

## Developer preview

The desktop application and upstream Harness are in developer preview and may introduce compatibility-breaking changes.

## Run

### Build a local macOS application

This project does not currently publish downloadable macOS application archives. Build on a Mac whose processor matches the target architecture: Apple Silicon produces `arm64`, and Intel produces `x64`. Follow [Package the macOS application](#package-the-macos-application) to create the local application and ZIP.

The generated application uses an ad-hoc signature and is intended for testing on the build Mac. It is not a Developer ID-signed and notarized public distribution.

### Run Electron from source

Install Git, Node.js `^22.19.0 || >=24.0.0`, and Corepack with pnpm 11.7.0, then run:

```sh
git clone https://github.com/HeMu0710/deepseek-harness-electron.git
cd deepseek-harness-electron
corepack enable
pnpm install
pnpm desktop
```

`pnpm desktop` builds the Host libraries, Client bundles, Web shell, and Electron entries before launching the application. On first launch, open Settings → Models to configure a model provider and credential. The desktop runtime, IPC security model, shared data directory, and current limitations are documented in the [Electron application README](apps/electron/README.md).

### Run the Web UI

The upstream browser interface remains available. Run the published CLI without cloning the repository:

```sh
npx @deepseek-ai/dsh web
```

#### Run from source

To run the Web UI from this checkout instead:

```sh
pnpm install
pnpm run build
pnpm dsh web
```

The command prints the local URL, which is `http://127.0.0.1:3080` by default. See the [Web UI guide](docs/user/guide/index.md).

## Package the macOS application

Packaging requires a Mac running the target architecture and the Xcode Command Line Tools. From the repository root, run:

```sh
pnpm package:mac
```

The command builds, validates, ad-hoc signs, and packages the current architecture into:

```text
.artifacts/electron/macos/DeepSeek Harness-darwin-<arch>/DeepSeek Harness.app
.artifacts/electron/macos/DeepSeek-Harness-darwin-<arch>.zip
```

The ad-hoc ZIP is intended for local testing and may be rejected by Gatekeeper on another Mac. This project does not currently provide Developer ID-signed and notarized downloads; do not publish the generated archive as a public release.

The [macOS packaging tutorial](docs/cookbook/packaging-macos-app.md) covers prerequisites, incremental builds, ZIP smoke testing, Developer ID signing, notarization, and independent signature verification.

## Upstream and development

- Read the upstream [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) for the core agent harness and plugin architecture.
- Start local development with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).
- See [CONTRIBUTING.md](CONTRIBUTING.md) before contributing, and follow [AGENTS.md](AGENTS.md) when working with coding agents.

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

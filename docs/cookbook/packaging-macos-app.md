# Package the macOS desktop application

English | [中文](packaging-macos-app.zh.md)

This tutorial produces a relocatable `DeepSeek Harness.app` and ZIP from the Electron application. The default is an ad-hoc signature for local testing. A Developer ID identity and notarization credentials turn the same command into a distributable build. Electron's [application distribution](https://www.electronjs.org/docs/latest/tutorial/application-distribution/) and [code-signing](https://www.electronjs.org/docs/latest/tutorial/code-signing) guides explain the platform requirements behind these steps.

## Prerequisites

- An arm64 or x64 Mac running the architecture being packaged. Native providers are installed for the current architecture, so this command does not cross-build or create a Universal application.
- The repository's supported Node.js, Corepack, pnpm, and Git versions, followed by `pnpm install`.
- Xcode Command Line Tools. `xcode-select -p`, `codesign`, `plutil`, `ditto`, and `xcrun` must be available.
- For public distribution, an Apple Developer membership and a `Developer ID Application` certificate installed in an unlocked keychain.

## Build a local application

From the repository root, run:

```sh
pnpm package:mac
```

The command verifies the desktop deploy-root peer closure; builds Host libraries, Client bundles, the Web shell, and Electron entries; then uses the frozen lockfile to inject production workspace packages into an isolated hoisted staging tree without running dependency lifecycle scripts. It rejects dependencies and required peers that the owning staged package cannot resolve, imports the main and Host workspace roots with plain Node, validates the frontend, presets, Client bundles, workers, native addons, libvips, `rg`, and `spawn-helper`, and rejects links outside staging. It removes deploy-only `.bin` links before invoking `@electron/packager` with `asar: false`; Packager materializes any remaining validated staging links so the product cannot retain paths into the temporary staging directory. The command also verifies that deploy left the repository lockfile and installation metadata unchanged. It ad-hoc signs the application, validates its copied production imports, property list, and signature, and creates both products:

```text
.artifacts/electron/macos/DeepSeek Harness-darwin-<arch>/DeepSeek Harness.app
.artifacts/electron/macos/DeepSeek-Harness-darwin-<arch>.zip
```

The unpacked application resource directory is intentional. The utility Host resolves shipped presets, frontend files, dynamic Client bundles, native addons, and helper executables through normal filesystem paths. Do not enable `asar` without changing those lookup and execution paths.

The desktop Host mounts Cordis HMR with `root: []`. Changes to the profile and home `cordis.patch.yml` files remain live in both source and packaged applications, while module HMR stays disabled. The packaged utility process therefore does not rely on Electron forwarding `--expose-internals`.

Packager reuses the exact Electron archive from the standard local cache when available. The first packaging run may download that archive.

After a successful full build, repeat packaging without rebuilding unchanged sources:

```sh
pnpm package:mac -- --skip-build
```

Do not use `--skip-build` after changing source, package manifests, Client bundles, or the Web shell.

## Smoke-test the packaged application

Extract the ZIP before testing so the check covers the relocatable release artifact rather than the Packager output directory. Use isolated Harness and Chromium data directories so the packaged Host does not contend with another running Web, CLI, or desktop process:

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

Confirm the initial conversation view opens, Settings → Models renders without a Content Security Policy error, a terminal starts, file search works, and the native directory picker opens. Quit from the application menu or close its only window, then verify that the foreground command returns and the Host lock is gone:

```sh
test ! -e "$DSH_PACKAGE_HOME/.host.lock"
```

The ad-hoc ZIP is a local test artifact; Gatekeeper on another Mac will not treat it as a public release.

## Sign and notarize a release

First store notarization credentials in the macOS Keychain. This example prompts for an app-specific password instead of placing it in shell history:

```sh
xcrun notarytool store-credentials "dsh-release" \
  --apple-id "developer@example.com" \
  --team-id "TEAMID"
```

Then package with the certificate's exact Keychain identity and the stored profile:

```sh
APPLE_SIGN_IDENTITY="Developer ID Application: Example Name (TEAMID)" \
APPLE_NOTARY_KEYCHAIN_PROFILE="dsh-release" \
pnpm package:mac
```

The packager enables hardened runtime for Developer ID signing, signs nested native code, submits the application through `notarytool`, and validates the stapled ticket before recreating the ZIP. Verify the release product independently:

```sh
APP_PATH=".artifacts/electron/macos/DeepSeek Harness-darwin-$(node -p 'process.arch')/DeepSeek Harness.app"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
spctl --assess --type execute --verbose=2 "$APP_PATH"
```

For CI, the command also accepts one complete notarization strategy alongside `APPLE_SIGN_IDENTITY`:

- App Store Connect API key: `APPLE_API_KEY` points to the `.p8` file, `APPLE_API_KEY_ID` names the key, and `APPLE_API_ISSUER` supplies the issuer for a Team key.
- Apple ID: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.

Keep all credential values in the CI secret store. The command rejects incomplete or mixed strategies.

## Current release scope

The command emits a native-architecture `.app` and ZIP. It does not yet create a Universal binary, DMG, Windows installer, automatic-update feed, or product icon. Build arm64 and x64 releases on matching Macs. Keep Electron's RunAsNode fuse enabled: sandbox, terminal, and native-picker helpers use the Electron executable as Node only for their outer JavaScript runner.

The [Electron application README](../../apps/electron/README.md) owns runtime limitations. `@electron/packager` configuration follows its [official options](https://electron.github.io/packager/main/interfaces/Options.html).

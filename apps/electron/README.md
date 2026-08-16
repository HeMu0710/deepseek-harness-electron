# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The zero-port Electron application for DeepSeek Harness. It reuses the built Web shell and the shared GUI profile, but carries all API, generic RPC, and event-stream traffic through an isolated preload bridge instead of HTTP or WebSocket.

Run `pnpm desktop`. The command runs the root `build:lib`, then `build:web`, then the desktop package build before launching Electron, so it never reuses a stale renderer artifact. Run `pnpm package:mac` on macOS to produce a native-architecture `.app` and ZIP; the [macOS packaging tutorial](../../docs/cookbook/packaging-macos-app.md) covers local, signed, and notarized builds. The desktop profile is initialized as `dsh-base` + `dsh-gui-app` + `dsh-electron-app`; it uses the same `$DSH_HOME` settings, credentials, sessions, workspaces, and agent presets as the CLI surfaces.

The main process registers the private scheme during ESM evaluation, schedules the remaining startup work after Electron readiness, and serves only the built shell and the exact client bundles published by the Host inventory through the standard secure `dsh://app` scheme. The renderer runs with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, a nonce-bound Content Security Policy, denied permissions, blocked navigation, and a preload exposing only `fetch`, `pull`, `cancel`, `saveDownload`, and immutable application metadata. The Harness Host runs in an Electron utility process. Its Cordis HMR service uses `root: []`, so profile and home patch files remain live while module HMR stays disabled; the packaged Host does not depend on Electron forwarding `--expose-internals`. API and SSE response bodies cross IPC one pulled chunk at a time. Session export obtains an OS-approved path in the main process and streams the ZIP from the utility Host directly into a temporary file before replacement; the path never reaches renderer code. Cancellation aborts the Host Request, cancels its reader, and waits for cleanup.

Quit stops the utility Host from accepting work, cancels and drains its active handlers, then disposes the profile before acknowledging cleanup and exiting naturally. Profile disposal releases `$DSH_HOME/.host.lock` before the acknowledgment. The main process allows two seconds for graceful cleanup and natural exit; it kills only a Host that misses that deadline, then waits another bounded interval for process termination. Reaching the graceful deadline without a cleanup acknowledgment, a non-zero exit before forced termination, or failure to terminate after a kill makes the desktop application exit with failure.

## Known Limitations and Deferred Work

- **macOS packages target the build host's architecture** — `pnpm package:mac` emits an ad-hoc-signed `.app` and ZIP for local use, or a Developer ID-signed and notarized product when Apple credentials are configured. Universal builds, DMG installers, Windows packages, automatic updates, and a product icon remain release work.
- **Runtime-installed Client halves are unavailable under the strict CSP** — `cordis-client-runner` evaluates their source strings with `new Function`, while the renderer forbids string code generation. The shipped static Client graph and runtime-installed Host halves continue to work. Supporting dynamic Client code requires a non-string-code delivery path; the desktop application does not add `unsafe-eval`.
- **Electron must retain RunAsNode** — the Windows ACL sandbox, persistent terminal, and native directory picker launch JavaScript helpers through `process.execPath`. They enable Node mode only for the outer helper, and the ACL runner removes that value before the user command starts. A packaged build must keep the fuse enabled or introduce a shared Node launcher first.
- **One Host process may use a Harness home at a time** — profile boot enforces `$DSH_HOME/.host.lock`, so a concurrent Web, CLI, or desktop Host using that home fails startup instead of racing Session or Storage writes. Use distinct homes for intentional concurrency. After an unclean exit, confirm no Host uses the home before removing an orphaned lock file.
- **One window is supported** — request ownership and sender validation intentionally bind IPC to the single application window.

## Model Experience

Indirect: the application mounts the shared GUI profile whose child plugins own all model-facing behavior.

#### KV Cache effect

None directly.

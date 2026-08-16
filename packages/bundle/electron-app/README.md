# `@deepseek-ai/dsh-electron-app`

English | [中文](README.zh.md)

The Electron surface bundle. [`cordis.patch.yml`](cordis.patch.yml) follows [`dsh-base`](../base/README.md) and [`dsh-gui-app`](../gui-app/README.md), then pins the Host directory picker and its client surface to the native OS interaction. Web startup, `webServer`, Web runtime glue, and client HMR are not disabled placeholders: they belong only to [`dsh-web-app`](../web-app/README.md) and never enter the desktop composition. The resulting dependency closure therefore retains the shared modules, connection, API, and UI roster without carrying the Web server or frontend-serving packages.

The package is a static surface patch with no runtime API. The Electron application owns renderer asset loading, the IPC carrier, window lifecycle, and packaged runtime location; those process concerns do not become Cordis rows in this bundle.

## Model Experience

None, as this surface bundle selects a native directory interaction and adds no prompt, message, tool schema, or model-visible result.

#### KV Cache effect

None; the surface does not change any assembled model request.

## Known Limitations and Deferred Work

- **Layer order is required** — composing this bundle without `gui-app` installs only the native directory interaction and omits the Host/API/client roster.
- **The Electron app must provide the carrier** — this patch deliberately contains no HTTP fallback; startup is usable only after the app binds the shared connection and module inventory to its IPC and renderer-resource carriers.

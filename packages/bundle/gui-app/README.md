# `@deepseek-ai/dsh-gui-app`

English | [中文](README.zh.md)

The shared GUI profile layer. [`cordis.patch.yml`](cordis.patch.yml) follows [`dsh-base`](../base/README.md), adds the transport-independent Host services, API gateway, client module inventory, connection row, and complete client/UI roster, then moves per-agent model-facing rows behind Agent Presets. A surface layer follows it: [`dsh-web-app`](../web-app/README.md) supplies HTTP/WebSocket startup and browser runtime glue, while [`dsh-electron-app`](../electron-app/README.md) supplies the desktop-native interaction and leaves renderer transport to the Electron app. Keeping the roster here gives both surfaces the same package ids, injection graph, settings pages, and session projections without making the desktop installation depend on Web startup or serving packages.

The package has no runtime API. The profile composer resolves its patch through `dsh.bundle.patch`; profiles must order the layers as `base`, `gui-app`, then exactly one surface bundle. A patch replaces a row's complete `config`, so a surface that specializes a shared row must restate every field it keeps.

## Model Experience

### GUI persona and per-session composition

#### What the model sees

The layer sets the shared GUI persona and mounts Agent Presets so each session receives the prompt and tools owned by its selected preset.

##### Shared persona

```markdown
You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
```

#### Token effect

One fixed persona sentence plus the selected preset's independently owned context. The bundle contributes no tool schema or result text itself.

#### KV Cache effect

The persona is a stable system-prompt prefix for the process. Selecting a different preset for a later session changes that session's independently assembled prompt and tool catalog.

## Known Limitations and Deferred Work

- **A surface bundle is required** — this layer deliberately mounts no renderer asset carrier or directory-picker interaction; composing it without `web-app` or `electron-app` leaves those GUI operations unavailable.
- **Session export retains the browser download operation** — the shared roster includes `dsh-session-log-export`; a desktop save-dialog carrier must adapt that operation before Electron export is complete.

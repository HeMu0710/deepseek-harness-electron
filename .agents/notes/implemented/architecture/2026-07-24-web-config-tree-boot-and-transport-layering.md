# Agent Note: dsh web config-tree boot and the web transport layering

Status: implemented

English | [中文](2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)

> Scope: how `dsh web` composes (profile bundle patches + pre-Cordis boot + config sources) and how the Web transport splits across packages (gateway / carrier / binding / graph / dev-reload). The [client plugin loading note](2026-07-23-client-plugin-loading-model.md) owns the browser-side loading chain this composition feeds; the [Electron desktop application](2026-08-14-electron-ipc-desktop-application.md) owns the sibling non-Web carrier.

## Problem

`dsh web` was the only hand-assembled surface left: `bootHost` mounted 32 plugins with configs pinned in code (violating no-hardcoded-tunables), the client roster was a `web.ts` constant, and TUI/headless had long been yml compositions. The transport layer misplaced responsibilities to match: the webserver self-described as a dumb carrier yet knew the `__DSH_BOOT__` graph, owned the SSE channel, and hard-coded the `/api/*` prefix; the dev bundle watch lived inside the prod registry behind a `watch?` flag with no lifecycle owner; the graph registry rescanned everything on every `internal/plugin` emission; per-request errors and fatal server errors shared one sink that always exited the process. One user-visible defect rode along: the web path never loaded `$DSH_HOME/.env`, so `DSH_HOME=… dsh web` could not find an API key living there.

## Decision

**Composition is one flat assembled tree.** Profile bundles package ownership without nesting the Loader result: Web applies `dsh-base`, then the transport-independent `dsh-gui-app` Host and Client roster, then the `dsh-web-app` carrier rows; the profile and launcher patch layers follow ([profile bundle decision](2026-08-05-profile-plugin-bundles.md)). Every plugin remains one row and every config field remains YAML-editable. The `dsh-client-hmr` row belongs only to the Web surface and stays idle until a rebuild watcher rewrites Client bundles; Electron omits it. Row order carries no load semantics; activation is service-availability driven. The shared audit rejects imports with no fiber, awaits only failed fibers to recover original activation errors, and reports services that leave a fiber `PENDING`; before throwing, it marks those exact rejection reasons through one process checkpoint so `installFailLoud` coalesces Loader's duplicate notification while unrelated unhandled rejections remain fatal. The Node app-boot artifact embeds `@cordisjs/plugin-include` while leaving `@cordisjs/plugin-loader` external, so the include's `EntryTree` and the Host bind to one Loader peer instead of splitting a config tree across two Loader implementations.

**Boot glue has one Host runner and one Client kernel.** `bootProfile` in `dsh-app-boot` holds what every long-lived Host needs before Cordis entries mount: layered env, ordered patch composition, Loader boot, activation audit, user-patch watchers, profile roots, and failure cleanup. CLI and Electron supply their own invocation facts and process lifecycle around that runner. `AppWebEntry` holds the renderer facts that must exist before Client Cordis: it parses `window.__DSH_BOOT__` into a `BootManifest` (two views: npm-package rows for the module table, Cordis-plugin rows for entry composition; malformed wire throws), builds the module system, renders the loading page, prefetches the `immediately` tier in parallel with Context/Loader setup, **awaits the prefetch before creating entries** (materialization is `tree.import`'s synchronous require, unprotected by fiber inject waiting; cross-package require edges such as locale → runtime/client need every immediately-tier factory registered first — an empirically found 10–25% boot race otherwise), adopts the modules entry, creates the graph rows, settles, and sweeps.

**Config sources have one declaration place each.** Bundle yml values are engineering defaults, Settings sections are writable user preferences, CLI flags address their owning launcher rows, and env values enter through yml `!!js` expressions. Patches replace a row's config wholesale. The resolved frontend `distIndex` uses that patch channel as an assembly fact. The transport-independent provider/model default belongs to `ctx.agentDefaultModel`; the [direct headless entry point](2026-08-09-headless-direct-core-entry-point.md) and the Web gateway consume the same state.

**The transport splits five ways.** `dsh-host-apiproxy` is the gateway plugin (`api-gateway` row): it provides `ctx.apiProxy`, remains transport-agnostic, and registers no routes. `dsh-host-webserver` is a plain route-registration plugin: `WebServer` provides `ctx.webServer` (`register(route) → disposer` with duplicate-pattern throw, index transforms applied in registration order, `port`), listens on activation, and knows no Harness concepts. The Connection Host half always provides a transport-neutral Fetch dispatcher and conditionally mounts `/api` plus WebSocket downlinks when `webServer` exists; Electron calls the same dispatcher through IPC. The modules Host half (`ClientModuleRegistry`, providing `ctx.clientModules`) always owns incremental package scanning and graph/path notifications, and conditionally mounts the bundle route and index tap when `webServer` exists. The HMR Host half owns Web-only development reload through stat-poll membership and the `/plugins/events` SSE route.

**Package export discipline.** The modules package exposes exactly `.` (node half) and `./client` (the complete browser half: `ClientModuleSystem`, `parseBootManifest`, the adoption plugin face) — no bespoke subpaths; wire types re-export through the root for host-side consumers. The adoption handshake: the kernel writes the constructed instance to `window.__DSH_MODULES__` before cordis exists; the `./client` apply reads the slot (missing = loud throw) and provides `ctx.modules`.

## Consequences

- Recomposing a web deployment is a yml/patch edit; the retired pieces (`mountWebPlugins`, `CLIENT_PACKAGES`, `createHostWebPluginRegistry`, `startWebServer`, the webserver's graph/SSE/api knowledge) are deleted.
- [Headless is a direct core entry point](2026-08-09-headless-direct-core-entry-point.md): its shipped profile contains the shared base Agent capabilities and omits Host, HTTP, Web, and browser layers. The transport split in this note is the browser surface's contract.
- A TypeScript pitfall worth remembering: a `declare module 'cordis'` augmentation in a file with **no cordis import** is demoted to a standalone module declaration and silently shatters the program-wide `Context` merge (`ctx.on`/`ctx.effect` vanish across the program). Anchor with `import type {} from 'cordis'`.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Dedicated `dsh-host-profile` receiver package | User model state belongs to the Settings-backed `ctx.agentDefaultModel`; an extra Host receiver would duplicate ownership and exclude direct entry points |
| Runtime `assembly` shim plugin providing an `apiHandler` service | Existed only because `createApiProxy` lived in runtime; moving it into apiproxy made the gateway self-hosting, and `toFetchHandler` is a pure function the binding side calls |
| Full-rescan + incremental scan coexisting | Two implementations, two semantics; the single per-package path covers the activation pass too |
| A bespoke `./impl` export on the modules package | Non-uniform exports; the standard `./client` carries the whole browser half |
| dev overlay / `cordis.dev.yml` | One yml; `!!js` cannot conditionalize row existence, and `--dev` appending one row is the entire difference |
| env vars in the mapping table | The same field would gain env/json double sourcing and need an invented precedence |
| Unbarriered create-after-prefetch (`arrive()` dedup as safety) | Disproved by a 10–25% boot race: in-flight dedup covers same-package double-fetch, not cross-package synchronous require edges |
| json file used directly as loader patches | json keys would couple to yml row structure; profile writers would need cordis knowledge |

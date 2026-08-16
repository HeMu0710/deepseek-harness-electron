# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

Wire consumer and Host dispatch layer. The client plugin mounts `ctx.connection` with one shared API client, generic RPC, current-platform loopback state, observable generation-scoped `hostDescription`, and a single-consumer stream-loop starter. A successful readiness handshake publishes the exact `host.describe` value before `onConnected`; generation loss and explicit stop clear it. The renderer selects fixture mode first, the fixed desktop preload bridge second, and the Web carrier otherwise. The Host service dispatches Fetch requests independently of their carrier; the optional Web adapter adds HTTP routes, browser trust checks, and WebSocket downlinks. The export face carries the wire types, `AbstractApiClient`, desktop preload types, and loop sink/config types.

## Desktop preload carrier

Electron preload exposes a frozen, narrow `window.__DSH_DESKTOP__` object implementing the exported `DesktopBridge` interface. `fetch` accepts a structured-clone-safe `DesktopFetchRequest` and returns only `DesktopFetchHead`; response bytes remain Host-owned. Each renderer `ReadableStream` pull invokes exactly one `pull(id)`, with a zero high-water mark, so the Host advances only for pending consumer demand. `AbortSignal` and reader cancellation converge on the idempotent `cancel(id)` operation. A response end releases the id normally; serialized read failures become stream errors. The bridge carries complete request bodies as `Uint8Array`, so its Electron adapter must validate sender ownership and request fields before calling the locally trusted Host entry, and should reuse the Host export `DEFAULT_MAX_REQUEST_BODY_BYTES` for the byte limit.

`DesktopApiClient` and generic `ctx.connection.rpc` share the same bridge-backed Fetch function. Unary calls, responses, and both `events.mux` and `events.host` streams therefore use one carrier; desktop event streams retain the API Proxy SSE framing and pass through the pull protocol. `HostConnectionHandle.fetch(request)` dispatches a dedicated first-path-segment RPC channel, then an owned `/api` interceptor endpoint, then the API Proxy fallback. The Web adapter mounts the same dedicated registrations as prefix routes and retains the existing trust policy; desktop compositions do not need `webServer`.

The browser carrier uses HTTP POST for unary and response operations and opens one downlink-only WebSocket each for `events.mux` and `events.host`. Loopback hostname classification stays package-internal: the `/api` Host fence and WebSocket upgrades use it directly, while other client plugins consume `ctx.connection.isLoopback`. The Web `/api` route pins the privileged method set (`host.pickDirectory`, `host.openPath`, the settings and credentials configuration planes, `llm.discoverModels`, and agent-preset authoring) to loopback; a declared `trustedHosts` authority reaches other methods until a real authentication layer exists. The detailed downlink behavior is documented in the [WebSocket downlink carrier Agent Note](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md).

## /api browser-trust fence

The node half guards every entry under `/api` before bridging or upgrading (`src/api-request-trust.ts`). Every request — browser-marked or not — must present a `Host` that is a loopback authority or matches a `trustedHosts` entry: exact on `host:port` entries, any port on port-less entries, both sides compared through WHATWG normalization (DNS-rebinding defense). There is deliberately no shortcut for unmarked HTTP requests: over plain HTTP a browser attaches neither `Origin` nor Fetch-Metadata to image and navigation reads, so an unmarked request may still be a rebound browser read with a readable response, and Host is the one header rebinding cannot forge; a browser WebSocket handshake carries `Origin` and passes the same comparison. Non-browser clients pass the same fence via loopback, deployment-derived LAN IP literals, or a declared authority. When markers are present, an attached `Origin` must equal the Host authority, and an explicit `sec-fetch-site: cross-site` marker is refused. A `trustedHosts` entry that is not a bare, canonical `host[:port]` authority — one WHATWG parsing reads back exactly as written — fails the plugin load loudly: parsing would otherwise quietly authorize the hostname inside `harness.internal/path`, or broaden a dangling-colon or zero-padded port to an any-port grant. HTTP failures answer plain 403 before any RPC dispatch; upgrade failures reject the handshake before any event stream starts. Non-loopback compositions must trust their serving authorities explicitly: the Web runtime derives LAN IP literals from an all-interfaces server config, while `trustedHosts` in cordis.yml and the CLI's `--trusted-host` flag declare named authorities. `dsh web --host 0.0.0.0` is intentionally unsupported until remote access has an authentication layer. The fence is a reachability policy, not authentication; the Web carrier provides no authentication layer. Decision record: [the api browser-trust boundary Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md).

## `/api` WebSocket downlinks

`/api/events.mux` and `/api/events.host` each accept a WebSocket upgrade and send only the corresponding `ServerRequest` text messages to the browser; the client sends no application data over these sockets. If either socket ends, the current connection generation fails and rebuilds both streams; readiness still requires both sockets to be open and the `host.describe` HTTP call to succeed. Host teardown terminates both sockets, aborts their sources, and waits for source cleanup before returning. Ordinary network GETs to these paths return 426 with no SSE fallback; `toFetchHandler`'s SSE codec serves only the isomorphic in-process carrier.

## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **History resumes an unattached session** — opening history may create the host-side agent and add latency to the first open; there is no persistence-only read path.
- **The `/api` bridge buffers each request body in memory** — `maxRequestBodyBytes` (default 160 MiB, sized for the default 100 MiB aggregate image limit after base64 expansion plus envelope headroom) is therefore also the per-request resident bound; a streaming body path would be needed to lower it without shrinking the image limits.
- **The desktop bridge transfers each request body as one structured-clone value** — the Electron adapter enforces the exported 160 MiB request ceiling; response bodies remain incremental and pull-controlled.

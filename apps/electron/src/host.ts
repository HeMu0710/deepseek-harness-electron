/** Zero-port Harness Host running in Electron's utility process. */

import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  bootProfile,
  loadLayeredEnv,
  type ProfileBootResult,
} from '@deepseek-ai/dsh-app-boot'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import {
  isHostCommand,
  type ClientResource,
  type DesktopFetchHead,
  type DesktopFetchRequest,
  type DesktopSaveRequest,
  type HostCommand,
  type HostEvent,
} from './protocol.ts'
import { saveResponseToFile } from './download.ts'
import { resolveShippedPresetRoot } from './runtime-paths.ts'

const port = process.parentPort

const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
const SHIPPED_PRESET_ROOT = resolveShippedPresetRoot()

/** Runtime guard for required desktop profile services. */
function desktopServices(ctx: Context): {
  modules: ClientModuleRegistry
  connection: HostConnectionHandle
} {
  const modules = ctx.get('clientModules')
  const connection = ctx.get('connection')
  if (modules === undefined || connection === undefined) {
    throw new Error('dsh-desktop profile must provide clientModules and connection')
  }
  return { modules, connection }
}

interface ActiveRequest {
  readonly abort: AbortController
  reader?: ReadableStreamDefaultReader<Uint8Array>
  pulling: boolean
}

const active = new Map<string, ActiveRequest>()
const inFlight = new Set<Promise<void>>()
let appBoot: ProfileBootResult | undefined
let appContext: Context | undefined
let stopping: Promise<void> | undefined

function post(message: HostEvent): void {
  port.postMessage(message)
}

function resources(modules: ClientModuleRegistry): ClientResource[] {
  return modules.graph().entries.flatMap((entry) => {
    const path = modules.clientPath(entry.id)
    return path === undefined
      ? []
      : [{ pathname: new URL(entry.url, 'dsh://app').pathname, path }]
  })
}

function publishGraph(modules: ClientModuleRegistry, type: 'ready' | 'graph'): void {
  post({ type, graph: modules.graph(), resources: resources(modules) })
}

function runRequest(operation: Promise<void>): void {
  const tracked = operation
    .catch((error: unknown) => { console.error(error) })
    .finally(() => { inFlight.delete(tracked) })
  inFlight.add(tracked)
}

async function handleFetch(connection: HostConnectionHandle, request: DesktopFetchRequest): Promise<void> {
  if (active.has(request.id)) {
    post({ type: 'fetch-error', id: request.id, message: 'duplicate desktop request id' })
    return
  }
  const abort = new AbortController()
  const state: ActiveRequest = { abort, pulling: false }
  active.set(request.id, state)
  try {
    const rendererUrl = new URL(request.url)
    const hostUrl = new URL(`${rendererUrl.pathname}${rendererUrl.search}`, 'http://dsh.internal')
    const response = await connection.fetch(new Request(hostUrl, {
      method: request.method,
      headers: request.headers,
      ...request.body === undefined ? {} : { body: new Uint8Array(request.body) },
      signal: abort.signal,
    }))
    if (active.get(request.id) !== state) {
      await response.body?.cancel().catch(() => undefined)
      return
    }
    const head: DesktopFetchHead = {
      id: request.id,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      hasBody: response.body !== null,
    }
    if (response.body === null) active.delete(request.id)
    else state.reader = response.body.getReader()
    post({ type: 'fetch-head', head })
  } catch (error) {
    if (active.get(request.id) !== state) return
    active.delete(request.id)
    post({ type: 'fetch-error', id: request.id, message: String(error) })
  }
}

async function handleSave(connection: HostConnectionHandle, request: DesktopSaveRequest): Promise<void> {
  if (active.has(request.id)) {
    post({ type: 'save-error', id: request.id, message: 'duplicate desktop request id' })
    return
  }
  if (!isAbsolute(request.path)) {
    post({ type: 'save-error', id: request.id, message: 'desktop save path must be absolute' })
    return
  }
  const abort = new AbortController()
  const state: ActiveRequest = { abort, pulling: false }
  active.set(request.id, state)
  try {
    const rendererUrl = new URL(request.url)
    const hostUrl = new URL(`${rendererUrl.pathname}${rendererUrl.search}`, 'http://dsh.internal')
    const response = await connection.fetch(new Request(hostUrl, { signal: abort.signal }))
    const saved = await saveResponseToFile(response, request.path, {
      owns: () => active.get(request.id) === state,
      attach: (reader) => { state.reader = reader },
    })
    if (!saved) return
    active.delete(request.id)
    post({ type: 'save-complete', id: request.id })
  } catch (error) {
    const stillOwned = active.get(request.id) === state
    if (stillOwned) active.delete(request.id)
    if (stillOwned) post({ type: 'save-error', id: request.id, message: String(error) })
  }
}

async function handlePull(id: string): Promise<void> {
  const state = active.get(id)
  if (state?.reader === undefined) {
    post({ type: 'fetch-end', id })
    return
  }
  if (state.pulling) {
    post({ type: 'fetch-error', id, message: 'concurrent desktop response pull' })
    return
  }
  state.pulling = true
  try {
    const item = await state.reader.read()
    if (active.get(id) !== state) return
    if (item.done) {
      active.delete(id)
      post({ type: 'fetch-end', id })
      return
    }
    post({ type: 'fetch-chunk', id, value: item.value })
  } catch (error) {
    if (active.get(id) !== state) return
    active.delete(id)
    post({ type: 'fetch-error', id, message: String(error) })
  } finally {
    state.pulling = false
  }
}

async function cancelRequest(id: string, notify = true): Promise<void> {
  const state = active.get(id)
  if (state !== undefined) {
    active.delete(id)
    state.abort.abort(new Error('desktop request cancelled'))
    await state.reader?.cancel().catch(() => undefined)
  }
  if (notify) post({ type: 'fetch-cancelled', id })
}

async function shutdown(): Promise<void> {
  if (stopping !== undefined) return stopping
  stopping = (async () => {
    await Promise.all([...active.keys()].map(id => cancelRequest(id, false)))
    await Promise.all(inFlight)
    if (appBoot === undefined) await appContext?.fiber.dispose()
    else await appBoot.dispose()
    post({ type: 'stopped' })
    // This entry owns the utility process; defer exit so Electron can deliver the final acknowledgement.
    setImmediate(() => { process.exit(0) })
  })()
  return stopping
}

async function start(): Promise<void> {
  const environment = loadLayeredEnv('dsh-desktop')
  const boot = await bootProfile({
    binName: 'dsh-desktop',
    profile: 'desktop',
    installAnchor: INSTALL_ANCHOR,
    patchFiles: [],
    shippedPresetRoot: SHIPPED_PRESET_ROOT,
    ...process.env.DSH_TELEMETRY_DISABLED === undefined
      ? {}
      : { telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED },
    prepare(ctx) {
      appContext = ctx
      ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    },
  })
  appBoot = boot
  appContext = boot.ctx
  const { modules, connection } = desktopServices(boot.ctx)
  publishGraph(modules, 'ready')
  boot.ctx.effect(
    () => modules.onGraphChanged(() => { publishGraph(modules, 'graph') }),
    'dsh-desktop: publish client graph',
  )
  port.on('message', (event) => {
    if (!isHostCommand(event.data)) {
      post({ type: 'fatal', message: 'desktop Host received an invalid command' })
      return
    }
    const command: HostCommand = event.data
    if (stopping !== undefined) {
      switch (command.type) {
        case 'shutdown': return
        case 'cancel': void cancelRequest(command.id); return
        case 'save': post({ type: 'save-error', id: command.request.id, message: 'desktop Host is stopping' }); return
        case 'fetch': post({ type: 'fetch-error', id: command.request.id, message: 'desktop Host is stopping' }); return
        case 'pull': post({ type: 'fetch-error', id: command.id, message: 'desktop Host is stopping' }); return
        default: command satisfies never
      }
    }
    switch (command.type) {
      case 'fetch':
        runRequest(handleFetch(connection, command.request))
        return
      case 'save':
        runRequest(handleSave(connection, command.request))
        return
      case 'pull':
        runRequest(handlePull(command.id))
        return
      case 'cancel':
        runRequest(cancelRequest(command.id))
        return
      case 'shutdown':
        void shutdown()
        return
      default:
        command satisfies never
    }
  })
}

void start().catch(async (error: unknown) => {
  console.error(error)
  post({ type: 'fatal', message: error instanceof Error ? error.stack ?? error.message : String(error) })
  await shutdown().catch(() => undefined)
})

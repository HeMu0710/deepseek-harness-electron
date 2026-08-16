/** Secure Electron application shell and main-process IPC broker. */

import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
  type UtilityProcess,
  type WebContents,
} from 'electron'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import {
  CANCEL_CHANNEL,
  DESKTOP_INFO_CHANNEL,
  FETCH_CHANNEL,
  PULL_CHANNEL,
  SAVE_DOWNLOAD_CHANNEL,
} from './channels.ts'
import {
  DESKTOP_ORIGIN,
  isDesktopFetchRequest,
  isRequestId,
  type ClientResource,
  type DesktopFetchChunk,
  type DesktopFetchHead,
  type DesktopInfo,
  type HostCommand,
  type HostEvent,
} from './protocol.ts'
import { desktopContentSecurityPolicy, renderDesktopIndex } from './html.ts'
import { desktopResourceHeaders } from './resource.ts'

protocol.registerSchemesAsPrivileged([{
  scheme: 'dsh',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    codeCache: true,
  },
}])

const require = createRequire(import.meta.url)
const DIST_INDEX = require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
const DIST_ROOT = dirname(DIST_INDEX)
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url))
const HOST_ENTRY = fileURLToPath(new URL('./host.js', import.meta.url))
const HOST_START_TIMEOUT_MS = 60_000
const HOST_STOP_TIMEOUT_MS = 2_000
const HOST_KILL_EXIT_TIMEOUT_MS = 2_000
interface PendingRequest {
  readonly sender: WebContents
  readonly resolveHead: (response: DesktopFetchHead) => void
  readonly rejectHead: (error: Error) => void
  headSettled: boolean
  pull?: {
    resolve: (chunk: DesktopFetchChunk) => void
    reject: (error: Error) => void
  }
  cancelling: boolean
  cancelWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }>
}

interface PendingSave {
  readonly sender: WebContents
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

interface HostStopOperation {
  readonly child: UtilityProcess
  readonly acknowledge: () => void
  readonly promise: Promise<void>
}

let host: UtilityProcess | undefined
let window: BrowserWindow | undefined
let graph: WebBootGraph | undefined
let requestedExitCode: 0 | 1 = 0
let applicationStop: Promise<void> | undefined
let applicationFailure: { title: string; error: Error } | undefined
let hostStop: HostStopOperation | undefined
const clientResources = new Map<string, string>()
const pending = new Map<string, PendingRequest>()
const pendingSaves = new Map<string, PendingSave>()

function isAppUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh:' && url.hostname === 'app'
  } catch {
    return false
  }
}

function assertAppSender(event: IpcMainInvokeEvent): void {
  if (window === undefined
    || event.sender !== window.webContents
    || event.senderFrame === null
    || event.senderFrame !== event.sender.mainFrame
    || !isAppUrl(event.senderFrame.url)) {
    throw new Error('dsh-desktop rejected IPC from an untrusted renderer')
  }
}

function staticPath(pathname: string): string | undefined {
  const decoded = decodeURIComponent(pathname)
  const candidate = resolve(DIST_ROOT, `.${decoded}`)
  const local = relative(DIST_ROOT, candidate)
  if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined
  return candidate
}

async function serveApp(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.hostname !== 'app' || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return new Response('not found', { status: 404 })
  }
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname
  try {
    if (pathname === '/index.html') {
      if (graph === undefined) return new Response('desktop Host is not ready', { status: 503 })
      const nonce = randomBytes(18).toString('base64url')
      const csp = desktopContentSecurityPolicy(nonce)
      const html = renderDesktopIndex(await readFile(DIST_INDEX, 'utf8'), graph, nonce)
      return new Response(request.method === 'HEAD' ? null : html, { headers: desktopResourceHeaders(pathname, csp) })
    }
    const pluginPath = clientResources.get(pathname)
    const path = pluginPath ?? staticPath(pathname)
    if (path === undefined) return new Response('not found', { status: 404 })
    const body = await readFile(path)
    return new Response(request.method === 'HEAD' ? null : body, { headers: desktopResourceHeaders(pathname) })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return new Response(code === 'ENOENT' ? 'not found' : 'resource failure', { status: code === 'ENOENT' ? 404 : 500 })
  }
}

function installProtocol(): void {
  protocol.handle('dsh', serveApp)
}

function updateResources(nextGraph: unknown, resources: ClientResource[]): void {
  if (typeof nextGraph !== 'object' || nextGraph === null || !Array.isArray((nextGraph as WebBootGraph).entries)) {
    throw new Error('desktop Host returned an invalid client graph')
  }
  const next = new Map<string, string>()
  for (const resource of resources) {
    if (typeof resource.pathname !== 'string'
      || !resource.pathname.startsWith('/plugins/')
      || typeof resource.path !== 'string'
      || !isAbsolute(resource.path)) {
      throw new Error('desktop Host returned an invalid client resource')
    }
    next.set(resource.pathname, resource.path)
  }
  graph = nextGraph as WebBootGraph
  clientResources.clear()
  for (const [pathname, path] of next) clientResources.set(pathname, path)
}

function failPending(message: string): void {
  for (const request of pending.values()) {
    const error = new Error(message)
    if (!request.headSettled) request.rejectHead(error)
    request.pull?.reject(error)
    for (const waiter of request.cancelWaiters) waiter.reject(error)
  }
  pending.clear()
  for (const save of pendingSaves.values()) save.reject(new Error(message))
  pendingSaves.clear()
}

function handleHostEvent(value: unknown, ready?: (event: Extract<HostEvent, { type: 'ready' }>) => void): void {
  if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string') {
    failPending('desktop Host emitted an invalid event')
    return
  }
  const event = value as HostEvent
  switch (event.type) {
    case 'ready':
      updateResources(event.graph, event.resources)
      ready?.(event)
      return
    case 'graph':
      updateResources(event.graph, event.resources)
      return
    case 'fetch-head': {
      const request = pending.get(event.head.id)
      if (request === undefined || request.headSettled || request.cancelling) return
      request.headSettled = true
      request.resolveHead(event.head)
      if (!event.head.hasBody) pending.delete(event.head.id)
      return
    }
    case 'fetch-chunk': {
      const request = pending.get(event.id)
      const pull = request?.pull
      if (request === undefined || pull === undefined) return
      delete request.pull
      pull.resolve({ type: 'chunk', value: event.value })
      return
    }
    case 'fetch-end': {
      const request = pending.get(event.id)
      request?.pull?.resolve({ type: 'end' })
      if (request !== undefined) delete request.pull
      pending.delete(event.id)
      return
    }
    case 'fetch-error': {
      const request = pending.get(event.id)
      if (request === undefined) return
      if (!request.headSettled) request.rejectHead(new Error(event.message))
      else request.pull?.resolve({ type: 'error', message: event.message })
      delete request.pull
      for (const waiter of request.cancelWaiters) waiter.resolve()
      pending.delete(event.id)
      return
    }
    case 'fetch-cancelled': {
      const request = pending.get(event.id)
      if (request !== undefined) {
        if (!request.headSettled) request.rejectHead(new Error('desktop request cancelled'))
        request.pull?.resolve({ type: 'end' })
        delete request.pull
        for (const waiter of request.cancelWaiters) waiter.resolve()
        pending.delete(event.id)
      }
      const save = pendingSaves.get(event.id)
      save?.reject(new Error('desktop save cancelled'))
      pendingSaves.delete(event.id)
      return
    }
    case 'save-complete': {
      const save = pendingSaves.get(event.id)
      save?.resolve()
      pendingSaves.delete(event.id)
      return
    }
    case 'save-error': {
      const save = pendingSaves.get(event.id)
      save?.reject(new Error(event.message))
      pendingSaves.delete(event.id)
      return
    }
    case 'fatal':
      failPending(event.message)
      if (!isStopping()) {
        void app.whenReady().then(() => {
          const current = window
          if (current !== undefined && !current.isDestroyed()) {
            void current.loadURL(`data:text/plain;charset=utf-8,${encodeURIComponent(`DeepSeek Harness desktop Host failed:\n\n${event.message}`)}`)
          }
        })
      }
      return
    case 'stopped':
      hostStop?.acknowledge()
      return
    default:
      event satisfies never
  }
}

async function startHost(): Promise<void> {
  const child = utilityProcess.fork(HOST_ENTRY, [], {
    serviceName: 'DeepSeek Harness Host',
    stdio: 'pipe',
  })
  host = child
  child.stdout?.pipe(process.stdout)
  child.stderr?.pipe(process.stderr)
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`desktop Host did not become ready within ${String(HOST_START_TIMEOUT_MS)}ms`))
    }, HOST_START_TIMEOUT_MS)
    let settled = false
    child.on('message', (value) => {
      try {
        if (!settled
          && typeof value === 'object'
          && value !== null
          && (value as { type?: unknown }).type === 'fatal') {
          settled = true
          clearTimeout(timeout)
          const message = (value as { message?: unknown }).message
          rejectReady(new Error(`desktop Host failed before ready: ${typeof message === 'string' ? message : 'unknown failure'}`))
        }
        handleHostEvent(value, () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolveReady()
        })
      } catch (error) {
        if (settled) throw error
        settled = true
        clearTimeout(timeout)
        rejectReady(error instanceof Error
          ? error
          : new Error('desktop Host failed before ready', { cause: error }))
      }
    })
    child.once('exit', (code) => {
      if (host === child) host = undefined
      failPending(`desktop Host exited with code ${String(code)}`)
      if (settled) {
        if (!isStopping()) {
          void requestApplicationStop(1, {
            title: 'DeepSeek Harness Host stopped',
            error: new Error(`desktop Host exited unexpectedly with code ${String(code)}`),
          })
        }
        return
      }
      settled = true
      clearTimeout(timeout)
      rejectReady(new Error(`desktop Host exited before ready with code ${String(code)}`))
    })
  })
}

function installIpc(): void {
  ipcMain.handle(FETCH_CHANNEL, async (event, value: unknown): Promise<DesktopFetchHead> => {
    assertAppSender(event)
    if (!isDesktopFetchRequest(value)) throw new Error('invalid desktop fetch request')
    if (host === undefined) throw new Error('desktop Host is unavailable')
    if (pending.has(value.id)) throw new Error('duplicate desktop fetch request id')
    const child = host
    return new Promise<DesktopFetchHead>((resolveHead, rejectHead) => {
      pending.set(value.id, {
        sender: event.sender,
        resolveHead,
        rejectHead,
        headSettled: false,
        cancelling: false,
        cancelWaiters: [],
      })
      const command: HostCommand = { type: 'fetch', request: value }
      child.postMessage(command)
    })
  })
  ipcMain.handle(PULL_CHANNEL, async (event, value: unknown): Promise<DesktopFetchChunk> => {
    assertAppSender(event)
    if (!isRequestId(value)) throw new Error('invalid desktop pull request id')
    const request = pending.get(value)
    if (request === undefined) return { type: 'end' }
    if (request.sender !== event.sender) throw new Error('desktop response belongs to another renderer')
    if (request.cancelling) return { type: 'end' }
    if (request.pull !== undefined) throw new Error('concurrent desktop response pull')
    const child = host
    if (child === undefined) throw new Error('desktop Host is unavailable')
    return new Promise<DesktopFetchChunk>((resolvePull, rejectPull) => {
      request.pull = { resolve: resolvePull, reject: rejectPull }
      child.postMessage({ type: 'pull', id: value } satisfies HostCommand)
    })
  })
  ipcMain.handle(CANCEL_CHANNEL, async (event, value: unknown): Promise<void> => {
    assertAppSender(event)
    if (!isRequestId(value)) throw new Error('invalid desktop cancel request id')
    const request = pending.get(value)
    if (request === undefined) return
    if (request.sender !== event.sender) throw new Error('desktop response belongs to another renderer')
    const child = host
    if (child === undefined) throw new Error('desktop Host is unavailable')
    await new Promise<void>((resolveCancel, rejectCancel) => {
      request.cancelWaiters.push({ resolve: resolveCancel, reject: rejectCancel })
      if (request.cancelling) return
      request.cancelling = true
      child.postMessage({ type: 'cancel', id: value } satisfies HostCommand)
    })
  })
  ipcMain.handle(DESKTOP_INFO_CHANNEL, (event): DesktopInfo => {
    assertAppSender(event)
    return { desktop: true, origin: DESKTOP_ORIGIN }
  })
  ipcMain.handle(SAVE_DOWNLOAD_CHANNEL, async (event, value: unknown): Promise<boolean> => {
    assertAppSender(event)
    if (typeof value !== 'object' || value === null) throw new Error('invalid desktop save request')
    const { url, filename } = value as { url?: unknown; filename?: unknown }
    if (typeof url !== 'string'
      || typeof filename !== 'string'
      || filename.length === 0
      || filename.length > 255
      || filename.includes('/')
      || filename.includes('\\')
      || filename.includes('\0')) throw new Error('invalid desktop save request')
    const parsed = new URL(url)
    if (parsed.protocol !== 'dsh:'
      || parsed.hostname !== 'app'
      || parsed.port !== ''
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/api/session.export'
      || parsed.hash !== '') throw new Error('invalid desktop save URL')
    const currentWindow = window
    const child = host
    if (currentWindow === undefined || child === undefined) throw new Error('desktop Host is unavailable')
    const selected = await dialog.showSaveDialog(currentWindow, {
      defaultPath: filename,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    })
    if (selected.canceled) return false
    const id = randomUUID()
    await new Promise<void>((resolveSave, rejectSave) => {
      pendingSaves.set(id, { sender: event.sender, resolve: resolveSave, reject: rejectSave })
      child.postMessage({
        type: 'save',
        request: { id, url: parsed.href, path: selected.filePath },
      } satisfies HostCommand)
    })
    return true
  })
}

function openExternal(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(parsed.href)
  } catch {
    // Invalid link target: navigation is denied and there is nothing safe to open.
  }
}

async function createWindow(): Promise<void> {
  const nextWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0b0c',
    title: 'DeepSeek Harness',
    webPreferences: {
      preload: PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  })
  window = nextWindow
  const renderer = nextWindow.webContents
  renderer.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  renderer.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternal(url)
  })
  renderer.on('will-attach-webview', (event) => { event.preventDefault() })
  nextWindow.once('ready-to-show', () => { nextWindow.show() })
  nextWindow.on('closed', () => {
    if (window === nextWindow) window = undefined
    for (const [id, request] of pending) {
      if (request.sender !== renderer) continue
      host?.postMessage({ type: 'cancel', id } satisfies HostCommand)
    }
    for (const [id, save] of pendingSaves) {
      if (save.sender !== renderer) continue
      host?.postMessage({ type: 'cancel', id } satisfies HostCommand)
    }
  })
  await nextWindow.loadURL(`${DESKTOP_ORIGIN}/`)
}

async function stopHost(): Promise<void> {
  const child = host
  if (child === undefined) return
  const current = hostStop
  if (current?.child === child) return current.promise

  const deadline = Date.now() + HOST_STOP_TIMEOUT_MS
  let acknowledge!: () => void
  type HostAcknowledged = { type: 'acknowledged' }
  type HostExited = { type: 'exited'; code: number }
  type HostStopSignal = HostAcknowledged | HostExited
  const acknowledged = new Promise<HostAcknowledged>((resolveAcknowledged) => {
    acknowledge = () => { resolveAcknowledged({ type: 'acknowledged' }) }
  })
  const exited = new Promise<HostExited>((resolveExited) => {
    child.once('exit', (code) => { resolveExited({ type: 'exited', code }) })
  })
  const until = async <T extends HostStopSignal>(
    tasks: readonly Promise<T>[],
    target: number,
  ): Promise<T | 'timeout'> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<'timeout'>((resolveTimeout) => {
        timer = setTimeout(() => { resolveTimeout('timeout') }, Math.max(0, target - Date.now()))
      })
      return await Promise.race([...tasks, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const promise = (async () => {
    child.postMessage({ type: 'shutdown' } satisfies HostCommand)
    const outcome = await until<HostStopSignal>([acknowledged, exited], deadline)
    if (outcome !== 'timeout' && outcome.type === 'exited') {
      if (outcome.code === 0) return
      throw new Error(`desktop Host exited during shutdown with code ${String(outcome.code)}`)
    }
    if (outcome !== 'timeout') {
      const graceful = await until([exited], deadline)
      if (graceful !== 'timeout') {
        if (graceful.code === 0) return
        throw new Error(`desktop Host exited during shutdown with code ${String(graceful.code)}`)
      }
      child.kill()
      const killed = await until([exited], Date.now() + HOST_KILL_EXIT_TIMEOUT_MS)
      if (killed === 'timeout') throw new Error('desktop Host did not exit after forced termination')
      return
    }
    child.kill()
    const killed = await until([exited], Date.now() + HOST_KILL_EXIT_TIMEOUT_MS)
    if (killed === 'timeout') throw new Error('desktop Host did not exit after forced termination')
    throw new Error('desktop Host did not acknowledge cleanup before forced termination')
  })().finally(() => {
    if (hostStop?.promise === promise) hostStop = undefined
  })
  hostStop = { child, acknowledge, promise }
  return promise
}

function isStopping(): boolean {
  return applicationStop !== undefined
}

function requestApplicationStop(
  exitCode: 0 | 1,
  failure?: { title: string; error: Error },
): Promise<void> {
  if (exitCode > requestedExitCode) requestedExitCode = exitCode
  if (failure !== undefined) {
    console.error(failure.error)
    applicationFailure ??= failure
  }
  applicationStop ??= (async () => {
    try {
      await stopHost()
    } catch (error) {
      requestedExitCode = 1
      console.error(new Error('DeepSeek Harness desktop Host cleanup failed', { cause: error }))
    }
    const recordedFailure = applicationFailure
    if (recordedFailure !== undefined) {
      try {
        if (app.isReady()) dialog.showErrorBox(recordedFailure.title, recordedFailure.error.message)
      } catch (dialogError) {
        console.error(new Error('DeepSeek Harness desktop failure dialog failed', { cause: dialogError }))
      }
    }
    app.exit(requestedExitCode)
  })()
  return applicationStop
}

async function startApplication(): Promise<void> {
  await app.whenReady()
  if (isStopping()) return
  installProtocol()
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })
  session.defaultSession.setPermissionCheckHandler(() => false)
  installIpc()
  await startHost()
  if (isStopping()) {
    await stopHost()
    return
  }
  await createWindow()
}

function failApplicationStartup(error: unknown): void {
  if (isStopping()) return
  const failure = error instanceof Error
    ? error
    : new Error('DeepSeek Harness desktop startup failed', { cause: error })
  void requestApplicationStop(1, { title: 'DeepSeek Harness failed to start', error: failure })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', (event) => {
    event.preventDefault()
    void requestApplicationStop(0)
  })
  void startApplication().catch(failApplicationStartup)
}

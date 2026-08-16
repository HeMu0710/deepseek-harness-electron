/** Main-process quit and startup-failure lifecycle without real Electron processes. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FETCH_CHANNEL } from '../src/channels.ts'

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  const appListeners = new Map<string, Listener[]>()
  const childListeners = new Map<string, Listener[]>()
  const childOnceListeners = new Map<string, Listener[]>()
  const ipcHandlers = new Map<string, unknown>()
  const windowListeners = new Map<string, Listener[]>()

  function addListener(registry: Map<string, Listener[]>, event: string, listener: Listener): void {
    const listeners = registry.get(event) ?? []
    listeners.push(listener)
    registry.set(event, listeners)
  }

  const child = {
    stdout: undefined,
    stderr: undefined,
    on: vi.fn((event: string, listener: Listener) => {
      addListener(childListeners, event, listener)
      return child
    }),
    once: vi.fn((event: string, listener: Listener) => {
      addListener(childOnceListeners, event, listener)
      return child
    }),
    postMessage: vi.fn((_message: unknown): void => undefined),
    kill: vi.fn((): boolean => true),
    emit(event: string, ...args: unknown[]): void {
      for (const listener of childListeners.get(event) ?? []) listener(...args)
      const once = childOnceListeners.get(event) ?? []
      childOnceListeners.delete(event)
      for (const listener of once) listener(...args)
    },
  }

  const mainFrame = { url: 'dsh://app/' }
  const webContents = {
    mainFrame,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
  }
  let windowDestroyed = false
  const desktopWindow = {
    get webContents(): typeof webContents {
      if (windowDestroyed) throw new TypeError('Object has been destroyed')
      return webContents
    },
    once: vi.fn((event: string, listener: Listener) => {
      addListener(windowListeners, event, listener)
      return desktopWindow
    }),
    on: vi.fn((event: string, listener: Listener) => {
      addListener(windowListeners, event, listener)
      return desktopWindow
    }),
    loadURL: vi.fn(() => Promise.resolve()),
    show: vi.fn(),
    focus: vi.fn(),
    isMinimized: vi.fn((): boolean => false),
    restore: vi.fn(),
    isDestroyed: vi.fn((): boolean => windowDestroyed),
  }
  const BrowserWindow = vi.fn(function BrowserWindow(): typeof desktopWindow {
    return desktopWindow
  })

  const app = {
    isPackaged: false,
    requestSingleInstanceLock: vi.fn((): boolean => true),
    on: vi.fn((event: string, listener: Listener) => {
      addListener(appListeners, event, listener)
      return app
    }),
    quit: vi.fn(),
    exit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn((): boolean => true),
  }
  const dialog = {
    showErrorBox: vi.fn(),
    showSaveDialog: vi.fn(),
  }
  const ipcMain = {
    handle: vi.fn((channel: string, handler: unknown): void => { ipcHandlers.set(channel, handler) }),
  }
  const protocol = {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  }
  const session = {
    defaultSession: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    },
  }
  const shell = { openExternal: vi.fn() }
  const utilityProcess = { fork: vi.fn(() => child) }

  function emitApp(event: string, ...args: unknown[]): void {
    for (const listener of appListeners.get(event) ?? []) listener(...args)
  }

  function emitWindow(event: string, ...args: unknown[]): void {
    if (event === 'closed') windowDestroyed = true
    for (const listener of windowListeners.get(event) ?? []) listener(...args)
  }

  function invokeIpc(channel: string, event: unknown, value: unknown): unknown {
    const handler = ipcHandlers.get(channel)
    if (typeof handler !== 'function') throw new Error(`missing IPC handler: ${channel}`)
    return (handler as (ipcEvent: unknown, ipcValue: unknown) => unknown)(event, value)
  }

  function reset(): void {
    appListeners.clear()
    childListeners.clear()
    childOnceListeners.clear()
    ipcHandlers.clear()
    windowListeners.clear()
    windowDestroyed = false
    for (const mock of [
      child.on,
      child.once,
      child.postMessage,
      child.kill,
      webContents.setWindowOpenHandler,
      webContents.on,
      desktopWindow.once,
      desktopWindow.on,
      desktopWindow.loadURL,
      desktopWindow.show,
      desktopWindow.focus,
      desktopWindow.isMinimized,
      desktopWindow.restore,
      desktopWindow.isDestroyed,
      BrowserWindow,
      app.requestSingleInstanceLock,
      app.on,
      app.quit,
      app.exit,
      app.whenReady,
      app.isReady,
      dialog.showErrorBox,
      dialog.showSaveDialog,
      ipcMain.handle,
      protocol.registerSchemesAsPrivileged,
      protocol.handle,
      session.defaultSession.setPermissionRequestHandler,
      session.defaultSession.setPermissionCheckHandler,
      shell.openExternal,
      utilityProcess.fork,
    ]) mock.mockClear()
  }

  return {
    app,
    BrowserWindow,
    child,
    desktopWindow,
    dialog,
    emitApp,
    emitWindow,
    invokeIpc,
    ipcMain,
    mainFrame,
    protocol,
    reset,
    session,
    shell,
    utilityProcess,
    webContents,
  }
})

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return Object.assign({}, actual, {
    createRequire: (filename: string | URL): NodeJS.Require => {
      const real = actual.createRequire(filename)
      const wrapped = ((id: string): unknown => real(id)) as NodeJS.Require
      Object.assign(wrapped, real)
      const resolve = (id: string, options?: NodeJS.RequireResolveOptions): string => id === '@deepseek-ai/dsh-web-frontend/dist/index.html'
        ? '/private/tmp/dsh-electron-lifecycle/index.html'
        : real.resolve(id, options)
      resolve.paths = (id: string): string[] | null => real.resolve.paths(id)
      wrapped.resolve = resolve
      return wrapped
    },
  })
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  dialog: electron.dialog,
  ipcMain: electron.ipcMain,
  protocol: electron.protocol,
  session: electron.session,
  shell: electron.shell,
  utilityProcess: electron.utilityProcess,
}))

beforeEach(() => {
  electron.reset()
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function importStartedMain(): Promise<void> {
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(electron.utilityProcess.fork).toHaveBeenCalledOnce() })
}

async function emitReady(): Promise<void> {
  electron.child.emit('message', {
    type: 'ready',
    graph: { rev: 'ready', entries: [] },
    resources: [],
  })
  await vi.waitFor(() => { expect(electron.desktopWindow.loadURL).toHaveBeenCalledOnce() })
}

describe('desktop main lifecycle', () => {
  it('forks the Host without unpackaged-only Node arguments', async () => {
    await importStartedMain()
    expect(electron.utilityProcess.fork).toHaveBeenCalledWith(expect.any(String), [], {
      serviceName: 'DeepSeek Harness Host',
      stdio: 'pipe',
    })
  })

  it('single-flights repeated quit requests and lets an acknowledged Host exit naturally', async () => {
    await importStartedMain()
    await emitReady()
    const firstPreventDefault = vi.fn()
    const secondPreventDefault = vi.fn()

    electron.emitApp('before-quit', { preventDefault: firstPreventDefault })
    electron.emitApp('before-quit', { preventDefault: secondPreventDefault })

    expect(firstPreventDefault).toHaveBeenCalledOnce()
    expect(secondPreventDefault).toHaveBeenCalledOnce()
    expect(electron.child.postMessage).toHaveBeenCalledTimes(1)
    expect(electron.child.postMessage).toHaveBeenCalledWith({ type: 'shutdown' })

    electron.child.emit('message', { type: 'stopped' })
    await Promise.resolve()
    expect(electron.child.kill).not.toHaveBeenCalled()
    expect(electron.app.exit).not.toHaveBeenCalled()

    electron.child.emit('exit', 0)
    await vi.waitFor(() => { expect(electron.app.exit).toHaveBeenCalledWith(0) })
    expect(electron.child.postMessage).toHaveBeenCalledTimes(1)
  })

  it('cancels pending requests after the application window is destroyed', async () => {
    await importStartedMain()
    await emitReady()
    const head = electron.invokeIpc(
      FETCH_CHANNEL,
      { sender: electron.webContents, senderFrame: electron.mainFrame },
      { id: 'closing', url: 'dsh://app/api/events.mux', method: 'GET', headers: [] },
    ) as Promise<unknown>

    expect(() => { electron.emitWindow('closed') }).not.toThrow()
    expect(electron.child.postMessage).toHaveBeenCalledWith({ type: 'cancel', id: 'closing' })
    electron.emitApp('second-instance')
    expect(electron.desktopWindow.isMinimized).not.toHaveBeenCalled()

    electron.child.emit('message', { type: 'fetch-cancelled', id: 'closing' })
    await expect(head).rejects.toThrow('desktop request cancelled')
  })

  it('fails when graceful shutdown reaches its deadline without a cleanup acknowledgement', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await importStartedMain()
    await emitReady()
    vi.useFakeTimers()
    try {
      electron.emitApp('before-quit', { preventDefault: vi.fn() })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(electron.child.kill).toHaveBeenCalledOnce()
      expect(electron.app.exit).not.toHaveBeenCalled()
      electron.child.emit('exit', 0)
      await vi.waitFor(() => { expect(electron.app.exit).toHaveBeenCalledWith(1) })
      expect(consoleError).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('exits with failure when the Host survives forced termination', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await importStartedMain()
    await emitReady()
    vi.useFakeTimers()
    try {
      electron.emitApp('before-quit', { preventDefault: vi.fn() })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(electron.child.kill).toHaveBeenCalledOnce()
      expect(electron.app.exit).toHaveBeenCalledWith(1)
      expect(consoleError).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an intentional quit before Host readiness on the successful exit path', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await importStartedMain()

    electron.emitApp('before-quit', { preventDefault: vi.fn() })
    expect(electron.child.postMessage).toHaveBeenCalledWith({ type: 'shutdown' })
    electron.child.emit('exit', 0)

    await vi.waitFor(() => { expect(electron.app.exit).toHaveBeenCalledWith(0) })
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('fails an intentional quit when the Host exits nonzero before acknowledging cleanup', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await importStartedMain()

    electron.emitApp('before-quit', { preventDefault: vi.fn() })
    electron.child.emit('exit', 7)

    await vi.waitFor(() => { expect(electron.app.exit).toHaveBeenCalledWith(1) })
    expect(consoleError).toHaveBeenCalled()
  })

  it('treats an unexpected Host exit after readiness as application failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await importStartedMain()
    await emitReady()

    electron.child.emit('exit', 7)

    await vi.waitFor(() => { expect(electron.app.exit).toHaveBeenCalledWith(1) })
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'DeepSeek Harness Host stopped',
      'desktop Host exited unexpectedly with code 7',
    )
    expect(consoleError).toHaveBeenCalled()
  })

  it('accepts forced process termination after the Host acknowledges cleanup', async () => {
    await importStartedMain()
    await emitReady()
    vi.useFakeTimers()
    try {
      electron.emitApp('before-quit', { preventDefault: vi.fn() })
      electron.child.emit('message', { type: 'stopped' })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(electron.child.kill).toHaveBeenCalledOnce()
      expect(electron.app.exit).not.toHaveBeenCalled()
      electron.child.emit('exit', 1)
      await vi.waitFor(() => { expect(electron.app.exit).toHaveBeenCalledWith(0) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails an acknowledged stop when the Host survives forced termination', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await importStartedMain()
    await emitReady()
    vi.useFakeTimers()
    try {
      electron.emitApp('before-quit', { preventDefault: vi.fn() })
      electron.child.emit('message', { type: 'stopped' })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(electron.child.kill).toHaveBeenCalledOnce()
      expect(electron.app.exit).toHaveBeenCalledWith(1)
      expect(consoleError).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('exits with failure when the utility Host reports fatal before ready', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await importStartedMain()

    electron.child.emit('message', { type: 'fatal', message: 'boot failed' })
    await vi.waitFor(() => {
      expect(electron.child.postMessage).toHaveBeenCalledWith({ type: 'shutdown' })
    })
    expect(electron.desktopWindow.loadURL).not.toHaveBeenCalled()
    expect(electron.app.exit).not.toHaveBeenCalled()

    electron.child.emit('exit', 1)
    await vi.waitFor(() => { expect(electron.app.exit).toHaveBeenCalledWith(1) })
    expect(consoleError).toHaveBeenCalled()
  })
})

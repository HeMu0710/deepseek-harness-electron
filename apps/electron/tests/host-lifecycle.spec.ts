/** Utility-Host request drain and shutdown lifecycle without a real Electron process. */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

const host = vi.hoisted(() => {
  type MessageListener = (event: { data: unknown }) => void

  let listener: MessageListener | undefined
  const connection = {
    fetch: vi.fn((_request: Request): Promise<Response> => Promise.reject(new Error('unexpected fetch'))),
  }
  const modules = {
    graph: vi.fn(() => ({ rev: 'test', entries: [] })),
    clientPath: vi.fn(),
    onGraphChanged: vi.fn(() => (): void => undefined),
  }
  const context = {
    get: vi.fn((name: string): unknown => name === 'clientModules'
      ? modules
      : name === 'connection' ? connection : undefined),
    provide: vi.fn(),
    effect: vi.fn((register: () => unknown): unknown => register()),
    fiber: { dispose: vi.fn(async (): Promise<void> => undefined) },
  }
  const boot = {
    ctx: context,
    dispose: vi.fn(async (): Promise<void> => undefined),
  }
  const bootProfile = vi.fn(async (options: { prepare(ctx: typeof context): void }) => {
    options.prepare(context)
    return boot
  })
  const saveResponseToFile = vi.fn(
    (_response: Response, _path: string, _ownership: unknown): Promise<boolean> => Promise.resolve(false),
  )
  const port = {
    on: vi.fn((event: string, next: MessageListener): void => {
      if (event === 'message') listener = next
    }),
    postMessage: vi.fn((_message: unknown): void => undefined),
  }

  function emit(data: unknown): void {
    if (listener === undefined) throw new Error('Host message listener is not installed')
    listener({ data })
  }

  function reset(): void {
    listener = undefined
    for (const mock of [
      connection.fetch,
      modules.graph,
      modules.clientPath,
      modules.onGraphChanged,
      context.get,
      context.provide,
      context.effect,
      context.fiber.dispose,
      boot.dispose,
      bootProfile,
      saveResponseToFile,
      port.on,
      port.postMessage,
    ]) mock.mockClear()
    connection.fetch.mockReset()
    saveResponseToFile.mockReset()
  }

  return {
    boot,
    bootProfile,
    connection,
    emit,
    port,
    reset,
    saveResponseToFile,
  }
})

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  bootProfile: host.bootProfile,
  loadLayeredEnv: vi.fn(() => ({})),
}))

vi.mock('@deepseek-ai/dsh-launch-environment', () => ({
  DSH_LAUNCH_ENVIRONMENT_KEY: 'test-launch-environment',
}))

vi.mock('../src/download.ts', () => ({
  saveResponseToFile: host.saveResponseToFile,
}))

vi.mock('../src/runtime-paths.ts', () => ({
  resolveShippedPresetRoot: vi.fn(() => '/private/tmp/dsh-electron-presets'),
}))

const parentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort')

beforeEach(() => {
  host.reset()
  vi.resetModules()
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: host.port,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (parentPortDescriptor === undefined) Reflect.deleteProperty(process, 'parentPort')
  else Object.defineProperty(process, 'parentPort', parentPortDescriptor)
})

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

async function startHost(): Promise<MockInstance<typeof process.exit>> {
  const exit = vi.spyOn(process, 'exit').mockImplementation(_code => undefined as never)
  await import('../src/host.ts')
  await vi.waitFor(() => {
    expect(host.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
  })
  host.port.postMessage.mockClear()
  return exit
}

function fetchCommand(id: string): unknown {
  return {
    type: 'fetch',
    request: {
      id,
      url: 'dsh://app/api/test',
      method: 'GET',
      headers: [],
    },
  }
}

async function expectStopped(exit: MockInstance<typeof process.exit>): Promise<void> {
  await vi.waitFor(() => {
    expect(host.boot.dispose).toHaveBeenCalledOnce()
    expect(host.port.postMessage).toHaveBeenCalledWith({ type: 'stopped' })
    expect(exit).toHaveBeenCalledWith(0)
  })
}

describe('desktop utility Host lifecycle', () => {
  it('waits for an aborted fetch handler and single-flights repeated shutdown commands', async () => {
    const response = deferred<Response>()
    host.connection.fetch.mockReturnValue(response.promise)
    const exit = await startHost()

    host.emit(fetchCommand('fetch-1'))
    await vi.waitFor(() => { expect(host.connection.fetch).toHaveBeenCalledOnce() })
    const request = host.connection.fetch.mock.calls[0]?.[0] as Request

    host.emit({ type: 'shutdown' })
    host.emit({ type: 'shutdown' })
    await vi.waitFor(() => { expect(request.signal.aborted).toBe(true) })
    expect(host.boot.dispose).not.toHaveBeenCalled()
    expect(host.port.postMessage).not.toHaveBeenCalledWith({ type: 'stopped' })
    expect(exit).not.toHaveBeenCalled()

    response.resolve(new Response(null, { status: 204 }))
    await expectStopped(exit)
    expect(host.boot.dispose).toHaveBeenCalledOnce()
    expect(host.port.postMessage.mock.calls.filter(([event]) => typeof event === 'object'
      && event !== null
      && 'type' in event
      && event.type === 'stopped')).toHaveLength(1)
    expect(exit).toHaveBeenCalledOnce()
  })

  it('waits for save cleanup after cancelling the active download', async () => {
    const saved = deferred<boolean>()
    host.connection.fetch.mockResolvedValue(new Response('archive'))
    host.saveResponseToFile.mockReturnValue(saved.promise)
    const exit = await startHost()

    host.emit({
      type: 'save',
      request: {
        id: 'save-1',
        url: 'dsh://app/api/session.export',
        path: '/private/tmp/session.zip',
      },
    })
    await vi.waitFor(() => { expect(host.saveResponseToFile).toHaveBeenCalledOnce() })
    host.emit({ type: 'shutdown' })
    await Promise.resolve()
    expect(host.boot.dispose).not.toHaveBeenCalled()

    saved.resolve(false)
    await expectStopped(exit)
  })

  it('waits for an outstanding response pull after cancelling its reader', async () => {
    const pulled = deferred<ReadableStreamReadResult<Uint8Array>>()
    const reader = {
      read: vi.fn(() => pulled.promise),
      cancel: vi.fn(async (): Promise<void> => undefined),
    }
    host.connection.fetch.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: {
        cancel: vi.fn(async (): Promise<void> => undefined),
        getReader: () => reader,
      },
    } as unknown as Response)
    const exit = await startHost()

    host.emit(fetchCommand('pull-1'))
    await vi.waitFor(() => {
      expect(host.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'fetch-head',
      }))
    })
    host.emit({ type: 'pull', id: 'pull-1' })
    await vi.waitFor(() => { expect(reader.read).toHaveBeenCalledOnce() })
    host.emit({ type: 'shutdown' })
    await vi.waitFor(() => { expect(reader.cancel).toHaveBeenCalledOnce() })
    expect(host.boot.dispose).not.toHaveBeenCalled()

    pulled.resolve({ done: true, value: undefined })
    await expectStopped(exit)
  })

  it('waits for a cancellation already in progress when shutdown begins', async () => {
    const cancelled = deferred<undefined>()
    const reader = {
      read: vi.fn(),
      cancel: vi.fn(() => cancelled.promise),
    }
    host.connection.fetch.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: {
        cancel: vi.fn(async (): Promise<void> => undefined),
        getReader: () => reader,
      },
    } as unknown as Response)
    const exit = await startHost()

    host.emit(fetchCommand('cancel-1'))
    await vi.waitFor(() => {
      expect(host.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'fetch-head' }))
    })
    host.emit({ type: 'cancel', id: 'cancel-1' })
    await vi.waitFor(() => { expect(reader.cancel).toHaveBeenCalledOnce() })
    host.emit({ type: 'shutdown' })
    await Promise.resolve()
    expect(host.boot.dispose).not.toHaveBeenCalled()

    cancelled.resolve(undefined)
    await expectStopped(exit)
  })
})

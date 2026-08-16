/** Desktop preload carrier serialization, pull backpressure, and SSE coverage. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopFetch,
  desktopBridgeFromGlobal,
  DesktopApiClient,
  type DesktopBridge,
  type DesktopFetchChunk,
  type DesktopFetchHead,
  type DesktopFetchRequest,
  type DesktopRequestId,
} from '../src/client/desktop-api-client.ts'
import { createConnectionRpc } from '../src/client/rpc.ts'

const encoder = new TextEncoder()
type DesktopGlobal = { __DSH_DESKTOP__?: unknown }

afterEach(() => {
  delete (globalThis as DesktopGlobal).__DSH_DESKTOP__
})

class QueueBridge implements DesktopBridge {
  readonly requests: DesktopFetchRequest[] = []
  readonly pulls: DesktopRequestId[] = []
  readonly cancellations: DesktopRequestId[] = []
  private readonly bodies = new Map<DesktopRequestId, Uint8Array[]>()

  /** @param responseBody - returns the body chunks for one serialized request. */
  constructor(private readonly responseBody: (request: DesktopFetchRequest) => string[]) {}

  async fetch(request: DesktopFetchRequest): Promise<DesktopFetchHead> {
    this.requests.push(request)
    this.bodies.set(request.id, this.responseBody(request).map(value => encoder.encode(value)))
    return {
      id: request.id,
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/json']],
      hasBody: true,
    }
  }

  async pull(id: DesktopRequestId): Promise<DesktopFetchChunk> {
    this.pulls.push(id)
    const body = this.bodies.get(id)
    const value = body?.shift()
    if (value !== undefined) return { type: 'chunk', value }
    this.bodies.delete(id)
    return { type: 'end' }
  }

  async cancel(id: DesktopRequestId): Promise<void> {
    this.cancellations.push(id)
    this.bodies.delete(id)
  }
}

describe('desktop API client carrier', () => {
  it('accepts only the fixed preload global with all three bridge operations', () => {
    expect(desktopBridgeFromGlobal()).toBeUndefined()
    for (const value of [42, null]) {
      ;(globalThis as DesktopGlobal).__DSH_DESKTOP__ = value
      expect(() => desktopBridgeFromGlobal()).toThrow('must be an object')
    }
    const fetch = async (): Promise<never> => { throw new Error('unused') }
    const pull = async (): Promise<never> => { throw new Error('unused') }
    for (const value of [{}, { fetch }, { fetch, pull }]) {
      ;(globalThis as DesktopGlobal).__DSH_DESKTOP__ = value
      expect(() => desktopBridgeFromGlobal()).toThrow('must provide fetch, pull, and cancel')
    }
    const bridge = { fetch, pull, cancel: async () => undefined }
    ;(globalThis as DesktopGlobal).__DSH_DESKTOP__ = bridge
    expect(desktopBridgeFromGlobal()).toBe(bridge)
  })

  it('serializes a request and advances the Host body once per renderer pull', async () => {
    const bridge = new QueueBridge(() => ['first', 'second'])
    const fetch = createDesktopFetch(bridge)
    const response = await fetch(new URL('dsh://app/api/echo'), {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-test': 'desktop' },
      body: 'payload',
    })
    expect(bridge.requests[0]).toMatchObject({
      url: 'dsh://app/api/echo',
      method: 'POST',
      body: encoder.encode('payload'),
    })
    expect(bridge.requests[0]?.headers).toEqual([
      ['content-type', 'text/plain'],
      ['x-test', 'desktop'],
    ])
    expect(bridge.pulls).toHaveLength(0)

    const reader = response.body!.getReader()
    await expect(reader.read()).resolves.toEqual({ done: false, value: encoder.encode('first') })
    expect(bridge.pulls).toHaveLength(1)
    await expect(reader.read()).resolves.toEqual({ done: false, value: encoder.encode('second') })
    expect(bridge.pulls).toHaveLength(2)
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    expect(bridge.pulls).toHaveLength(3)
    expect(bridge.cancellations).toHaveLength(0)
  })

  it('converges AbortSignal and reader cancellation on one remote request id', async () => {
    let releasePull: ((chunk: DesktopFetchChunk) => void) | undefined
    const cancel = vi.fn<DesktopBridge['cancel']>().mockResolvedValue(undefined)
    const bridge: DesktopBridge = {
      fetch: async request => ({
        id: request.id,
        status: 200,
        statusText: 'OK',
        headers: [],
        hasBody: true,
      }),
      pull: () => new Promise((resolve) => { releasePull = resolve }),
      cancel,
    }
    const abort = new AbortController()
    const response = await createDesktopFetch(bridge)(new URL('dsh://app/api/events.mux'), {
      signal: abort.signal,
    })
    const reader = response.body!.getReader()
    const pending = reader.read()
    await vi.waitFor(() => { expect(releasePull).toBeTypeOf('function') })
    abort.abort(new Error('renderer stopped'))
    await expect(pending).rejects.toThrow('renderer stopped')
    await vi.waitFor(() => { expect(cancel).toHaveBeenCalledTimes(1) })
    await reader.cancel().catch(() => undefined)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('serializes every supported request-body representation and method', async () => {
    const bridge = new QueueBridge(() => [])
    const fetch = createDesktopFetch(bridge)
    const arrayBuffer = Uint8Array.from([1, 2]).buffer
    const cases: Array<{ body: BodyInit; bytes: Uint8Array }> = [
      { body: new URLSearchParams({ key: 'value' }), bytes: encoder.encode('key=value') },
      { body: arrayBuffer, bytes: Uint8Array.from([1, 2]) },
      { body: Uint8Array.from([3, 4]), bytes: Uint8Array.from([3, 4]) },
    ]
    for (const item of cases) {
      const response = await fetch(new URL('dsh://app/api/body'), { method: 'post', body: item.body })
      expect(bridge.requests.at(-1)).toMatchObject({ method: 'POST', body: item.bytes })
      await response.body!.cancel()
    }
    for (const [expectedMethod, init] of [
      ['HEAD', { method: 'head' }],
      ['GET', { method: 'GET', body: null }],
    ] as const) {
      const response = await fetch(new URL('dsh://app/api/body'), init)
      expect(bridge.requests.at(-1)).toMatchObject({ method: expectedMethod })
      expect(bridge.requests.at(-1)).not.toHaveProperty('body')
      await response.body!.cancel()
    }
    await expect(fetch(new URL('dsh://app/api/body'), { method: 'GET', body: 'invalid' }))
      .rejects.toThrow('Request with GET method cannot have body')
  })

  it('returns bodyless responses without retaining abort or pull ownership', async () => {
    const pull = vi.fn<DesktopBridge['pull']>()
    const cancel = vi.fn<DesktopBridge['cancel']>().mockResolvedValue(undefined)
    const bridge: DesktopBridge = {
      fetch: async request => ({
        id: request.id,
        status: 204,
        statusText: 'No Content',
        headers: [['x-result', 'empty']],
        hasBody: false,
      }),
      pull,
      cancel,
    }
    const abort = new AbortController()
    const response = await createDesktopFetch(bridge)(new URL('dsh://app/api/empty'), {
      signal: abort.signal,
    })
    abort.abort()
    expect(response.status).toBe(204)
    expect(response.headers.get('x-result')).toBe('empty')
    expect(response.body).toBeNull()
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancels every non-OK API, SSE, and generic RPC body without pulling it', async () => {
    const pull = vi.fn<DesktopBridge['pull']>()
    const cancel = vi.fn<DesktopBridge['cancel']>().mockResolvedValue(undefined)
    const bridge: DesktopBridge = {
      fetch: async request => ({
        id: request.id,
        status: 404,
        statusText: 'Not Found',
        headers: [],
        hasBody: true,
      }),
      pull,
      cancel,
    }
    const fetch = createDesktopFetch(bridge)
    const api = new DesktopApiClient(fetch)

    await expect(api.sessions.list({})).rejects.toThrow('HTTP 404')
    const events = api.events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(events.next()).rejects.toThrow('HTTP 404')
    await expect(createConnectionRpc(fetch).call('/api', 'goals/create', {})).rejects.toThrow('HTTP 404')

    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(3)
  })

  it('rejects pre-aborted requests without crossing preload', async () => {
    const bridge = new QueueBridge(() => [])
    for (const reason of ['string abort', 42]) {
      const abort = new AbortController()
      abort.abort(reason)
      await expect(createDesktopFetch(bridge)(new URL('dsh://app/api/test'), { signal: abort.signal }))
        .rejects.toThrow(reason === 'string abort' ? reason : 'This operation was aborted')
    }
    expect(bridge.requests).toHaveLength(0)
  })

  it('contains preload failures while preserving the caller abort reason', async () => {
    const cancel = vi.fn<DesktopBridge['cancel']>().mockRejectedValue(new Error('cancel failed'))
    const failedFetch: DesktopBridge = {
      fetch: async () => { throw new Error('fetch failed') },
      pull: async () => ({ type: 'end' }),
      cancel,
    }
    await expect(createDesktopFetch(failedFetch)(new URL('dsh://app/api/test')))
      .rejects.toThrow('fetch failed')

    const abort = new AbortController()
    const bridge: DesktopBridge = {
      fetch: async request => ({
        id: request.id,
        status: 200,
        statusText: 'OK',
        headers: [],
        hasBody: true,
      }),
      pull: async () => new Promise<DesktopFetchChunk>(() => undefined),
      cancel,
    }
    const response = await createDesktopFetch(bridge)(new URL('dsh://app/api/events.mux'), {
      signal: abort.signal,
    })
    abort.abort('late abort')
    await expect(response.body!.getReader().read()).rejects.toThrow('late abort')
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('decodes both API event streams over independent pull-owned response bodies', async () => {
    const bridge = new QueueBridge((request) => {
      const pathname = new URL(request.url).pathname
      const envelope = pathname.endsWith('events.mux')
        ? {
          type: 'server-request',
          rpcId: 'mux-desktop',
          method: 'session/subscribed',
          payload: { type: 'session/subscribed', sessionId: 'session-desktop', lastSeq: 3 },
        }
        : {
          type: 'server-request',
          rpcId: 'host-desktop',
          method: 'host/remote-event',
          payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
        }
      return [`data: ${JSON.stringify(envelope)}\n\n`]
    })
    const client = new DesktopApiClient(createDesktopFetch(bridge))
    const muxAbort = new AbortController()
    const hostAbort = new AbortController()
    const opened: string[] = []
    const mux = client.events.mux({}, muxAbort.signal, () => { opened.push('mux') })[Symbol.asyncIterator]()
    const host = client.events.host({}, hostAbort.signal, () => { opened.push('host') })[Symbol.asyncIterator]()

    await expect(mux.next()).resolves.toMatchObject({
      value: { rpcId: 'mux-desktop', payload: { type: 'session/subscribed', lastSeq: 3 } },
    })
    await expect(host.next()).resolves.toMatchObject({
      value: { rpcId: 'host-desktop', payload: { type: 'host/remote-event', event: 'commands/change' } },
    })
    expect(opened).toEqual(['mux', 'host'])
    expect(new Set(bridge.pulls).size).toBe(2)

    await mux.return?.(undefined)
    await host.return?.(undefined)
    expect(new Set(bridge.cancellations).size).toBe(2)
  })

  it('rejects malformed preload messages and unsupported request bodies', async () => {
    const cancel = vi.fn<DesktopBridge['cancel']>().mockResolvedValue(undefined)
    const invalidHead: DesktopBridge = {
      fetch: async request => ({
        id: `${request.id}-wrong` as DesktopRequestId,
        status: 200,
        statusText: 'OK',
        headers: [],
        hasBody: false,
      }),
      pull: async () => ({ type: 'end' }),
      cancel,
    }
    await expect(createDesktopFetch(invalidHead)(new URL('dsh://app/api/test')))
      .rejects.toThrow('desktop request id mismatch')
    expect(cancel).toHaveBeenCalledTimes(1)

    const bridge = new QueueBridge(() => [])
    await expect(createDesktopFetch(bridge)(new URL('dsh://app/api/test'), {
      method: 'POST',
      body: new FormData(),
    }))
      .rejects.toThrow('supports string and byte request bodies only')
    await expect(createDesktopFetch(bridge)(new URL('dsh://app/api/test'), { method: 'DELETE' }))
      .rejects.toThrow('does not support DELETE')
    expect(bridge.requests).toHaveLength(0)
  })

  it('validates every response-head field before constructing a Response', async () => {
    const invalid = [
      () => null,
      () => 42,
      (request: DesktopFetchRequest) => ({
        id: `${request.id}-wrong`, status: 200, statusText: 'OK', headers: [], hasBody: false,
      }),
      (request: DesktopFetchRequest) => ({ id: request.id, status: 200.5, statusText: 'OK', headers: [], hasBody: false }),
      (request: DesktopFetchRequest) => ({ id: request.id, status: 199, statusText: 'OK', headers: [], hasBody: false }),
      (request: DesktopFetchRequest) => ({ id: request.id, status: 600, statusText: 'OK', headers: [], hasBody: false }),
      (request: DesktopFetchRequest) => ({ id: request.id, status: 200, statusText: 1, headers: [], hasBody: false }),
      (request: DesktopFetchRequest) => ({ id: request.id, status: 200, statusText: 'OK', headers: [], hasBody: 'yes' }),
      (request: DesktopFetchRequest) => ({ id: request.id, status: 200, statusText: 'OK', headers: null, hasBody: false }),
      (request: DesktopFetchRequest) => ({ id: request.id, status: 200, statusText: 'OK', headers: [null], hasBody: false }),
      (request: DesktopFetchRequest) => ({ id: request.id, status: 200, statusText: 'OK', headers: [[]], hasBody: false }),
      (request: DesktopFetchRequest) => ({ id: request.id, status: 200, statusText: 'OK', headers: [[1, 'value']], hasBody: false }),
      (request: DesktopFetchRequest) => ({ id: request.id, status: 200, statusText: 'OK', headers: [['name', 1]], hasBody: false }),
    ] as const
    for (const responseHead of invalid) {
      const cancel = vi.fn<DesktopBridge['cancel']>().mockResolvedValue(undefined)
      const bridge: DesktopBridge = {
        fetch: async request => responseHead(request) as unknown as DesktopFetchHead,
        pull: async () => ({ type: 'end' }),
        cancel,
      }
      await expect(createDesktopFetch(bridge)(new URL('dsh://app/api/test'))).rejects.toThrow(/invalid response head|id mismatch/)
      expect(cancel).toHaveBeenCalledTimes(1)
    }
  })

  it('validates body chunks and propagates serialized and local pull failures', async () => {
    const cases: Array<{ chunk: unknown; message: string }> = [
      { chunk: null, message: 'invalid body chunk' },
      { chunk: 42, message: 'invalid body chunk' },
      { chunk: { type: 'error', message: 42 }, message: 'invalid body chunk' },
      { chunk: { type: 'chunk', value: 'bytes' }, message: 'invalid body chunk' },
      { chunk: { type: 'other' }, message: 'invalid body chunk' },
      { chunk: { type: 'error', message: 'Host read failed' }, message: 'Host read failed' },
    ]
    for (const item of cases) {
      const cancel = vi.fn<DesktopBridge['cancel']>().mockRejectedValue(new Error('cancel failed'))
      const bridge: DesktopBridge = {
        fetch: async request => ({
          id: request.id,
          status: 200,
          statusText: 'OK',
          headers: [],
          hasBody: true,
        }),
        pull: async () => item.chunk as DesktopFetchChunk,
        cancel,
      }
      const response = await createDesktopFetch(bridge)(new URL('dsh://app/api/test'))
      await expect(response.body!.getReader().read()).rejects.toThrow(item.message)
      expect(cancel).toHaveBeenCalledTimes(1)
    }

    const cancel = vi.fn<DesktopBridge['cancel']>().mockResolvedValue(undefined)
    const rejectedPull: DesktopBridge = {
      fetch: async request => ({
        id: request.id,
        status: 200,
        statusText: 'OK',
        headers: [],
        hasBody: true,
      }),
      pull: async () => { throw new Error('pull failed') },
      cancel,
    }
    const response = await createDesktopFetch(rejectedPull)(new URL('dsh://app/api/test'))
    await expect(response.body!.getReader().read()).rejects.toThrow('pull failed')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels remote ownership when Response rejects a body-forbidden status', async () => {
    const cancel = vi.fn<DesktopBridge['cancel']>().mockRejectedValue(new Error('cancel failed'))
    const bridge: DesktopBridge = {
      fetch: async request => ({
        id: request.id,
        status: 204,
        statusText: 'No Content',
        headers: [],
        hasBody: true,
      }),
      pull: async () => ({ type: 'end' }),
      cancel,
    }
    await expect(createDesktopFetch(bridge)(new URL('dsh://app/api/test')))
      .rejects.toThrow('Invalid response status code 204')
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

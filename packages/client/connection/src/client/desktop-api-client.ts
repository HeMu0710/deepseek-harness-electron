/** Desktop IPC fetch carrier reconstructed as standard Fetch responses. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import { AbstractApiClient } from './api.ts'
import { randomUuid } from './random-uuid.ts'

/** Correlation id for one desktop transport request and its streamed body. */
export type DesktopRequestId = Branded<'desktop-request-id'>

/** Fetch methods admitted by the desktop Host dispatcher. */
export type DesktopFetchMethod = 'GET' | 'HEAD' | 'POST'

/** Serializable Fetch request sent from the isolated renderer to preload. */
export interface DesktopFetchRequest {
  /** Correlates the response head, body pulls, and cancellation. */
  readonly id: DesktopRequestId
  /** Absolute logical URL; the Host dispatcher consumes its pathname. */
  readonly url: string
  /** Fetch method admitted by the desktop adapter. */
  readonly method: DesktopFetchMethod
  /** Complete request headers as structured-clone-safe pairs. */
  readonly headers: readonly (readonly [string, string])[]
  /** Complete request body; absent for bodyless requests. */
  readonly body?: Uint8Array
}

/** Serializable response metadata returned before body consumption starts. */
export interface DesktopFetchHead {
  /** Echoes the matching request id. */
  readonly id: DesktopRequestId
  /** Fetch-compatible response status. */
  readonly status: number
  /** Fetch-compatible response status text. */
  readonly statusText: string
  /** Complete response headers as structured-clone-safe pairs. */
  readonly headers: readonly (readonly [string, string])[]
  /** Whether the response owns a body reader that must be pulled or cancelled. */
  readonly hasBody: boolean
}

/** One pull result from a desktop response body. */
export type DesktopFetchChunk =
  | { readonly type: 'chunk'; readonly value: Uint8Array }
  | { readonly type: 'end' }
  | { readonly type: 'error'; readonly message: string }

/**
 * Narrow preload API exposed as the exact `window.__DSH_DESKTOP__` global.
 * Electron primitives and arbitrary channel names never cross this interface.
 */
export interface DesktopBridge {
  /**
   * Dispatch a request and return its response metadata.
   * @param request - structured-clone-safe Fetch request.
   * @returns response metadata; body bytes remain Host-owned until pulled.
   */
  fetch(request: DesktopFetchRequest): Promise<DesktopFetchHead>
  /**
   * Pull at most one chunk from the response body owned by `id`.
   * @param id - request whose response body should advance.
   * @returns one body chunk, the end marker, or a serialized read failure.
   */
  pull(id: DesktopRequestId): Promise<DesktopFetchChunk>
  /**
   * Idempotently abort and release the request or response body owned by `id`.
   * @param id - request to release.
   * @returns completion after Host resources have been released.
   */
  cancel(id: DesktopRequestId): Promise<void>
}

/** Fetch function backed by one desktop bridge instance. */
export type DesktopFetch = (input: URL, init?: RequestInit) => Promise<Response>

interface DesktopGlobal {
  __DSH_DESKTOP__?: unknown
}

declare global {
  interface Window {
    /** Frozen preload bridge installed only in the Electron renderer. */
    readonly __DSH_DESKTOP__?: DesktopBridge
  }
}

/**
 * Read and validate the fixed preload global.
 * @returns the desktop bridge, or undefined in an ordinary browser.
 */
export function desktopBridgeFromGlobal(): DesktopBridge | undefined {
  const value = (globalThis as DesktopGlobal).__DSH_DESKTOP__
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) throw new Error('client-connection: window.__DSH_DESKTOP__ must be an object')
  const bridge = value as Partial<DesktopBridge>
  if (typeof bridge.fetch !== 'function' || typeof bridge.pull !== 'function' || typeof bridge.cancel !== 'function') {
    throw new Error('client-connection: window.__DSH_DESKTOP__ must provide fetch, pull, and cancel functions')
  }
  return bridge as DesktopBridge
}

/**
 * Create a Fetch-compatible caller over a structured-clone-only preload API.
 * Each response body pulls one IPC chunk at a time, so renderer demand bounds
 * Host reads; abort and reader cancellation converge on the same remote id.
 * @param bridge - validated preload bridge.
 * @returns Fetch-compatible transport for API and generic RPC callers.
 */
export function createDesktopFetch(bridge: DesktopBridge): DesktopFetch {
  return async (input, init) => {
    const id = desktopRequestId(randomUuid())
    const signal = init?.signal ?? undefined
    if (signal?.aborted === true) throw abortError(signal)
    const method = desktopMethod(init?.method)
    if ((method === 'GET' || method === 'HEAD') && init?.body !== undefined && init.body !== null) {
      throw new TypeError(`Request with ${method} method cannot have body`)
    }
    const request: DesktopFetchRequest = {
      id,
      url: input.href,
      method,
      headers: [...new Headers(init?.headers).entries()],
      ...init?.body === undefined || init.body === null ? {} : { body: bodyBytes(init.body) },
    }

    let cancelPromise: Promise<void> | undefined
    let onAbort: (() => void) | undefined
    const cleanup = (): void => {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
      onAbort = undefined
    }
    const finish = (): void => {
      cleanup()
    }
    const cancelRemote = (): Promise<void> => {
      if (cancelPromise !== undefined) return cancelPromise
      finish()
      cancelPromise = bridge.cancel(id)
      return cancelPromise
    }
    const aborted = signal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          void cancelRemote().catch(() => {
            // The abort already settles the caller; no remaining consumer can use a cancellation failure.
          })
          reject(abortError(signal))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    const untilAbort = <T>(operation: Promise<T>): Promise<T> =>
      aborted === undefined ? operation : Promise.race([operation, aborted])

    let head: DesktopFetchHead
    try {
      head = parseHead(await untilAbort(bridge.fetch(request)), id)
    } catch (error) {
      await cancelRemote().catch(() => undefined)
      throw error
    }

    if (!head.hasBody) {
      finish()
      return new Response(null, responseInit(head))
    }

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted === true) {
          await cancelRemote().catch(() => undefined)
          controller.error(abortError(signal))
          return
        }
        try {
          const chunk = parseChunk(await untilAbort(bridge.pull(id)))
          switch (chunk.type) {
            case 'chunk':
              controller.enqueue(chunk.value)
              return
            case 'end':
              finish()
              controller.close()
              return
            case 'error':
              await cancelRemote().catch(() => undefined)
              controller.error(new Error(chunk.message))
          }
        } catch (error) {
          await cancelRemote().catch(() => undefined)
          controller.error(error)
        }
      },
      cancel: cancelRemote,
    }, { highWaterMark: 0 })
    try {
      return new Response(body, responseInit(head))
    } catch (error) {
      await cancelRemote().catch(() => undefined)
      throw error
    }
  }
}

/** Desktop platform subclass; protocol handling remains in AbstractApiClient. */
export class DesktopApiClient extends AbstractApiClient {
  /**
   * @param desktopFetch - Fetch-compatible desktop transport shared with generic RPC.
   * @param timeoutMs - timeout for bounded unary calls.
   */
  constructor(private readonly desktopFetch: DesktopFetch, timeoutMs?: number) {
    super(timeoutMs)
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return this.desktopFetch(input, init)
  }
}

function desktopRequestId(value: string): DesktopRequestId {
  return value as DesktopRequestId
}

function desktopMethod(value: string | undefined): DesktopFetchMethod {
  const method = (value ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'POST') return method
  throw new TypeError(`client-connection: desktop transport does not support ${method}`)
}

function bodyBytes(body: BodyInit): Uint8Array {
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString())
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0))
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice()
  }
  throw new TypeError('client-connection: desktop transport supports string and byte request bodies only')
}

function responseInit(head: DesktopFetchHead): ResponseInit {
  return {
    status: head.status,
    statusText: head.statusText,
    headers: head.headers.map(([name, value]) => [name, value]),
  }
}

function parseHead(value: unknown, id: DesktopRequestId): DesktopFetchHead {
  if (typeof value !== 'object' || value === null) throw new Error('client-connection: desktop fetch returned an invalid response head')
  const head = value as Partial<DesktopFetchHead>
  if (head.id !== id) throw new Error(`client-connection: desktop request id mismatch: sent ${id}, got ${String(head.id)}`)
  if (!Number.isInteger(head.status) || (head.status as number) < 200 || (head.status as number) > 599
    || typeof head.statusText !== 'string' || typeof head.hasBody !== 'boolean' || !headerPairs(head.headers)) {
    throw new Error('client-connection: desktop fetch returned an invalid response head')
  }
  return head as DesktopFetchHead
}

function parseChunk(value: unknown): DesktopFetchChunk {
  if (typeof value !== 'object' || value === null) throw new Error('client-connection: desktop fetch returned an invalid body chunk')
  const chunk = value as { type?: unknown; value?: unknown; message?: unknown }
  if (chunk.type === 'end') return { type: 'end' }
  if (chunk.type === 'error' && typeof chunk.message === 'string') return { type: 'error', message: chunk.message }
  if (chunk.type === 'chunk' && chunk.value instanceof Uint8Array) return { type: 'chunk', value: chunk.value }
  throw new Error('client-connection: desktop fetch returned an invalid body chunk')
}

function headerPairs(value: unknown): value is readonly (readonly [string, string])[] {
  return Array.isArray(value) && value.every(pair =>
    Array.isArray(pair) && pair.length === 2 && pair.every(field => typeof field === 'string'))
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new Error(reason)
  return new Error('This operation was aborted')
}

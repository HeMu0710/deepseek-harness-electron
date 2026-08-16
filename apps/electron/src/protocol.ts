import { DEFAULT_MAX_REQUEST_BODY_BYTES } from '@deepseek-ai/dsh-client-connection'

/** The only application origin admitted by the desktop shell. */
export const DESKTOP_ORIGIN = 'dsh://app'

/** Fixed security ceiling shared with the Web request carrier. */
export const MAX_IPC_REQUEST_BODY_BYTES = DEFAULT_MAX_REQUEST_BODY_BYTES

/** Serialized Headers entries used on every process crossing. */
type HeaderEntries = Array<[string, string]>

/** A renderer fetch request after the preload has removed browser objects. */
export interface DesktopFetchRequest {
  /** Renderer-minted correlation id. */
  id: string
  /** Absolute URL under the fixed local application origin. */
  url: string
  /** HTTP method admitted by the desktop carrier. */
  method: string
  /** Request headers. */
  headers: HeaderEntries
  /** Optional request body bytes. */
  body?: Uint8Array
}

/** Response metadata returned before body chunks. */
export interface DesktopFetchHead {
  /** Request correlation id. */
  id: string
  /** HTTP status code. */
  status: number
  /** HTTP status text. */
  statusText: string
  /** Response headers. */
  headers: HeaderEntries
  /** Whether response-body pulls may follow. */
  hasBody: boolean
}

/** Main-to-utility request to stream a Host download into an approved file. */
export interface DesktopSaveRequest {
  /** Main-process correlation id. */
  id: string
  /** Absolute application API URL selected by the renderer operation. */
  url: string
  /** Absolute path returned by Electron's save dialog. */
  path: string
}

/** Result of pulling one response-body chunk. */
export type DesktopFetchChunk =
  | { type: 'chunk'; value: Uint8Array }
  | { type: 'end' }
  | { type: 'error'; message: string }

/** Renderer-to-utility request forwarded by the main-process broker. */
export type HostCommand =
  | { type: 'fetch'; request: DesktopFetchRequest }
  | { type: 'save'; request: DesktopSaveRequest }
  | { type: 'pull'; id: string }
  | { type: 'cancel'; id: string }
  | { type: 'shutdown' }

/** One client bundle resource served through the private application scheme. */
export interface ClientResource {
  /** Exact URL pathname from the boot graph. */
  pathname: string
  /** Absolute built bundle path owned by the Host inventory. */
  path: string
}

/** Utility-to-main lifecycle and fetch messages. */
export type HostEvent =
  | { type: 'ready'; graph: unknown; resources: ClientResource[] }
  | { type: 'graph'; graph: unknown; resources: ClientResource[] }
  | { type: 'fetch-head'; head: DesktopFetchHead }
  | { type: 'fetch-chunk'; id: string; value: Uint8Array }
  | { type: 'fetch-end'; id: string }
  | { type: 'fetch-error'; id: string; message: string }
  | { type: 'fetch-cancelled'; id: string }
  | { type: 'save-complete'; id: string }
  | { type: 'save-error'; id: string; message: string }
  | { type: 'stopped' }
  | { type: 'fatal'; message: string }

/** Metadata available to the isolated renderer. */
export interface DesktopInfo {
  /** True only in the Electron carrier. */
  desktop: true
  /** Application origin used for diagnostics. */
  origin: typeof DESKTOP_ORIGIN
}

/** Renderer request ids are opaque but bounded before crossing into Host. */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

/** Validate one renderer fetch request before the main process forwards it. */
export function isDesktopFetchRequest(value: unknown): value is DesktopFetchRequest {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Partial<DesktopFetchRequest>
  if (!isRequestId(request.id)) return false
  if (typeof request.url !== 'string' || typeof request.method !== 'string') return false
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') return false
  const headers: unknown = request.headers
  if (!Array.isArray(headers) || headers.length > 128) return false
  if (headers.some((entry: unknown) => !Array.isArray(entry)
    || entry.length !== 2
    || entry.some((part: unknown) => typeof part !== 'string' || part.length > 8192))) return false
  if (request.body !== undefined
    && (!(request.body instanceof Uint8Array) || request.body.byteLength > MAX_IPC_REQUEST_BODY_BYTES)) return false
  try {
    const url = new URL(request.url)
    return url.protocol === 'dsh:'
      && url.hostname === 'app'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.hash === ''
  } catch {
    return false
  }
}

/** Validate one command received by the utility Host. */
export function isHostCommand(value: unknown): value is HostCommand {
  if (typeof value !== 'object' || value === null) return false
  const command = value as { type?: unknown; request?: unknown; id?: unknown }
  switch (command.type) {
    case 'fetch': return isDesktopFetchRequest(command.request)
    case 'save': return isDesktopSaveRequest(command.request)
    case 'pull':
    case 'cancel': return isRequestId(command.id)
    case 'shutdown': return true
    default: return false
  }
}

function isDesktopSaveRequest(value: unknown): value is DesktopSaveRequest {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Partial<DesktopSaveRequest>
  if (!isRequestId(request.id)
    || typeof request.url !== 'string'
    || typeof request.path !== 'string'
    || request.path.length === 0
    || request.path.length > 32_768
    || request.path.includes('\0')) return false
  try {
    const url = new URL(request.url)
    return url.protocol === 'dsh:'
      && url.hostname === 'app'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.pathname === '/api/session.export'
      && url.hash === ''
  } catch {
    return false
  }
}

import { describe, expect, it } from 'vitest'
import {
  isDesktopFetchRequest,
  isHostCommand,
  MAX_IPC_REQUEST_BODY_BYTES,
} from '../src/protocol.ts'

describe('desktop IPC validation', () => {
  const request = {
    id: 'request_1',
    url: 'dsh://app/api/session.list',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: new Uint8Array([1]),
  }

  it('admits only the fixed application origin and bounded request fields', () => {
    expect(isDesktopFetchRequest(request)).toBe(true)
    expect(isDesktopFetchRequest({ ...request, url: 'https://example.com/api/session.list' })).toBe(false)
    expect(isDesktopFetchRequest({ ...request, url: 'dsh://other/api/session.list' })).toBe(false)
    expect(isDesktopFetchRequest({ ...request, url: 'dsh://user@app/api/session.list' })).toBe(false)
    expect(isDesktopFetchRequest({ ...request, method: 'DELETE' })).toBe(false)
    expect(isDesktopFetchRequest({ ...request, body: new Uint8Array(MAX_IPC_REQUEST_BODY_BYTES + 1) })).toBe(false)
  })

  it('validates utility commands by discriminant and payload', () => {
    expect(isHostCommand({ type: 'fetch', request })).toBe(true)
    expect(isHostCommand({
      type: 'save',
      request: { id: 'save_1', url: 'dsh://app/api/session.export?sessionId=one', path: '/tmp/session.zip' },
    })).toBe(true)
    expect(isHostCommand({
      type: 'save',
      request: { id: 'save_1', url: 'dsh://app/api/session.list', path: '/tmp/session.zip' },
    })).toBe(false)
    expect(isHostCommand({ type: 'pull', id: 'request_1' })).toBe(true)
    expect(isHostCommand({ type: 'cancel', id: 'request_1' })).toBe(true)
    expect(isHostCommand({ type: 'shutdown' })).toBe(true)
    expect(isHostCommand({ type: 'pull', id: '../escape' })).toBe(false)
    expect(isHostCommand({ type: 'unknown' })).toBe(false)
  })
})

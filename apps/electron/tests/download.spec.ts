import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveResponseToFile } from '../src/download.ts'

const encoder = new TextEncoder()
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function target(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-desktop-download-'))
  return join(root, 'session.zip')
}

describe('desktop native download writer', () => {
  it('streams chunks through a temporary sibling and replaces the target', async () => {
    const path = await target()
    const attached: ReadableStreamDefaultReader<Uint8Array>[] = []
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('first'))
        controller.enqueue(encoder.encode('-second'))
        controller.close()
      },
    }))

    await expect(saveResponseToFile(response, path, {
      owns: () => true,
      attach: (reader) => { attached.push(reader) },
    })).resolves.toBe(true)

    await expect(readFile(path, 'utf8')).resolves.toBe('first-second')
    await expect(readdir(root!)).resolves.toEqual(['session.zip'])
    expect(attached).toHaveLength(1)
  })

  it('cancels failed responses and removes partial files after ownership is lost', async () => {
    const path = await target()
    const cancel = vi.fn()
    const failed = new Response(new ReadableStream({ cancel }), { status: 500 })
    await expect(saveResponseToFile(failed, path, { owns: () => true, attach: vi.fn() }))
      .rejects.toThrow('Export failed: HTTP 500')
    expect(cancel).toHaveBeenCalledOnce()

    let owned = true
    const cancelled = new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(encoder.encode('partial'))
        owned = false
        controller.close()
      },
    }))
    await expect(saveResponseToFile(cancelled, path, { owns: () => owned, attach: vi.fn() }))
      .resolves.toBe(false)
    await expect(readdir(root!)).resolves.toEqual([])
  })
})

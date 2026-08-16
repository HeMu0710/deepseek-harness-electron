/** Atomic utility-Host download writer used after the main process approves a path. */

import { randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'

/** Ownership hooks that connect file streaming to the Host request ledger. */
export interface DownloadOwnership {
  /** Whether the ledger still owns this download. */
  owns(): boolean
  /** Publish the response reader so cancellation can stop it. */
  attach(reader: ReadableStreamDefaultReader<Uint8Array>): void
}

/**
 * Stream a successful response into a sibling temporary file and rename it into place.
 * @param response - Host download response.
 * @param targetPath - OS-approved absolute destination.
 * @param ownership - live-ledger hooks for cancellation checks.
 * @returns true after replacement, or false when cancellation removed ownership.
 */
export async function saveResponseToFile(
  response: Response,
  targetPath: string,
  ownership: DownloadOwnership,
): Promise<boolean> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Export failed: HTTP ${String(response.status)}`)
  }
  if (response.body === null) throw new Error('Export failed: Host returned no archive body')
  if (!ownership.owns()) {
    await response.body.cancel().catch(() => undefined)
    return false
  }

  const reader = response.body.getReader()
  ownership.attach(reader)
  const temporaryPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`
  let file: Awaited<ReturnType<typeof open>> | undefined
  let temporaryOwned = false
  try {
    file = await open(temporaryPath, 'wx', 0o600)
    temporaryOwned = true
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      await file.writeFile(item.value)
    }
    await file.close()
    file = undefined
    if (!ownership.owns()) return false
    await rename(temporaryPath, targetPath)
    return true
  } finally {
    await file?.close().catch(() => undefined)
    if (temporaryOwned) await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

import { spawn } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawnDialogWorker } from '../src/win32-dialog-host.ts'

describe('Win32 dialog Host launcher', () => {
  beforeEach(() => { vi.mocked(spawn).mockReset() })

  it('enables Node mode only for a helper launched by Electron', () => {
    spawnDialogWorker({ title: 'Pick workspace' }, true)
    expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).toMatchObject({
      DSH_DIALOG_TITLE: 'Pick workspace',
      ELECTRON_RUN_AS_NODE: '1',
    })

    spawnDialogWorker({ title: 'Plain Node' }, false)
    expect(vi.mocked(spawn).mock.calls[1]?.[2]?.env).toMatchObject({ DSH_DIALOG_TITLE: 'Plain Node' })
    expect(vi.mocked(spawn).mock.calls[1]?.[2]?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })
})

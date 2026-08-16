import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const state = {
    whenReadyCalls: 0,
    registeredSchemes: 0,
  }
  return {
    state,
    app: {
      requestSingleInstanceLock: (): boolean => true,
      on: (): void => undefined,
      quit: (): void => undefined,
      whenReady: (): Promise<void> => {
        state.whenReadyCalls += 1
        return new Promise<void>(() => undefined)
      },
    },
    protocol: {
      registerSchemesAsPrivileged: (): void => { state.registeredSchemes += 1 },
    },
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
        ? '/private/tmp/dsh-electron-entry/index.html'
        : real.resolve(id, options)
      resolve.paths = (id: string): string[] | null => real.resolve.paths(id)
      wrapped.resolve = resolve
      return wrapped
    },
  })
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: function BrowserWindow(): void {},
  dialog: {},
  ipcMain: {},
  protocol: electron.protocol,
  session: {},
  shell: {},
  utilityProcess: {},
}))

describe('desktop main entry', () => {
  it('finishes ESM evaluation before Electron becomes ready', async () => {
    await expect(import('../src/main.ts')).resolves.toBeDefined()

    expect(electron.state.registeredSchemes).toBe(1)
    expect(electron.state.whenReadyCalls).toBe(1)
  })
})

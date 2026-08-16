/** Shared profile preparation, composition, and live user-layer boot behavior. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  bootProfile,
  homePatchPath,
  initProfile,
  prepareProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_ROOT_FILENAME,
  resolveProfileDir,
  resolveTelemetryPatch,
} from '../src/index.ts'

const NAME = 'profile-runner-test'
const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-profile-runner-'))

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('profile patch did not refresh')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

interface Fixture {
  anchor: string
  bundlePatch: string
  home: string
  overlay: string
  profileDir: string
  shippedPresetRoot: string
}

function stageFixture(): Fixture {
  const root = tmp()
  const home = join(root, 'home')
  const appDir = join(root, 'app')
  const bundleDir = join(appDir, 'node_modules', 'test-profile-bundle')
  const bundlePatch = join(bundleDir, 'cordis.patch.yml')
  const profileDir = resolveProfileDir('test', home)
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({
    name: 'test-profile-app',
    dependencies: { 'test-profile-bundle': '0.0.0' },
  }))
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: 'test-profile-bundle',
    version: '0.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(bundlePatch, [
    '- insert:',
    '    - id: fake-hmr',
    '      name: ./fake-hmr.mjs',
    '    - id: target',
    '      name: ./noop.mjs',
    '      config:',
    '        value: base',
    '    - id: fixed',
    '      name: ./noop.mjs',
    '      config:',
    '        value: base',
    '    - id: agent-presets',
    '      name: ./noop.mjs',
    '      config:',
    '        mode: base',
    '        roots:',
    '          - path: bundle-root',
    '            trust: system',
    '    - id: session-telemetry-otel',
    '      name: ./noop.mjs',
    '',
  ].join('\n'))
  initProfile(profileDir, ['test-profile-bundle'])
  writeFileSync(join(profileDir, 'noop.mjs'), [
    'export const name = "noop"',
    'export function apply() {}',
    '',
  ].join('\n'))
  writeFileSync(join(profileDir, 'fake-hmr.mjs'), [
    'export const name = "fake-hmr"',
    'export function apply(ctx) {',
    '  const registrations = new Map()',
    '  ctx.provide("hmr", {',
    '    registrations,',
    '    registerConfig(filename, refresh) {',
    '      if (process.env.DSH_PROFILE_RUNNER_FAIL_SECOND_WATCHER === "1" && registrations.size === 1) {',
    '        throw new Error("second watcher rejected")',
    '      }',
    '      return ctx.effect(() => {',
    '        if (registrations.has(filename)) throw new Error(`duplicate watcher ${filename}`)',
    '        registrations.set(filename, refresh)',
    '        return async () => { registrations.delete(filename) }',
    '      }, `fake-hmr: ${filename}`)',
    '    },',
    '  })',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), [
    '- id: target',
    '  config:',
    '    value: profile',
    '- id: fixed',
    '  config:',
    '    value: profile',
    '',
  ].join('\n'))
  const overlay = join(root, 'required.patch.yml')
  writeFileSync(overlay, '- id: fixed\n  config:\n    value: overlay\n')
  return {
    anchor: join(appDir, 'package.json'),
    bundlePatch,
    home,
    overlay,
    profileDir,
    shippedPresetRoot: join(root, 'shipped-presets'),
  }
}

function entry(ctx: Context, id: string) {
  const found = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)
  if (found === undefined) throw new Error(`missing entry ${id}`)
  return found
}

interface FakeHmr {
  registrations: Map<string, () => Promise<void>>
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveTelemetryPatch', () => {
  it('preserves telemetry when the switch is unset or empty', () => {
    expect(resolveTelemetryPatch(undefined, true)).toBeUndefined()
    expect(resolveTelemetryPatch('', true)).toBeUndefined()
  })

  it('disables on every non-empty value, including falsy-looking values', () => {
    for (const value of ['1', '0', 'false', 'no']) {
      expect(resolveTelemetryPatch(value, true)).toEqual({ id: 'session-telemetry-otel', disabled: true })
    }
  })

  it('needs no patch when the profile has no telemetry row', () => {
    expect(resolveTelemetryPatch('1', false)).toBeUndefined()
  })
})

describe('prepareProfile', () => {
  it('rewrites the empty Loader root and optionally skips a broken user layer', () => {
    const fixture = stageFixture()
    vi.stubEnv('DSH_HOME', fixture.home)
    writeFileSync(join(fixture.profileDir, PROFILE_ROOT_FILENAME), '- id: persisted\n  name: stale\n')
    writeFileSync(join(fixture.profileDir, PROFILE_PATCH_FILENAME), 'invalid: [unclosed\n')
    const profile = prepareProfile({
      binName: NAME,
      profile: 'test',
      installAnchor: fixture.anchor,
      userLayer: false,
    })
    expect(profile.patches).toEqual([])
    expect(readFileSync(join(fixture.profileDir, PROFILE_ROOT_FILENAME), 'utf8')).toContain('[]')
    expect(() => prepareProfile({
      binName: NAME,
      profile: 'test',
      installAnchor: fixture.anchor,
    })).toThrow('failed to parse overlay')
  })
})

describe('bootProfile', () => {
  it('mounts config-only patch watchers when Loader internals are unavailable', async () => {
    const fixture = stageFixture()
    vi.stubEnv('DSH_HOME', fixture.home)
    writeFileSync(
      fixture.bundlePatch,
      readFileSync(fixture.bundlePatch, 'utf8').replace(
        '    - id: fake-hmr\n      name: ./fake-hmr.mjs\n',
        '',
      ),
    )
    const result = await bootProfile({
      binName: NAME,
      profile: 'test',
      installAnchor: fixture.anchor,
      patchFiles: [],
      prepare(ctx) {
        ctx.loader.internal = undefined
      },
    })
    try {
      expect(result.ctx.hmr).toBeDefined()
      writeFileSync(result.profile.patchPath, '- id: target\n  config:\n    value: config-only-live\n')
      await eventually(() => (entry(result.ctx, 'target').options.config as { value?: unknown }).value === 'config-only-live')
    } finally {
      await result.dispose()
    }
  })

  it('owns fixed overlays, both live user layers, shipped presets, and telemetry composition', async () => {
    const fixture = stageFixture()
    vi.stubEnv('DSH_HOME', fixture.home)
    let prepared = false
    const result = await bootProfile({
      binName: NAME,
      profile: 'test',
      installAnchor: fixture.anchor,
      patchFiles: [fixture.overlay],
      shippedPresetRoot: fixture.shippedPresetRoot,
      telemetryDisabled: '0',
      prepare() {
        prepared = true
      },
    })
    const { ctx, profile } = result
    const hmr = ctx.get('hmr') as unknown as FakeHmr
    try {
      expect(prepared).toBe(true)
      expect(profile.dir).toBe(fixture.profileDir)
      expect(entry(ctx, 'target').options.config).toEqual({ value: 'profile' })
      expect(entry(ctx, 'fixed').options.config).toEqual({ value: 'overlay' })
      expect(entry(ctx, 'agent-presets').options.config).toEqual({
        mode: 'base',
        roots: [{ path: fixture.shippedPresetRoot, trust: 'system' }],
      })
      expect(entry(ctx, 'session-telemetry-otel').options.disabled).toBe(true)
      expect([...hmr.registrations.keys()].sort()).toEqual([
        homePatchPath(),
        profile.patchPath,
      ].sort())

      writeFileSync(profile.patchPath, '- id: target\n  config:\n    value: profile-live\n')
      await hmr.registrations.get(profile.patchPath)?.()
      expect(entry(ctx, 'target').options.config).toEqual({ value: 'profile-live' })
      expect(entry(ctx, 'fixed').options.config).toEqual({ value: 'overlay' })

      writeFileSync(homePatchPath(), '- id: target\n  config:\n    value: home-live\n')
      await hmr.registrations.get(homePatchPath())?.()
      expect(entry(ctx, 'target').options.config).toEqual({ value: 'home-live' })

      writeFileSync(profile.patchPath, '- id: target\n  config:\n    value: profile-later\n')
      await hmr.registrations.get(profile.patchPath)?.()
      expect(entry(ctx, 'target').options.config).toEqual({ value: 'home-live' })
      expect(entry(ctx, 'agent-presets').options.config).toEqual({
        mode: 'base',
        roots: [{ path: fixture.shippedPresetRoot, trust: 'system' }],
      })
      expect(entry(ctx, 'session-telemetry-otel').options.disabled).toBe(true)
    } finally {
      await Promise.all([result.dispose(), result.dispose()])
    }
    expect(hmr.registrations.size).toBe(0)
    expect(existsSync(join(fixture.home, '.host.lock'))).toBe(false)
  })

  it('skips watcher setup when launcher shutdown already started', async () => {
    const fixture = stageFixture()
    vi.stubEnv('DSH_HOME', fixture.home)
    const shutdown = new AbortController()
    shutdown.abort()
    const result = await bootProfile({
      binName: NAME,
      profile: 'test',
      installAnchor: fixture.anchor,
      patchFiles: [],
      shutdownSignal: shutdown.signal,
    })
    const { ctx } = result
    try {
      const hmr = ctx.get('hmr') as unknown as FakeHmr
      expect(hmr.registrations.size).toBe(0)
    } finally {
      await result.dispose()
    }
  })

  it('rejects a concurrent Host for the same home and permits sequential reuse', async () => {
    const fixture = stageFixture()
    vi.stubEnv('DSH_HOME', fixture.home)
    const first = await bootProfile({
      binName: NAME,
      profile: 'test',
      installAnchor: fixture.anchor,
      patchFiles: [],
    })
    try {
      expect(existsSync(join(fixture.home, '.host.lock'))).toBe(true)
      await expect(bootProfile({
        binName: NAME,
        profile: 'test',
        installAnchor: fixture.anchor,
        patchFiles: [],
      })).rejects.toThrow(join(fixture.home, '.host.lock'))
    } finally {
      await first.dispose()
    }

    const sequential = await bootProfile({
      binName: NAME,
      profile: 'test',
      installAnchor: fixture.anchor,
      patchFiles: [],
    })
    await sequential.dispose()
  }, 10_000)

  it('disposes the booted tree before rejecting an active watcher setup failure', async () => {
    const fixture = stageFixture()
    vi.stubEnv('DSH_HOME', fixture.home)
    vi.stubEnv('DSH_PROFILE_RUNNER_FAIL_SECOND_WATCHER', '1')
    let partial: Context | undefined
    await expect(bootProfile({
      binName: NAME,
      profile: 'test',
      installAnchor: fixture.anchor,
      patchFiles: [],
      prepare(ctx) {
        partial = ctx
      },
    })).rejects.toThrow('second watcher rejected')
    expect(partial).toBeDefined()
    expect(partial?.get('loader')).toBeUndefined()
    expect(existsSync(join(fixture.home, '.host.lock'))).toBe(false)
  })
})

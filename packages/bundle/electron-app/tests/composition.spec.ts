/** Desktop and Web bundle-layer composition over the shared GUI roster. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import {
  applyEntryPatches, entryListSchema, type PatchOptions,
} from '@deepseek-ai/cordis-plugin-include'

interface ComposedRow {
  id?: string
  name?: string
  disabled?: boolean
  inject?: string[]
  config?: Record<string, unknown>
}

interface BundleManifest {
  name?: string
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Read one bundle patch in the Loader's YAML dialect. */
function readPatch(bundle: string): PatchOptions[] {
  const parsed: unknown = yaml.load(
    readFileSync(resolve(BUNDLE_ROOT, bundle, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError(`${bundle} patch must be a top-level array`)
  return parsed as PatchOptions[]
}

/** Compose ordered bundle layers and fail the test on any unmatched patch. */
function compose(...bundles: string[]): Map<string, ComposedRow> {
  const warnings: string[] = []
  const rows = applyEntryPatches(
    [],
    bundles.flatMap(readPatch),
    (message, ...args) => { warnings.push(`${message} ${args.join(' ')}`) },
  ) as ComposedRow[]
  expect(warnings).toEqual([])
  return new Map(rows.flatMap(row => row.id === undefined ? [] : [[row.id, row]]))
}

/** Verify that one bundle manifest owns every bare plugin its patch inserts. */
function expectBarePluginsDeclared(bundle: string): void {
  const root = resolve(BUNDLE_ROOT, bundle)
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as BundleManifest
  expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  const required = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child)
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string' && record.name.startsWith('@')) {
      const segments = record.name.split('/')
      const packageName = `${segments[0]}/${segments[1]}`
      if (packageName !== manifest.name) required.add(packageName)
    }
    for (const child of Object.values(record)) walk(child)
  }
  walk(readPatch(bundle))
  expect([...required].filter(name => manifest.dependencies?.[name] === undefined)).toEqual([])
}

describe('GUI surface composition', () => {
  it('keeps the desktop roster transport-independent and pins native directory interaction', () => {
    const desktop = compose('base', 'gui-app', 'electron-app')

    for (const id of [
      'modules', 'connection', 'api-gateway', 'api-remotes', 'client-runtime',
      'ui-layout', 'ui-conversation', 'ui-settings', 'ui-tool', 'ui-workspace',
    ]) {
      expect(desktop.get(id), id).toBeDefined()
      expect(desktop.get(id)?.disabled, id).not.toBe(true)
    }
    for (const id of ['web-startup', 'webserver', 'web-runtime', 'client-hmr']) {
      expect(desktop.has(id), id).toBe(false)
    }
    expect(desktop.get('connection')).toMatchObject({
      name: '@deepseek-ai/dsh-client-connection',
    })
    expect(desktop.get('connection')?.inject).toBeUndefined()
    expect(desktop.get('directory-picker')).toMatchObject({
      name: '@deepseek-ai/dsh-host-directory-picker-native',
    })
    expect(desktop.get('ui-directory-picker-native')).toMatchObject({
      name: '@deepseek-ai/dsh-client-ui-directory-picker-native',
    })
    expect(desktop.get('agent-presets')).toMatchObject({ config: { default: 'standard' } })
  })

  it('adds only Web carrier rows after the same GUI roster', () => {
    const web = compose('base', 'gui-app', 'web-app')

    expect(web.get('web-startup')).toMatchObject({ name: '@deepseek-ai/dsh-web-app/startup' })
    expect(web.get('webserver')).toMatchObject({
      name: '@deepseek-ai/dsh-host-webserver',
      inject: ['webStartup'],
    })
    expect(web.get('web-runtime')).toMatchObject({
      name: '@deepseek-ai/dsh-web-app',
      inject: ['webStartup'],
    })
    expect(web.get('client-hmr')).toMatchObject({ name: '@deepseek-ai/dsh-client-hmr' })
    expect(web.get('directory-picker')).toMatchObject({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
    })
    expect(web.get('connection')).toMatchObject({
      name: '@deepseek-ai/dsh-client-connection',
      inject: ['webRuntime'],
      config: { trustedHosts: { __jsExpr: 'ctx.webRuntime.trustedHosts' } },
    })
  })

  it('declares every bare plugin from each new layer in the owning manifest', () => {
    expectBarePluginsDeclared('gui-app')
    expectBarePluginsDeclared('electron-app')
    expectBarePluginsDeclared('web-app')
  })
})

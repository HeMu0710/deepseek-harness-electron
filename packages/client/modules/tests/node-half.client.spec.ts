/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ClientModuleRegistry, injectBootManifest } from '../src/index.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Create a resolvable package whose client export points at the returned path. */
function writePackage(
  packageName: string,
  metadata: Record<string, unknown> = { dsh: { client: { platform: 'web' } } },
): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-')))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    ...metadata,
  }))
  return clientPath
}

interface WebCarrierRegistration {
  service: ClientModuleRegistry
  route: WebRoute
  transform: (html: string) => string
}

/** Construct a context carrying the enabled fixture Loader entries. */
function contextFor(packageNames: string[]): Context {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  ctx.provide('loader', {
    *entries() {
      for (const packageName of packageNames) {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      }
    },
  })
  return ctx
}

/** Construct the host service and capture the optional Web carrier registrations. */
async function constructWithWebServer(packageNames: string[]): Promise<WebCarrierRegistration> {
  const ctx = contextFor(packageNames)
  let route: WebRoute | undefined
  let transform: ((html: string) => string) | undefined
  const webServer: Pick<WebServer, 'port' | 'register' | 'tapIndex'> = {
    port: 0,
    register: (candidate) => {
      if (candidate.path === '/plugins') route = candidate
      return () => {}
    },
    tapIndex: (candidate) => {
      transform = candidate
      return () => {}
    },
  }
  ctx.provide('webServer', webServer as WebServer)
  await ctx.plugin(ClientModuleRegistry).await()
  // The optional Web carrier is a child injection whose initial refresh settles independently.
  await new Promise<void>(resolve => setImmediate(resolve))
  const service = ctx.get('clientModules')
  if (service === undefined) throw new Error('client module inventory was not registered')
  if (route === undefined) throw new Error('client bundle route was not registered')
  if (transform === undefined) throw new Error('client boot manifest tap was not registered')
  return { service, route, transform }
}

/** Construct the host inventory over the enabled fixture entries. */
function construct(packageNames: string[]): ClientModuleRegistry {
  return new ClientModuleRegistry(contextFor(packageNames))
}

describe('client bundle activation', () => {
  it('stays active and exposes inventory without a WebServer', async () => {
    const packageName = '@fixture/transport-neutral'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const ctx = contextFor([packageName])

    const fiber = ctx.plugin(ClientModuleRegistry)
    await fiber.await()

    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(ctx.clientModules.graph().entries.map(entry => entry.id)).toEqual([packageName])
    expect(ctx.clientModules.clientPath(packageName)).toBe(clientPath)
    await fiber.dispose()
  })

  it('installs the bundle route and current graph injection when a WebServer is active', async () => {
    const packageName = '@fixture/web-carrier'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')

    const { service, route, transform } = await constructWithWebServer([packageName])

    expect(route).toMatchObject({ kind: 'prefix', path: '/plugins' })
    expect(transform('<html><head></head></html>')).toContain(
      `<script>window.__DSH_BOOT__ = ${JSON.stringify(service.graph())}</script>`,
    )
  })

  it('marks the boot script with a validated CSP nonce', () => {
    const graph = { rev: 'empty', entries: [] }
    const html = injectBootManifest('<head></head>', graph, 'desktop_nonce_1234567890')
    expect(html).toContain('<script nonce="desktop_nonce_1234567890">')
    expect(() => injectBootManifest('<head></head>', graph, 'bad nonce')).toThrow(
      'client-modules: boot manifest nonce must be base64url text',
    )
  })

  it('allows sibling dsh roles', () => {
    const currentName = '@fixture/current-client-field'
    const clientPath = writePackage(currentName, {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        profile: { bundles: [] },
      },
    })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    expect(construct([currentName]).graph().entries.map(entry => entry.id)).toEqual([currentName])
  })

  it('groups missing bundles under one source-build instruction with a package/path list', () => {
    const firstName = '@fixture/missing-first'
    const secondName = '@fixture/missing-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    expect(() => construct([firstName, secondName])).toThrow([
      'client-modules: 2 client packages failed to compose:',
      '  client bundles not found; run `pnpm run build` before launch:',
      `    - package: ${firstName}`,
      `      path: ${firstPath}`,
      `    - package: ${secondName}`,
      `      path: ${secondPath}`,
    ].join('\n'))
  })

  it('does not report other bundle read failures as missing builds', () => {
    const packageName = '@fixture/unreadable-client'
    const clientPath = writePackage(packageName)
    mkdirSync(clientPath, { recursive: true })
    let thrown: unknown
    try {
      construct([packageName])
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('client-modules: 1 client package failed to compose:')
    expect(String(thrown)).toContain('  other failures:')
    expect(String(thrown)).toContain('EISDIR')
    expect(String(thrown)).not.toContain('pnpm run build')
  })

  it('serves the source map beside a registered client bundle', async () => {
    const packageName = '@fixture/source-map'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const map = '{"version":3,"sources":["src/client/index.tsx"]}\n'
    writeFileSync(`${clientPath}.map`, map)
    const { route } = await constructWithWebServer([packageName])
    let status = 0
    let headers: Record<string, string> | undefined
    let body = ''
    const response = {
      writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
        status = nextStatus
        headers = nextHeaders
        return response
      },
      end(chunk?: Uint8Array) {
        body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
        return response
      },
    } as unknown as ServerResponse

    await route.handler({
      method: 'GET',
      url: `/plugins/${packageName}/client.js.map`,
    } as IncomingMessage, response)

    expect(status).toBe(200)
    expect(headers).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    })
    expect(body).toBe(map)
  })
})

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  assertContainedSymlinks,
  findElectronZipDirectory,
  isPathWithin,
  resolveDeployArgs,
  resolvePackagerCopyOptions,
  resolvePackagePaths,
  resolveSigningConfig,
  validateProductionImports,
  validateStagedDependencyResolution,
} from './package-macos-app.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('macOS application packaging', () => {
  test('keeps staging and products below the ignored artifact root', () => {
    const paths = resolvePackagePaths('/workspace', 'arm64')
    expect(paths).toEqual({
      artifactRoot: '/workspace/.artifacts/electron/macos',
      stageRoot: '/workspace/.artifacts/electron/macos/.stage-arm64',
      zipPath: '/workspace/.artifacts/electron/macos/DeepSeek-Harness-darwin-arm64.zip',
    })
    expect(isPathWithin('/workspace', paths.stageRoot)).toBe(true)
    expect(isPathWithin('/workspace', '/workspace-other/stage')).toBe(false)
  })

  test('uses a frozen injected hoisted deploy without the legacy deploy path', () => {
    const args = resolveDeployArgs('/workspace/stage')
    expect(args).toEqual([
      '--ignore-scripts',
      '--frozen-lockfile',
      '--config.inject-workspace-packages=true',
      '--config.node-linker=hoisted',
      '--filter', '@deepseek-ai/dsh-desktop',
      'deploy', '--prod', '/workspace/stage',
    ])
    expect(args).not.toContain('--legacy')
  })

  test('materializes validated staging links into the unpacked application', () => {
    expect(resolvePackagerCopyOptions()).toEqual({
      asar: false,
      prune: false,
      derefSymlinks: true,
      junk: false,
    })
  })

  test('uses an ad-hoc signature without release credentials', () => {
    const signing = resolveSigningConfig({})
    expect(signing.description).toBe('ad-hoc local signature')
    expect(signing.osxNotarize).toBeUndefined()
    expect(signing.osxSign).toMatchObject({
      identity: '-',
      identityValidation: false,
      continueOnError: false,
    })
    if (signing.osxSign === true) throw new Error('expected explicit ad-hoc signing options')
    expect(signing.osxSign.optionsForFile?.('/tmp/app', { platform: 'darwin' })).toEqual({
      hardenedRuntime: false,
      timestamp: 'none',
    })
  })

  test('enables Developer ID signing and keychain-profile notarization together', () => {
    expect(resolveSigningConfig({
      APPLE_SIGN_IDENTITY: 'Developer ID Application: Example (TEAMID)',
      APPLE_NOTARY_KEYCHAIN_PROFILE: 'dsh-release',
    })).toEqual({
      description: 'Developer ID signature and notarization',
      osxSign: {
        identity: 'Developer ID Application: Example (TEAMID)',
        continueOnError: false,
      },
      osxNotarize: { keychainProfile: 'dsh-release' },
    })
  })

  test('rejects notarization without a Developer ID signature', () => {
    expect(() => resolveSigningConfig({ APPLE_NOTARY_KEYCHAIN_PROFILE: 'dsh-release' }))
      .toThrow('notarization requires APPLE_SIGN_IDENTITY')
  })

  test('rejects links that leave the deployed runtime', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-macos-package-'))
    temporaryDirectories.push(parent)
    const stage = join(parent, 'stage')
    const outside = join(parent, 'outside.txt')
    await mkdir(join(stage, 'inside'), { recursive: true })
    await writeFile(join(stage, 'inside', 'target.txt'), 'inside')
    await writeFile(outside, 'outside')
    await symlink('inside/target.txt', join(stage, 'inside-link'))
    await assertContainedSymlinks(stage)
    await symlink(outside, join(stage, 'outside-link'))
    await expect(assertContainedSymlinks(stage)).rejects.toThrow('staged link escapes the application')
  })

  test('finds the exact Electron archive below a hashed cache directory', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'dsh-electron-cache-'))
    temporaryDirectories.push(cache)
    const archiveDirectory = join(cache, 'checksum')
    await mkdir(archiveDirectory)
    await writeFile(join(archiveDirectory, 'electron-v43.4.0-darwin-arm64.zip'), 'archive')
    await expect(findElectronZipDirectory([cache], '43.4.0', 'arm64')).resolves.toBe(archiveDirectory)
    await expect(findElectronZipDirectory([cache], '43.4.0', 'x64')).resolves.toBeUndefined()
  })

  test('links the packaged main and Host workspace imports with plain Node', async () => {
    const stage = await mkdtemp(join(tmpdir(), 'dsh-electron-stage-'))
    temporaryDirectories.push(stage)
    await writeFile(join(stage, 'package.json'), JSON.stringify({ type: 'module' }))
    const packages = [
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-app-boot',
      '@deepseek-ai/dsh-launch-environment',
    ]
    for (const packageName of packages) {
      const packageRoot = join(stage, 'node_modules', ...packageName.split('/'))
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: packageName,
        type: 'module',
        main: 'index.js',
      }))
      await writeFile(join(packageRoot, 'index.js'), 'export const staged = true\n')
    }
    await expect(validateProductionImports(stage)).resolves.toBeUndefined()
    await writeFile(
      join(stage, 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'index.js'),
      "import '@deepseek-ai/missing-production-peer'\n",
    )
    await expect(validateProductionImports(stage)).rejects.toThrow('failed (exit 1)')
  })

  test('rejects an unresolved dependency from the owning staged manifest', async () => {
    const stage = await mkdtemp(join(tmpdir(), 'dsh-electron-closure-'))
    temporaryDirectories.push(stage)
    const packageRoot = join(stage, 'node_modules', '@deepseek-ai', 'fixture')
    await mkdir(join(stage, 'node_modules', '.pnpm'), { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/fixture',
      dependencies: { '@deepseek-ai/missing-runtime-peer': '1.0.0' },
    }))
    await expect(validateStagedDependencyResolution(stage)).rejects.toThrow(
      '@deepseek-ai/fixture/package.json cannot resolve required dependency @deepseek-ai/missing-runtime-peer',
    )
  })
})

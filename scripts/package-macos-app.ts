/** Build, validate, sign, and archive the macOS Electron application. */

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { packager, type Options } from '@electron/packager'

const PRODUCT_NAME = 'DeepSeek Harness'
const BUNDLE_ID = 'ai.deepseek.harness.desktop'
const DESKTOP_PACKAGE = '@deepseek-ai/dsh-desktop'
const PRODUCTION_IMPORT_PACKAGES = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-launch-environment',
] as const
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

type MacArch = 'arm64' | 'x64'

interface PackagePaths {
  readonly artifactRoot: string
  readonly stageRoot: string
  readonly zipPath: string
}

interface SigningConfig {
  readonly description: string
  readonly osxSign: NonNullable<Options['osxSign']>
  readonly osxNotarize?: Options['osxNotarize']
}

interface StagedPackageManifest {
  readonly name?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
  readonly dsh?: { readonly client?: unknown }
}

/**
 * Determine whether a resolved path remains inside a required root.
 * @param parent - the trusted absolute parent directory.
 * @param candidate - the absolute path being checked.
 * @returns whether candidate is parent or one of its descendants.
 */
export function isPathWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/**
 * Resolve deterministic staging and output locations for one host architecture.
 * @param repositoryRoot - the repository root.
 * @param arch - the native macOS architecture.
 * @returns the ignored artifact paths used by the packaging run.
 */
export function resolvePackagePaths(repositoryRoot: string, arch: MacArch): PackagePaths {
  const artifactRoot = join(repositoryRoot, '.artifacts', 'electron', 'macos')
  return {
    artifactRoot,
    stageRoot: join(artifactRoot, `.stage-${arch}`),
    zipPath: join(artifactRoot, `DeepSeek-Harness-darwin-${arch}.zip`),
  }
}

/**
 * Build the isolated pnpm deploy command for the desktop production root.
 * @param stageRoot - the destination outside the workspace installation.
 * @returns arguments that materialize injected workspace packages without lifecycle scripts.
 */
export function resolveDeployArgs(stageRoot: string): string[] {
  return [
    '--ignore-scripts',
    '--frozen-lockfile',
    '--config.inject-workspace-packages=true',
    '--config.node-linker=hoisted',
    '--filter', DESKTOP_PACKAGE,
    'deploy', '--prod', stageRoot,
  ]
}

/**
 * Preserve runtime files while materializing validated staging links.
 * @returns Packager options for the relocatable application resource tree.
 */
export function resolvePackagerCopyOptions(): Pick<Options, 'asar' | 'prune' | 'derefSymlinks' | 'junk'> {
  return {
    asar: false,
    prune: false,
    derefSymlinks: true,
    junk: false,
  }
}

function requiredCredential(
  environment: NodeJS.ProcessEnv,
  name: string,
  selected: readonly string[],
): string {
  const value = environment[name]?.trim()
  if (value !== undefined && value !== '') return value
  throw new Error(`package-macos-app: ${selected.join(', ')} requires ${name}.`)
}

function resolveNotarization(environment: NodeJS.ProcessEnv): Options['osxNotarize'] | undefined {
  const profile = environment.APPLE_NOTARY_KEYCHAIN_PROFILE?.trim()
  const apiNames = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] as const
  const passwordNames = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'] as const
  const hasApi = apiNames.some(name => environment[name]?.trim())
  const hasPassword = passwordNames.some(name => environment[name]?.trim())
  const strategyCount = Number(Boolean(profile)) + Number(hasApi) + Number(hasPassword)
  if (strategyCount > 1) {
    throw new Error('package-macos-app: configure exactly one notarization credential strategy.')
  }
  if (profile !== undefined && profile !== '') return { keychainProfile: profile }
  if (hasApi) {
    const appleApiKey = requiredCredential(environment, 'APPLE_API_KEY', apiNames)
    const appleApiKeyId = requiredCredential(environment, 'APPLE_API_KEY_ID', apiNames)
    const issuer = environment.APPLE_API_ISSUER?.trim()
    return issuer === undefined || issuer === ''
      ? { appleApiKey, appleApiKeyId }
      : { appleApiKey, appleApiKeyId, appleApiIssuer: issuer }
  }
  if (hasPassword) {
    return {
      appleId: requiredCredential(environment, 'APPLE_ID', passwordNames),
      appleIdPassword: requiredCredential(environment, 'APPLE_APP_SPECIFIC_PASSWORD', passwordNames),
      teamId: requiredCredential(environment, 'APPLE_TEAM_ID', passwordNames),
    }
  }
  return undefined
}

/**
 * Select ad-hoc local signing or Developer ID signing with optional notarization.
 * @param environment - the packaging process environment.
 * @returns Packager signing options without exposing credential values in logs.
 */
export function resolveSigningConfig(environment: NodeJS.ProcessEnv): SigningConfig {
  const identity = environment.APPLE_SIGN_IDENTITY?.trim()
  const osxNotarize = resolveNotarization(environment)
  if ((identity === undefined || identity === '') && osxNotarize !== undefined) {
    throw new Error('package-macos-app: notarization requires APPLE_SIGN_IDENTITY.')
  }
  if (identity === undefined || identity === '') {
    return {
      description: 'ad-hoc local signature',
      osxSign: {
        identity: '-',
        identityValidation: false,
        optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
        continueOnError: false,
      },
    }
  }
  const signed: SigningConfig = {
    description: osxNotarize === undefined ? 'Developer ID signature' : 'Developer ID signature and notarization',
    osxSign: { identity, continueOnError: false },
    ...(osxNotarize === undefined ? {} : { osxNotarize }),
  }
  return signed
}

async function removeBinDirectories(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name === '.bin') {
      await rm(path, { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      await removeBinDirectories(path)
    }
  }
}

/**
 * Reject deploy-time links that would escape when the application moves.
 * @param stageRoot - the trusted production-deploy root.
 * @param directory - the subtree currently being inspected.
 * @returns after every symbolic link resolves inside stageRoot.
 */
async function inspectContainedSymlinks(stageRoot: string, directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      const target = await realpath(path)
      if (!isPathWithin(stageRoot, target)) {
        throw new Error(`package-macos-app: staged link escapes the application: ${path} -> ${target}`)
      }
    } else if (metadata.isDirectory()) {
      await inspectContainedSymlinks(stageRoot, path)
    }
  }
}

/**
 * Reject deploy-time links that would escape when the application moves.
 * @param stageRoot - the trusted production-deploy root.
 * @param directory - the subtree currently being inspected.
 * @returns after every symbolic link resolves inside stageRoot.
 */
export async function assertContainedSymlinks(stageRoot: string, directory = stageRoot): Promise<void> {
  await inspectContainedSymlinks(await realpath(stageRoot), directory)
}

async function findFile(directory: string, filename: string, depth: number): Promise<string | undefined> {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isFile() && entry.name === filename) return dirname(path)
      if (entry.isDirectory() && depth > 0) {
        const found = await findFile(path, filename, depth - 1)
        if (found !== undefined) return found
      }
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code !== 'ENOENT') throw error
  }
  return undefined
}

/**
 * Locate the exact official Electron archive left by dependency installation.
 * @param cacheRoots - candidate Electron cache roots.
 * @param version - the exact Electron version.
 * @param arch - the native macOS architecture.
 * @returns the containing directory, or undefined when Packager must download it.
 */
export async function findElectronZipDirectory(
  cacheRoots: readonly string[],
  version: string,
  arch: MacArch,
): Promise<string | undefined> {
  const filename = `electron-v${version}-darwin-${arch}.zip`
  for (const cacheRoot of cacheRoots) {
    const found = await findFile(cacheRoot, filename, 2)
    if (found !== undefined) return found
  }
  return undefined
}

async function requirePath(path: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new Error(`package-macos-app: required staged artifact is missing: ${path}`)
  }
}

async function requireExecutable(path: string): Promise<void> {
  await requirePath(path)
  await chmod(path, 0o755)
  await access(path, constants.X_OK)
}

async function requireNativeFile(directory: string, suffix: string): Promise<void> {
  await requirePath(directory)
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name.endsWith(suffix)) return
    }
  }
  throw new Error(`package-macos-app: ${directory} contains no ${suffix} runtime artifact.`)
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function stagedNodeModulesParents(stageRoot: string): Promise<string[]> {
  const modules = join(stageRoot, 'node_modules')
  const pnpmStore = join(modules, '.pnpm')
  const parents = [modules, join(pnpmStore, 'node_modules')]
  for (const entry of await readdir(pnpmStore, { withFileTypes: true })) {
    if (entry.isDirectory()) parents.push(join(pnpmStore, entry.name, 'node_modules'))
  }
  return parents
}

async function collectStagedPackageRoots(stageRoot: string, packageName: string): Promise<string[]> {
  const roots = new Set<string>()
  const segments = packageName.split('/')
  for (const parent of await stagedNodeModulesParents(stageRoot)) {
    const packageRoot = join(parent, ...segments)
    try {
      await access(join(packageRoot, 'package.json'))
      roots.add(await realpath(packageRoot))
    } catch (error) {
      if (!isMissingPath(error)) throw error
    }
  }
  return [...roots].sort()
}

async function requireStagedPackageRoot(stageRoot: string, packageName: string): Promise<string> {
  const [packageRoot] = await collectStagedPackageRoots(stageRoot, packageName)
  if (packageRoot === undefined) {
    throw new Error(`package-macos-app: staged runtime is missing package ${packageName}.`)
  }
  return packageRoot
}

async function collectDeepSeekPackageRoots(stageRoot: string): Promise<string[]> {
  const roots = new Set<string>()
  for (const parent of await stagedNodeModulesParents(stageRoot)) {
    const scope = join(parent, '@deepseek-ai')
    let entries
    try {
      entries = await readdir(scope, { withFileTypes: true })
    } catch (error) {
      if (isMissingPath(error)) continue
      throw error
    }
    for (const entry of entries) {
      const packageRoot = join(scope, entry.name)
      try {
        await access(join(packageRoot, 'package.json'))
        roots.add(await realpath(packageRoot))
      } catch (error) {
        if (!isMissingPath(error)) throw error
      }
    }
  }
  return [...roots].sort()
}

async function readStagedManifest(packageRoot: string): Promise<StagedPackageManifest> {
  const manifestPath = join(packageRoot, 'package.json')
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as StagedPackageManifest
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`package-macos-app: invalid staged manifest ${manifestPath}: ${error.message}`)
    }
    throw error
  }
}

async function assertDependencyResolvable(manifestPath: string, dependency: string): Promise<void> {
  const resolutionPaths = createRequire(manifestPath).resolve.paths(dependency)
  if (resolutionPaths !== null) {
    for (const parent of resolutionPaths) {
      try {
        await access(join(parent, ...dependency.split('/'), 'package.json'))
        return
      } catch (error) {
        if (!isMissingPath(error)) throw error
      }
    }
  }
  throw new Error(`package-macos-app: ${manifestPath} cannot resolve required dependency ${dependency}.`)
}

/**
 * Verify each staged DeepSeek package can locate its required dependencies.
 * @param stageRoot - the injected production deploy root.
 * @returns the number of unique DeepSeek package installations inspected.
 */
export async function validateStagedDependencyResolution(stageRoot: string): Promise<number> {
  const packageRoots = await collectDeepSeekPackageRoots(stageRoot)
  for (const packageRoot of packageRoots) {
    const manifestPath = join(packageRoot, 'package.json')
    const manifest = await readStagedManifest(packageRoot)
    const required = new Set(Object.keys(manifest.dependencies ?? {}))
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[dependency]?.optional !== true) required.add(dependency)
    }
    await Promise.all([...required].sort().map(dependency =>
      assertDependencyResolvable(manifestPath, dependency)))
  }
  return packageRoots.length
}

/**
 * Import the external workspace roots used by the packaged main and Host entries.
 * @param stageRoot - the injected production deploy root.
 * @returns after Node links each production entry and its transitive imports.
 */
export async function validateProductionImports(stageRoot: string): Promise<void> {
  const canonicalStageRoot = await realpath(stageRoot)
  const manifestPath = join(canonicalStageRoot, 'package.json')
  const source = [
    "import { createRequire } from 'node:module'",
    "import { relative, sep } from 'node:path'",
    "import { pathToFileURL } from 'node:url'",
    `const stageRoot = ${JSON.stringify(canonicalStageRoot)}`,
    `const requireFromDesktop = createRequire(${JSON.stringify(manifestPath)})`,
    `for (const packageName of ${JSON.stringify(PRODUCTION_IMPORT_PACKAGES)}) {`,
    '  const entry = requireFromDesktop.resolve(packageName)',
    '  const path = relative(stageRoot, entry)',
    "  if (path === '..' || path.startsWith(`..${sep}`)) throw new Error(`${packageName} resolved outside staging: ${entry}`)",
    '  await import(pathToFileURL(entry).href)',
    '}',
  ].join('\n')
  await run(process.execPath, ['--input-type=module', '--eval', source], stageRoot)
}

async function validateClientBundles(stageRoot: string): Promise<number> {
  let declarations = 0
  for (const packageRoot of await collectDeepSeekPackageRoots(stageRoot)) {
    const manifest = await readStagedManifest(packageRoot)
    if (manifest.dsh?.client === undefined) continue
    declarations += 1
    await requirePath(join(packageRoot, 'lib', 'client.js'))
  }
  if (declarations === 0) throw new Error('package-macos-app: staged runtime declares no Client bundles.')
  return declarations
}

async function validateStagedRuntime(stageRoot: string, arch: MacArch): Promise<number> {
  const modules = join(stageRoot, 'node_modules')
  const required = [
    join(stageRoot, 'lib', 'main.js'),
    join(stageRoot, 'lib', 'host.js'),
    join(stageRoot, 'lib', 'preload.cjs'),
    join(modules, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
    ...['code', 'minimal', 'standard', 'cordis'].map(name =>
      join(modules, '@deepseek-ai', 'dsh', 'config', 'agent-presets', name, 'agent.cordis.yml')),
  ]
  await Promise.all(required.map(path => requirePath(path)))
  const nodePty = join(await requireStagedPackageRoot(stageRoot, 'node-pty'), 'prebuilds', `darwin-${arch}`)
  await requireNativeFile(nodePty, '.node')
  await requireExecutable(join(nodePty, 'spawn-helper'))
  await requireExecutable(join(
    await requireStagedPackageRoot(stageRoot, `@vscode/ripgrep-darwin-${arch}`),
    'bin', 'rg'))
  await requireNativeFile(
    await requireStagedPackageRoot(stageRoot, `@img/sharp-darwin-${arch}`), '.node')
  await requireNativeFile(
    await requireStagedPackageRoot(stageRoot, `@img/sharp-libvips-darwin-${arch}`), '.dylib')
  await requireNativeFile(
    await requireStagedPackageRoot(stageRoot, `@koromix/koffi-darwin-${arch}`), '.node')
  await requireNativeFile(
    await requireStagedPackageRoot(stageRoot, `node-addon-require-builtin-darwin-${arch}`), '.node')
  await requirePath(join(
    await requireStagedPackageRoot(stageRoot, '@deepseek-ai/dsh-code-runtime-worker-thread'),
    'lib', 'worker.cjs'))
  await requirePath(join(
    await requireStagedPackageRoot(stageRoot, '@deepseek-ai/dsh-workflow-worker-thread'),
    'lib', 'worker.cjs'))
  const packageCount = await validateStagedDependencyResolution(stageRoot)
  await validateProductionImports(stageRoot)
  await removeBinDirectories(modules)
  await assertContainedSymlinks(stageRoot)
  const clientBundles = await validateClientBundles(stageRoot)
  console.log(`package-macos-app: validated dependency resolution for ${String(packageCount)} staged @deepseek-ai packages`)
  return clientBundles
}

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

type InstallMetadataSnapshot = ReadonlyMap<string, Buffer | undefined>

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isMissingPath(error)) return undefined
    throw error
  }
}

async function snapshotRepositoryInstallMetadata(): Promise<InstallMetadataSnapshot> {
  const paths = [
    join(root, 'pnpm-lock.yaml'),
    join(root, 'node_modules', '.modules.yaml'),
    join(root, 'node_modules', '.pnpm', 'lock.yaml'),
  ]
  return new Map(await Promise.all(paths.map(async path => [path, await readOptionalFile(path)] as const)))
}

async function assertInstallMetadataUnchanged(before: InstallMetadataSnapshot): Promise<void> {
  for (const [path, expected] of before) {
    const actual = await readOptionalFile(path)
    if (expected === undefined ? actual !== undefined : actual === undefined || !expected.equals(actual)) {
      throw new Error(`package-macos-app: pnpm deploy changed repository install metadata: ${path}`)
    }
  }
}

async function run(command: string, args: string[], cwd = root): Promise<void> {
  const printable = [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
  console.log(`package-macos-app: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', (error) => {
      reject(new Error(`package-macos-app: failed to spawn ${printable}: ${error.message}`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`package-macos-app: ${printable} failed (${signal ?? `exit ${String(code)}`}).`))
    })
  })
}

async function readElectronVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, 'apps', 'electron', 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
  }
  const version = manifest.devDependencies?.electron
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('package-macos-app: apps/electron must pin an exact Electron version.')
  }
  return version
}

async function packageMac(skipBuild: boolean): Promise<void> {
  if (process.platform !== 'darwin' || (process.arch !== 'arm64' && process.arch !== 'x64')) {
    throw new Error('package-macos-app: run on the target arm64 or x64 macOS host; cross-packaging native providers is unsupported.')
  }
  const arch: MacArch = process.arch
  const paths = resolvePackagePaths(root, arch)
  if (!isPathWithin(root, paths.stageRoot)) throw new Error('package-macos-app: staging path escaped the repository.')
  await run(process.execPath, [
    '--import', 'tsx/esm',
    join(root, 'scripts', 'verify-runtime-closure.ts'),
    '--manifest', 'apps/electron/package.json',
  ])
  if (!skipBuild) {
    await run(pnpmBin(), ['run', 'build'])
    await run(pnpmBin(), ['run', 'build:desktop'])
  }
  await rm(paths.stageRoot, { recursive: true, force: true })
  await mkdir(paths.artifactRoot, { recursive: true })
  const installMetadata = await snapshotRepositoryInstallMetadata()
  await run(pnpmBin(), resolveDeployArgs(paths.stageRoot))
  await assertInstallMetadataUnchanged(installMetadata)
  const clientBundles = await validateStagedRuntime(paths.stageRoot, arch)
  const signing = resolveSigningConfig(process.env)
  const electronVersion = await readElectronVersion()
  const explicitCache = process.env.ELECTRON_CACHE?.trim()
  const cacheRoots = [
    ...(explicitCache === undefined || explicitCache === '' ? [] : [explicitCache]),
    join(homedir(), 'Library', 'Caches', 'electron'),
    join(homedir(), '.cache', 'electron'),
  ]
  const electronZipDir = await findElectronZipDirectory(cacheRoots, electronVersion, arch)
  console.log(`package-macos-app: validated ${String(clientBundles)} Client bundles; using ${signing.description}`)
  if (electronZipDir !== undefined) console.log(`package-macos-app: reusing Electron archive from ${electronZipDir}`)
  const output = await packager({
    dir: paths.stageRoot,
    out: paths.artifactRoot,
    name: PRODUCT_NAME,
    platform: 'darwin',
    arch,
    electronVersion,
    appBundleId: BUNDLE_ID,
    appCategoryType: 'public.app-category.developer-tools',
    ...resolvePackagerCopyOptions(),
    overwrite: true,
    osxSign: signing.osxSign,
    ...(electronZipDir === undefined ? {} : { electronZipDir }),
    ...(signing.osxNotarize === undefined ? {} : { osxNotarize: signing.osxNotarize }),
  })
  const [productPath] = output
  if (productPath === undefined || output.length !== 1) {
    throw new Error(`package-macos-app: expected one product, received ${String(output.length)}.`)
  }
  const appPath = join(productPath, `${PRODUCT_NAME}.app`)
  const packagedRoot = join(appPath, 'Contents', 'Resources', 'app')
  const executable = join(appPath, 'Contents', 'MacOS', PRODUCT_NAME)
  await requirePath(join(packagedRoot, 'lib', 'main.js'))
  await requirePath(executable)
  await access(executable, constants.X_OK)
  await validateProductionImports(packagedRoot)
  await assertContainedSymlinks(packagedRoot)
  await run('plutil', ['-lint', join(appPath, 'Contents', 'Info.plist')])
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  if (signing.osxNotarize !== undefined) await run('xcrun', ['stapler', 'validate', appPath])
  await rm(paths.zipPath, { force: true })
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, paths.zipPath])
  await rm(paths.stageRoot, { recursive: true, force: true })
  console.log(`package-macos-app: application: ${appPath}`)
  console.log(`package-macos-app: archive: ${paths.zipPath}`)
}

function usage(): string {
  return [
    'Usage: pnpm package:mac [-- --skip-build]',
    '',
    '  --skip-build  reuse existing lib/ and apps/web/dist artifacts.',
  ].join('\n')
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  const values = parseArgs({
    args,
    options: {
      'skip-build': { type: 'boolean', default: false },
      'help': { type: 'boolean', default: false },
    },
    strict: true,
  }).values
  if (values.help) {
    console.log(usage())
    return
  }
  await packageMac(values['skip-build'])
}

const invoked = process.argv[1]
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

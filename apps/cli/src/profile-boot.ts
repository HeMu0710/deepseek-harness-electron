/**
 * `dsh` process adapter over `dsh-app-boot` profile composition: install Unix
 * signal and fatal-rejection handling, provide the launch environment and
 * command line before profile entries mount, and connect application exit
 * requests to bounded process shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  bootProfile,
  installFailLoud,
  prepareProfile as prepareAppProfile,
  type Profile,
  type ProfileBootResult,
} from '@deepseek-ai/dsh-app-boot'

/** Shipped agent-preset root: beside this app's own config, in both source and built layouts. */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

export { homePatchPath, PROFILE_ROOT_FILENAME } from '@deepseek-ai/dsh-app-boot'

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * Load a resolved profile for `name`: heal the shared module fallback, then
 * (re)write the empty root config. The root is always rewritten: the whole
 * composition is patch layers, and the vendored Loader's tree write-back (a
 * plugin self-disposing persists the current tree) can bake composed rows
 * into this file — which would duplicate every bundle insert on the next
 * boot. The file exists on disk only because the Loader needs a real include
 * root to anchor `baseUrl` at the profile directory (the config dump anchors
 * on the same file, so both compose over the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @returns the loaded profile.
 */
export function prepareProfile(name: string, userLayer = true): Profile {
  return prepareAppProfile({
    binName: NAME,
    profile: name,
    installAnchor: INSTALL_ANCHOR,
    userLayer,
  })
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const app: {
    boot?: ProfileBootResult
    pending?: Promise<ProfileBootResult>
    startingContext?: Context
  } = {}
  const dispose = async (): Promise<void> => {
    if (app.boot !== undefined) {
      await app.boot.dispose()
      return
    }
    await app.startingContext?.fiber.dispose()
    const boot = await app.pending
    await boot?.dispose()
  }
  const shutdown = createProcessShutdown(dispose)
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // Signals own teardown throughout the startup window, not only after boot()
  // settles: an inserted provider can publish before sibling rows finish mounting.
  // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
  // surface — the launcher does not know whether the app considered its work
  // complete; SIGINT is a user interrupt and reports 130.
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, dispose)
  const pending = bootProfile({
    binName: NAME,
    profile: options.profile,
    installAnchor: INSTALL_ANCHOR,
    patchFiles: options.patchFiles,
    shippedPresetRoot: SHIPPED_PRESET_ROOT,
    ...process.env.DSH_TELEMETRY_DISABLED === undefined
      ? {}
      : { telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED },
    shutdownSignal: signalShutdown.signal,
    prepare(hostCtx) {
      app.startingContext = hostCtx
      // Before any config-tree entry mounts, so plugins resolve all launch-time
      // environment values from the same immutable provenance snapshot.
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
      // The command line and bounded exit request are launcher facts available
      // to every app plugin that injects the argument snapshot.
      provideCmdline(hostCtx, {
        args: options.args,
        exit: code => void shutdown.shutdown(code),
      })
    },
  })
  app.pending = pending
  const boot = await pending
  app.boot = boot
  return { ctx: boot.ctx, shutdown }
}

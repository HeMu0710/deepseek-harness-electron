/** Runtime asset anchors that remain valid in workspace and installed layouts. */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * Resolve the CLI-owned Agent Presets from the installed CLI manifest.
 * @param resolveManifest - package resolver override for installed-layout tests.
 * @returns absolute Agent Preset root.
 */
export function resolveShippedPresetRoot(
  resolveManifest: () => string = () => require.resolve('@deepseek-ai/dsh/package.json'),
): string {
  return join(dirname(resolveManifest()), 'config', 'agent-presets')
}

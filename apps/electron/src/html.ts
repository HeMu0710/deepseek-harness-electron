/** Desktop index rendering under a nonce-bound response-header content security policy. */

import { injectBootManifest } from '@deepseek-ai/dsh-client-modules'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'

/**
 * Build the desktop shell CSP, optionally admitting one generated boot-script nonce.
 * @param nonce - base64url nonce used by the injected boot manifest.
 * @returns the CSP response-header value.
 */
export function desktopContentSecurityPolicy(nonce?: string): string {
  return [
    "default-src 'self'",
    `script-src 'self'${nonce === undefined ? '' : ` 'nonce-${nonce}'`}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/**
 * Inject the Host graph and preconfigure Zod for strict-CSP validation.
 * @param template - built Web shell index.
 * @param graph - Host-composed client bundle graph.
 * @param nonce - per-response base64url nonce.
 * @returns index HTML whose nonce scripts precede the shell bundle.
 */
export function renderDesktopIndex(template: string, graph: WebBootGraph, nonce: string): string {
  const bootstrapped = injectBootManifest(template, graph, nonce)
  const zodJitlessScript = `<script nonce="${nonce}">globalThis.__zod_globalConfig ??= {};globalThis.__zod_globalConfig.jitless = true</script>`
  const head = bootstrapped.indexOf('<head>')
  if (head !== -1) {
    return `${bootstrapped.slice(0, head + 6)}${zodJitlessScript}${bootstrapped.slice(head + 6)}`
  }
  return `${zodJitlessScript}${bootstrapped}`
}

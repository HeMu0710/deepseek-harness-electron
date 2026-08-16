import { describe, expect, it } from 'vitest'
import { desktopContentSecurityPolicy, renderDesktopIndex } from '../src/html.ts'

describe('desktop index rendering', () => {
  it('binds the boot manifest to the exact CSP nonce before the shell runs', () => {
    const nonce = 'desktop_nonce_1234567890'
    const html = renderDesktopIndex(
      '<html><head><script type="module" src="/assets/app.js"></script></head></html>',
      { rev: 'one', entries: [] },
      nonce,
    )
    const csp = desktopContentSecurityPolicy(nonce)

    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}'`)
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(html).not.toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain(
      `<script nonce="${nonce}">globalThis.__zod_globalConfig ??= {};globalThis.__zod_globalConfig.jitless = true</script>`,
    )
    expect(html).toContain(`<script nonce="${nonce}">window.__DSH_BOOT__ = {"rev":"one","entries":[]}</script>`)
    expect(html.indexOf('__zod_globalConfig')).toBeLessThan(html.indexOf('window.__DSH_BOOT__'))
    expect(html.indexOf('window.__DSH_BOOT__')).toBeLessThan(html.indexOf('/assets/app.js'))
  })
})

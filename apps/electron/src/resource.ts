/** Response headers for shell and client resources served by the desktop scheme. */

import { extname } from 'node:path'
import { desktopContentSecurityPolicy } from './html.ts'

/**
 * Return the exact media type for one built desktop resource.
 * @param pathname - application resource pathname.
 * @returns a media type suitable for strict `nosniff` responses.
 */
function desktopMimeType(pathname: string): string {
  switch (extname(pathname).toLowerCase()) {
    case '.css': return 'text/css; charset=utf-8'
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.json':
    case '.map': return 'application/json; charset=utf-8'
    case '.webmanifest': return 'application/manifest+json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    case '.woff': return 'font/woff'
    case '.woff2': return 'font/woff2'
    case '.ttf': return 'font/ttf'
    default: return 'application/octet-stream'
  }
}

/**
 * Build the common security and content headers for one desktop resource.
 * @param pathname - application resource pathname.
 * @param csp - response-specific Content Security Policy.
 * @returns response-header fields for the private application origin.
 */
export function desktopResourceHeaders(
  pathname: string,
  csp: string = desktopContentSecurityPolicy(),
): HeadersInit {
  return {
    'content-type': desktopMimeType(pathname),
    'content-security-policy': csp,
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
  }
}

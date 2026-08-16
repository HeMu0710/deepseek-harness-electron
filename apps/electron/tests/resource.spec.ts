import { describe, expect, it } from 'vitest'
import { desktopResourceHeaders } from '../src/resource.ts'

describe('desktop static resource headers', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['client.js', 'text/javascript; charset=utf-8'],
    ['client.js.map', 'application/json; charset=utf-8'],
    ['client.css', 'text/css; charset=utf-8'],
    ['favicon.svg', 'image/svg+xml'],
    ['font.woff', 'font/woff'],
    ['font.woff2', 'font/woff2'],
    ['font.ttf', 'font/ttf'],
  ])('serves %s with its declared type while retaining nosniff', (pathname, contentType) => {
    const headers = new Headers(desktopResourceHeaders(pathname))

    expect(headers.get('content-type')).toBe(contentType)
    expect(headers.get('x-content-type-options')).toBe('nosniff')
  })
})

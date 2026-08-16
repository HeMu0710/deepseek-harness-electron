import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveShippedPresetRoot } from '../src/runtime-paths.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('desktop installed runtime paths', () => {
  it('anchors shipped presets at the sibling CLI package instead of checkout layout', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-desktop-installed-'))
    const cliRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    const presets = join(cliRoot, 'config', 'agent-presets')
    await mkdir(join(presets, 'standard'), { recursive: true })

    expect(resolveShippedPresetRoot(() => join(cliRoot, 'package.json'))).toBe(presets)
    await expect(readdir(presets)).resolves.toEqual(['standard'])
  })
})

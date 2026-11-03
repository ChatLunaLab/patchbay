import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { patchFileName } from './manifest.ts'
import { applyPatchText } from './patch.ts'
import { readPackageJson, readState, STATE_DIR } from './sync.ts'

/** Each patched package keeps the patch it carries, so a changed patch can be undone before the new one. */
const MARKER = '.patchbay.patch'

/** Real package directories under a `node_modules`, nested ones included; symlinks are not followed. */
function* packages(modules: string): Generator<string> {
  if (!existsSync(modules)) return
  for (const item of readdirSync(modules, { withFileTypes: true })) {
    if (!item.isDirectory() || item.name.startsWith('.')) continue
    const path = join(modules, item.name)
    if (item.name.startsWith('@')) {
      yield* packages(path)
      continue
    }
    if (existsSync(join(path, 'package.json'))) yield path
    yield* packages(join(path, 'node_modules'))
  }
}

/**
 * Patch the matching packages in `<dir>/node_modules` in place, for npm, which has no patch protocol.
 * Packages already carrying the current patch are skipped. Returns the patched paths.
 */
export function apply(dir: string): string[] {
  const manifest = readState(dir)
  if (!manifest) throw new Error(`no ${STATE_DIR}/patchbay.json in ${dir}; run patchbay sync first`)
  const entries = new Map(manifest.patches.map((entry) => [`${entry.name}@${entry.version}`, entry]))
  const applied: string[] = []
  for (const path of packages(join(dir, 'node_modules'))) {
    const { name, version } = readPackageJson(path)
    const entry = entries.get(`${name}@${version}`)
    if (!entry) continue
    const text = readFileSync(join(dir, STATE_DIR, patchFileName(entry)), 'utf8')
    const marker = join(path, MARKER)
    const carried = existsSync(marker) ? readFileSync(marker, 'utf8') : undefined
    if (carried === text) continue
    try {
      if (carried !== undefined) {
        applyPatchText(path, carried, { reverse: true })
        rmSync(marker)
      }
      applyPatchText(path, text)
    } catch (error) {
      throw new Error(`${name}@${version} at ${relative(dir, path)}: ${String(error)}`, { cause: error })
    }
    writeFileSync(marker, text)
    applied.push(relative(dir, path))
  }
  return applied
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyPatch, parsePatch, reversePatch } from 'diff'

/** Strip the `a/` / `b/` prefix git diffs put on paths; `/dev/null` stays as is. */
function stripPrefix(path: string | undefined): string | undefined {
  if (path === undefined || path === '/dev/null') return path
  return path.replace(/^[ab]\//, '')
}

/**
 * Apply a git-style unified diff to a package directory, or undo it with `reverse`. Every file is
 * checked before any is written, so a patch that does not fit leaves the directory untouched.
 */
export function applyPatchText(dir: string, text: string, { reverse = false } = {}): void {
  const parsed = parsePatch(text)
  const writes: { path: string; content: string | undefined }[] = []
  for (const file of reverse ? reversePatch(parsed) : parsed) {
    const from = stripPrefix(file.oldFileName)
    const to = stripPrefix(file.newFileName)
    const target = to === '/dev/null' ? from : to
    if (target === undefined) continue
    const path = join(dir, target)
    if (to === '/dev/null') {
      writes.push({ path, content: undefined })
      continue
    }
    const original = from === '/dev/null' ? '' : readFileSync(join(dir, from ?? target), 'utf8')
    const result = applyPatch(original, file)
    if (result === false) throw new Error(`patch does not apply to ${target}`)
    writes.push({ path, content: result })
  }
  for (const { path, content } of writes) {
    if (content === undefined) {
      rmSync(path, { force: true })
      continue
    }
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

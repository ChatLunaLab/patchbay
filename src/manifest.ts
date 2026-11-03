import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface PatchEntry {
  /** The package's own `package.json` name. */
  name: string
  /** The exact upstream version the patch applies to. */
  version: string
  description: string
  /** Issues the patch fixes, as `owner/repo#n`. */
  fixes?: string[]
}

export interface Manifest {
  patches: PatchEntry[]
  /** Dependency names installed as another patched package, e.g. `koishi` → `@koishijs/core`. */
  aliases: Record<string, string>
}

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(new URL('../patchbay.json', import.meta.url), 'utf8'))
}

/** `@satorijs/core` + `4.6.1` → `@satorijs+core@4.6.1.patch`, the file name under `patches/`. */
export function patchFileName(entry: Pick<PatchEntry, 'name' | 'version'>): string {
  return `${entry.name.replace('/', '+')}@${entry.version}.patch`
}

export function patchPath(entry: Pick<PatchEntry, 'name' | 'version'>): string {
  return fileURLToPath(new URL(`../patches/${patchFileName(entry)}`, import.meta.url))
}

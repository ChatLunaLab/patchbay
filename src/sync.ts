import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document, parseDocument } from 'yaml'
import { loadManifest, patchFileName, patchPath, type Manifest, type PatchEntry } from './manifest.ts'

export type PackageManager = 'yarn' | 'pnpm' | 'npm'

/** Project directory that holds the synced patch files and the manifest they came from. */
export const STATE_DIR = '.patchbay'

export interface PackageJson {
  name?: string
  version?: string
  packageManager?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  resolutions?: Record<string, string>
  overrides?: Record<string, unknown>
}

export interface SyncOptions {
  /** Skip detection and write for this package manager. */
  pm?: PackageManager
}

export function isPackageManager(value: unknown): value is PackageManager {
  return value === 'yarn' || value === 'pnpm' || value === 'npm'
}

export function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

function editPackageJson(dir: string, edit: (pkg: PackageJson) => void): void {
  const path = join(dir, 'package.json')
  const text = readFileSync(path, 'utf8')
  const pkg: PackageJson = JSON.parse(text)
  edit(pkg)
  writeFileSync(path, JSON.stringify(pkg, null, /^[ \t]+/m.exec(text)?.[0] ?? 2) + '\n')
}

function checkVersion(pm: string, major: number): PackageManager {
  if (pm === 'yarn' && major < 2) throw new Error('Yarn 1 has no patch support; use Yarn 2+, pnpm 10+ or npm')
  if (pm === 'pnpm' && major < 10) throw new Error('pnpm reads patches from pnpm-workspace.yaml only since 10; upgrade pnpm')
  if (!isPackageManager(pm)) throw new Error(`unknown package manager ${pm}`)
  return pm
}

/** The project's package manager: `packageManager`, then lockfiles, then the running one, then npm. */
export function detect(dir: string): PackageManager {
  const declared = /^(yarn|pnpm|npm)@(\d+)/.exec(readPackageJson(dir).packageManager ?? '')
  if (declared) return checkVersion(declared[1]!, Number(declared[2]))
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, '.yarnrc.yml'))) return 'yarn'
  const yarnLock = join(dir, 'yarn.lock')
  if (existsSync(yarnLock)) return checkVersion('yarn', readFileSync(yarnLock, 'utf8').includes('__metadata:') ? 2 : 1)
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm'
  const agent = /^(yarn|pnpm|npm)\/(\d+)/.exec(process.env['npm_config_user_agent'] ?? '')
  if (agent) return checkVersion(agent[1]!, Number(agent[2]))
  return 'npm'
}

function find(manifest: Manifest, name: string): PatchEntry {
  const entry = manifest.patches.find((item) => item.name === name)
  if (!entry) throw new Error(`alias target ${name} is not in patchbay.json`)
  return entry
}

/** Every top-level dependency name a manifest pins: patched packages plus their aliases. */
function pinned(manifest: Manifest): Map<string, PatchEntry> {
  return new Map([
    ...manifest.patches.map((entry): [string, PatchEntry] => [entry.name, entry]),
    ...Object.entries(manifest.aliases).map(([alias, name]): [string, PatchEntry] => [alias, find(manifest, name)])
  ])
}

function npmSpec(name: string, entry: PatchEntry): string {
  return name === entry.name ? entry.version : `npm:${entry.name}@${entry.version}`
}

function writeYarn(dir: string, manifest: Manifest, previous: Manifest | undefined): void {
  editPackageJson(dir, (pkg) => {
    const resolutions = { ...pkg.resolutions }
    for (const name of previous ? pinned(previous).keys() : []) delete resolutions[name]
    for (const [name, entry] of pinned(manifest)) {
      resolutions[name] = `patch:${entry.name}@npm%3A${entry.version}#~/${STATE_DIR}/${patchFileName(entry)}`
    }
    pkg.resolutions = resolutions
  })
}

function writePnpm(dir: string, manifest: Manifest, previous: Manifest | undefined): void {
  const path = join(dir, 'pnpm-workspace.yaml')
  const doc = existsSync(path) ? parseDocument(readFileSync(path, 'utf8')) : new Document({})
  for (const [name, entry] of previous ? pinned(previous) : []) {
    doc.deleteIn(['overrides', name])
    doc.deleteIn(['patchedDependencies', `${entry.name}@${entry.version}`])
  }
  for (const [name, entry] of pinned(manifest)) doc.setIn(['overrides', name], npmSpec(name, entry))
  for (const entry of manifest.patches) {
    doc.setIn(['patchedDependencies', `${entry.name}@${entry.version}`], `${STATE_DIR}/${patchFileName(entry)}`)
  }
  // The manifest pins every patch it ships; a project uses only some of them.
  doc.set('allowUnusedPatches', true)
  writeFileSync(path, doc.toString())
}

function writeNpm(dir: string, manifest: Manifest, previous: Manifest | undefined): void {
  editPackageJson(dir, (pkg) => {
    const overrides = { ...pkg.overrides }
    for (const name of previous ? pinned(previous).keys() : []) delete overrides[name]
    const specs = pinned(manifest)
    for (const [name, entry] of specs) overrides[name] = npmSpec(name, entry)
    pkg.overrides = overrides
    // npm rejects an override that differs from a direct dependency's own spec (EOVERRIDE).
    for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
      for (const name of Object.keys(deps ?? {})) {
        const entry = specs.get(name)
        if (deps && entry) deps[name] = npmSpec(name, entry)
      }
    }
    const postinstall = pkg.scripts?.['postinstall']
    if (postinstall?.includes('patchbay apply')) return
    pkg.scripts = { ...pkg.scripts, postinstall: postinstall ? `${postinstall} && patchbay apply` : 'patchbay apply' }
  })
}

export function readState(dir: string): Manifest | undefined {
  const path = join(dir, STATE_DIR, 'patchbay.json')
  if (!existsSync(path)) return
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Copy the patches into `<dir>/.patchbay` and point the project's package manager at them: yarn
 * `resolutions`, pnpm `overrides` + `patchedDependencies`, or npm `overrides` + a `patchbay apply`
 * postinstall. Entries a previous sync wrote are replaced, so upgrading patchbay drops stale pins.
 */
export function sync(dir: string, options: SyncOptions = {}): PackageManager {
  const pm = options.pm ?? detect(dir)
  const manifest = loadManifest()
  const previous = readState(dir)
  const state = join(dir, STATE_DIR)
  rmSync(state, { recursive: true, force: true })
  mkdirSync(state)
  for (const entry of manifest.patches) copyFileSync(patchPath(entry), join(state, patchFileName(entry)))
  writeFileSync(join(state, 'patchbay.json'), JSON.stringify(manifest, null, 2) + '\n')
  if (pm === 'yarn') writeYarn(dir, manifest, previous)
  else if (pm === 'pnpm') writePnpm(dir, manifest, previous)
  else writeNpm(dir, manifest, previous)
  return pm
}

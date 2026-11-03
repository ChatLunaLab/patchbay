// Maintainer workflow: `edit` unpacks a package's upstream tarball into .work/<pkg>/{a,b} with the
// current patch applied to b; `commit` turns b back into patches/<pkg>.patch. `import` seeds a patch
// from an existing file, `verify` checks every patch still applies to its upstream tarball, and
// `normalize` re-derives every patch from upstream, which drops stray files.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadManifest, patchFileName, patchPath, ROOT, type PatchEntry } from '../src/manifest.ts'
import { applyPatchText } from '../src/patch.ts'

const WORK = join(ROOT, '.work')

function workDir(entry: PatchEntry): string {
  return join(WORK, patchFileName(entry).replace(/\.patch$/, ''))
}

function unpack(entry: PatchEntry, into: string): void {
  const tarballs = join(WORK, 'tarballs')
  mkdirSync(tarballs, { recursive: true })
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', `${entry.name}@${entry.version}`, '--json', '--pack-destination', tarballs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    })
  )
  rmSync(into, { recursive: true, force: true })
  mkdirSync(into, { recursive: true })
  execFileSync('tar', ['-xzf', join(tarballs, packed.filename), '-C', into, '--strip-components=1'])
}

function removeStrays(dir: string): void {
  for (const item of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (item.isFile() && /\.(orig|rej)$/.test(item.name)) rmSync(join(item.parentPath, item.name))
  }
}

function edit(entry: PatchEntry, source = patchPath(entry)): string {
  const dir = workDir(entry)
  unpack(entry, join(dir, 'a'))
  unpack(entry, join(dir, 'b'))
  if (existsSync(source)) applyPatchText(join(dir, 'b'), readFileSync(source, 'utf8'))
  return dir
}

function commit(entry: PatchEntry): void {
  const dir = workDir(entry)
  removeStrays(join(dir, 'b'))
  const diff = spawnSync('git', ['diff', '--no-index', '--no-prefix', '--no-color', '--', 'a', 'b'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  if (diff.status !== 0 && diff.status !== 1) throw new Error(diff.stderr)
  if (diff.stdout === '') throw new Error(`${entry.name}@${entry.version}: no changes`)
  writeFileSync(patchPath(entry), diff.stdout)
  console.log(`wrote patches/${patchFileName(entry)}`)
}

function find(name: string): PatchEntry {
  const entry = loadManifest().patches.find((item) => item.name === name)
  if (!entry) throw new Error(`${name} is not in patchbay.json`)
  return entry
}

const [command, name, source] = process.argv.slice(2)
if (command === 'edit' && name) console.log(`edit ${edit(find(name))}/b, then run: yarn refresh commit ${name}`)
else if (command === 'commit' && name) commit(find(name))
else if (command === 'import' && name && source) {
  const entry = find(name)
  copyFileSync(source, patchPath(entry))
  edit(entry)
  commit(entry)
} else if (command === 'verify') {
  for (const entry of loadManifest().patches) {
    edit(entry)
    console.log(`ok ${entry.name}@${entry.version}`)
  }
} else if (command === 'normalize') {
  for (const entry of loadManifest().patches) {
    edit(entry)
    commit(entry)
  }
} else {
  console.error('usage: yarn refresh edit|commit <name> | import <name> <file> | verify | normalize')
  process.exit(1)
}
